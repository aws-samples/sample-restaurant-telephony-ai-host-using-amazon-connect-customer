import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  ChimeSipMediaApp,
  ChimeSipRule,
  ChimeVoiceConnector,
  NotificationTargetType,
  Protocol,
  TriggerType,
} from 'cdk-amazon-chime-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * {prefix}-IngressStack — Public Switched Telephone Network (PSTN) ingress
 * without the phone number.
 *
 * r6 simplification (Task 10.7):
 *
 *   The SMA (SIP Media Application) Lambda is no longer the one that calls
 *   the Bedrock AgentCore Runtime — the SIP gateway is.  The call flow becomes:
 *
 *       PSTN caller
 *         → Chime phone number (provisioned by IngressNumberStack)
 *         → Chime SIP Rule → Chime SMA
 *         → SMA Lambda returns `CallAndBridge` to the VC
 *         → Chime control plane originates a B-leg from the Voice Connector
 *         → VC consults its ORIGINATION ROUTES
 *         → VC forwards the SIP INVITE via TCP/5060 to the internal NLB
 *           provisioned by SipGatewayStack
 *         → NLB sends to the SIP gateway on Fargate
 *         → SIP gateway opens a SigV4-signed WebSocket to AgentCore Runtime
 *
 *   The IAM and IngressStack surface area shrinks meaningfully:
 *     - AGENT_RUNTIME_ARN + PlaybackBucketName CfnParameters REMOVED.
 *     - bedrock-agentcore:InvokeAgentRuntime grant REMOVED.
 *     - Kinesis Video Streams (KVS) stream discovery grants REMOVED.
 *     - Chime SDK Voice `GetVoiceConnector` grant REMOVED.
 *     - SipGatewayNlbDnsName CfnParameter ADDED — used as the VC
 *       origination-route host.
 *     - VC `streaming` config DISABLED — r5 used it to publish per-leg
 *       KVS streams for the agent to read; in r6 the agent sees raw
 *       Real-time Transport Protocol (RTP) through the SIP gateway, so the
 *       KVS path is dead weight.  Operators can flip this on later if
 *       call recording / compliance becomes a requirement (no code
 *       changes needed downstream — streaming is additive).
 *
 * What stays from r5:
 *     - The VC itself (security posture, SIP/TLS optionality, future
 *       recording hook — see working-agreements analysis in README).
 *     - The SMA Lambda + Chime SIP Rule wiring (`ToPhoneNumber` →
 *       targets the SMA).
 *     - The SSM parameter + read grant pattern for the VC ARN (the
 *       handler still reads the VC ARN at warm-up so a VC replacement
 *       is a parameter update rather than a Lambda redeploy).
 *
 * CfnParameters (r6):
 *   - DeploymentPrefix        — regex-validated locally, duplicated per stack.
 *   - SipGatewayNlbDnsName    — from `cdk-outputs/tel-sip-gateway.json`;
 *                               becomes the VC origination-route `host`.
 *   - PhoneNumberE164         — from `cdk-outputs/tel-ingress-number.json`;
 *                               drives the SipRule `TriggerValue`.
 *
 * CfnOutputs (WITHOUT `exportName`, per P5):
 *   - SipMediaApplicationId — observability only.
 *   - VoiceConnectorId      — observability only.
 *
 * API deviations from the task prompt, discovered by reading the installed
 * `cdk-amazon-chime-resources@^3` .d.ts files:
 *   - The SMA construct class is `ChimeSipMediaApp` (not
 *     `ChimeSipMediaApplication`) and exposes `sipMediaAppId`.
 *   - `ChimeSipMediaApp` takes `endpoint: string` (Lambda function ARN),
 *     not `endpoints: [...]`.
 *   - `Streaming.notificationTargets` is required (not optional) — we pass
 *     an empty array even when `enabled: false`.
 *   - Origination `host` validator skips its FQDN regex when the host
 *     string contains the literal `'Token'` (which is how CFN tokens are
 *     stringified at synth time) — so passing the NLB DNS name as a
 *     CfnParameter is accepted.
 */
export class IngressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters (three, r6-trimmed) ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    const sipGatewayNlbDnsName = new cdk.CfnParameter(
      this,
      'SipGatewayNlbDnsName',
      {
        type: 'String',
        minLength: 1,
        description:
          'Internal NLB DNS name from tel-sip-gateway (threaded from cdk-outputs/tel-sip-gateway.json). Becomes the Voice Connector origination-route host.',
      },
    );

    const phoneNumberE164Param = new cdk.CfnParameter(this, 'PhoneNumberE164', {
      type: 'String',
      // E.164: leading + then 1-15 digits, first digit non-zero.
      allowedPattern: '^\\+[1-9]\\d{1,14}$',
      constraintDescription:
        'must be a valid E.164 phone number (e.g. +18334228167)',
      description:
        'E.164 phone number from IngressNumberStack (threaded from cdk-outputs/tel-ingress-number.json). Drives the SipRule TriggerValue.',
    });
    const phoneNumberE164 = phoneNumberE164Param.valueAsString;

    // ───── AgentCore Runtime warmup parameters (added in the pre-warm refactor) ─────
    //
    // The SMA Lambda now pre-warms the AgentCore microVM by issuing a
    // SigV4-signed POST to the Runtime's /invocations endpoint with a
    // deterministic session id derived from the caller's E.164. The
    // session id is then ridden forward on the CallAndBridge action via
    // a `SipHeaders.X-Session-Id` SIP header so the bridge attaches to
    // the same warm microVM. See:
    //   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html
    //
    // Both parameters are threaded in by scripts/deploy-all.sh from
    // cdk-outputs/tel-agent-runtime.json. Empty values are tolerated
    // by the Lambda — it logs `warmup_skipped_no_runtime_arn` and falls
    // through to the legacy CallAndBridge-without-warmup flow.
    const agentRuntimeArnParam = new cdk.CfnParameter(this, 'AgentRuntimeArn', {
      type: 'String',
      default: '',
      description:
        'AgentCore Runtime ARN. SMA Lambda calls bedrock-agentcore:InvokeAgentRuntime against this ARN to pre-warm the microVM.',
    });
    const customerIdPepperParameterArnParam = new cdk.CfnParameter(
      this,
      'CustomerIdPepperParameterArn',
      {
        type: 'String',
        default: '',
        description:
          'SSM SecureString parameter ARN for the customer-id pepper. SMA Lambda reads it once at cold-start to derive the session id. Same pepper the agent reads server-side.',
      },
    );
    const agentVoiceIdParam = new cdk.CfnParameter(this, 'AgentVoiceId', {
      type: 'String',
      default: 'tiffany',
      allowedValues: ['matthew', 'tiffany', 'amy'],
      description:
        'Nova Sonic voice id passed in the warmup body. Must match the value the bridge passes on its wss query param.',
    });

    // ───────────── SMA Lambda ─────────────
    // Explicit log group with 1-month retention so it can be deleted on
    // stack teardown (NFR13 default: delete ephemeral logs).
    const smaLogGroup = new logs.LogGroup(this, 'SmaHandlerLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-sma-handler', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const smaLambdaRole = new iam.Role(this, 'SmaLambdaRole', {
      roleName: cdk.Fn.sub('${P}-sma-lambda-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Role for the {prefix}-sma-handler Lambda. r6-trimmed: no more Amazon Kinesis Video Streams grants, no more bedrock-agentcore:InvokeAgentRuntime IAM action - the SMA only needs Amazon CloudWatch Logs write + AWS Systems Manager parameter read.',
    });

    // Sid BasicExec — CloudWatch Logs put/create, scoped to this Lambda's
    // log group (design §11.2). We narrow the managed policy pattern to
    // explicit least-privilege statements instead of attaching
    // AWSLambdaBasicExecutionRole, because NFR12 prefers per-statement
    // justification over managed wildcards.
    smaLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BasicExec',
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          smaLogGroup.logGroupArn,
          cdk.Fn.sub('${Arn}:*', { Arn: smaLogGroup.logGroupArn }),
        ],
      }),
    );
    smaLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BasicExecCreateGroup',
        actions: ['logs:CreateLogGroup'],
        resources: [
          cdk.Fn.sub('arn:aws:logs:${R}:${A}:*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // (r6-removed)  The following grants lived in r5 and are NOT added in r6:
    //   - InvokeRuntime        (bedrock-agentcore:InvokeAgentRuntime)
    //   - GetVoiceConnector    (chime-sdk-voice:GetVoiceConnector)
    //   - ListKvsStreams       (kinesisvideo:ListStreams)
    //   - DescribeKvsStreams   (kinesisvideo:DescribeStream on ChimeVoiceConnector-*)
    // The SSM read grant for the VC ARN parameter is added AFTER the
    // parameter is declared below.

    const smaFn = new NodejsFunction(this, 'SmaHandlerFn', {
      functionName: cdk.Fn.sub('${P}-sma-handler', { P: prefix }),
      entry: path.join(__dirname, '..', 'lambda', 'sma-handler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      role: smaLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: smaLogGroup,
      bundling: {
        format: OutputFormat.CJS,
        target: 'node24',
        // minify: false so the deployed Lambda's index.js stays
        // human-readable for hot-edits in the AWS Lambda console
        // (working agreement: legibility for live debugging is more
        // valuable than the ~30 KB the bundle saves on minification).
        minify: false,
        sourceMap: false,
        // `@aws-sdk/*` is provided by the Node 24 Lambda managed runtime.
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        DEPLOYMENT_PREFIX: prefix,
        LOG_LEVEL: 'INFO',
        // Diagnostic flag: when 'true', the SMA handler logs the full
        // raw Chime event payload on every invocation. Used to inspect
        // SIP headers and parameters Chime forwards (e.g. for store /
        // location routing). Disable in production by setting to
        // 'false' once the routing investigation is complete.
        LOG_RAW_EVENT: 'true',
        // AgentCore Runtime warmup config. Empty strings are tolerated
        // by the Lambda — see the warmup-skipped logging paths.
        AGENT_RUNTIME_ARN: agentRuntimeArnParam.valueAsString,
        AGENT_VOICE_ID: agentVoiceIdParam.valueAsString,
        // VOICE_CONNECTOR_ARN_PARAM and CUSTOMER_ID_PEPPER_PARAMETER_NAME
        // get added below, once their underlying SSM resources / grants
        // are wired.
      },
    });

    // ───────────── Chime Voice Connector (r6: origination-first) ─────────────
    //
    // The VC is the SIP hop between Chime's control plane and our
    // SIP gateway cluster.  r6 pivots its role entirely:
    //
    //   r5: VC was the KVS STREAMING source.  The SMA bridged to this VC
    //       and the `streaming` block fired per-leg KVS streams for the
    //       agent to consume.
    //
    //   r6: VC is the SIP ORIGINATION source.  The SMA bridges to this
    //       VC and the VC's origination routes forward the SIP INVITE
    //       over TCP/5060 to the internal NLB fronting the SIP gateway.
    //       `streaming.enabled` is FALSE — we no longer read audio via
    //       KVS; the SIP gateway gets raw RTP through the NLB.
    //
    // The `streaming` block is still declared (with `enabled: false`) so
    // operators can flip it on later without altering the stack shape —
    // useful when call recording / compliance becomes a requirement.
    //
    // `origination.host` = `sipGatewayNlbDnsName` (CFN token).  The
    // cdk-amazon-chime-resources validator skips its FQDN regex check
    // when the host string contains `'Token'`, so token values pass.
    //
    // `origination.protocol` = TCP.  We use TCP (not UDP) because:
    //   - NLB's SIP listener is TCP/5060 (TCP is NLB's preferred
    //     transport for long-lived SIP connections).
    //   - TCP is the prerequisite for future VC encryption (TLS).
    //     Enabling `encryption: true` later requires all origination
    //     routes to be TCP; choosing TCP now avoids a later migration.
    //
    // `priority: 1, weight: 5` — the single origination route; priority
    // 1 is the highest, weight 5 is a neutral default (meaningless with
    // a single route but required by the schema).
    const voiceConnector = new ChimeVoiceConnector(this, 'VoiceConnector', {
      name: cdk.Fn.sub('${P}-vc', { P: prefix }),
      region: cdk.Aws.REGION,
      encryption: false, // flip to true + keep TCP origination for SIP/TLS
      origination: [
        {
          host: sipGatewayNlbDnsName.valueAsString,
          port: 5060,
          protocol: Protocol.TCP,
          priority: 1,
          weight: 5,
        },
      ],
      streaming: {
        enabled: false,
        dataRetention: 0,
        notificationTargets: [] as NotificationTargetType[],
      },
      // No `termination` block — we are inbound-only (no outbound dialing
      // from the VC).  The VC receives B-legs from Chime SMA's
      // CallAndBridge and forwards via origination.
    });

    // Build the Voice Connector ARN.  The `cdk-amazon-chime-resources`
    // construct exposes only `voiceConnectorId`, not an ARN, so we build
    // the standard shape manually per
    // https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonchimesdkvoice.html:
    //   arn:aws:chime:<region>:<account>:vc/<voiceConnectorId>
    // Note: the partition segment is `chime`, NOT `chime-sdk-voice`, even
    // though the service is the Chime SDK Voice API — Chime's IAM uses the
    // legacy `chime` prefix.
    const voiceConnectorArn = cdk.Fn.sub(
      'arn:aws:chime:${R}:${A}:vc/${VcId}',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        VcId: voiceConnector.voiceConnectorId,
      },
    );

    // Publish the VC ARN to SSM Parameter Store instead of baking it into
    // the SMA Lambda's environment variable.  Rationale:
    //   - No stack drift if the VC ever gets replaced (SSM param update
    //     is decoupled from the Lambda function version).
    //   - The Lambda reads the value at container warm-up (not cold-start
    //     per invocation), so there is no meaningful latency impact.
    //   - Gives us a single mutable knob if we later want to switch between
    //     VCs without redeploying the Lambda.
    const vcArnParam = new ssm.StringParameter(this, 'VoiceConnectorArnParameter', {
      parameterName: cdk.Fn.sub('/${P}/voice-connector-arn', { P: prefix }),
      // `simpleName: false` tells CDK the name contains '/' separators
      // (required because the parameterName is a CFN token with unresolved
      // `${DeploymentPrefix}` at synth time; CDK cannot introspect it).
      simpleName: false,
      stringValue: voiceConnectorArn,
      description:
        'Voice Connector ARN for the SMA Lambda to target in its CallAndBridge actions. Mutable — updating this parameter changes the bridge target without redeploying the Lambda.',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Wire the SMA Lambda to read the VC ARN at warm-up.
    smaFn.addEnvironment('VOICE_CONNECTOR_ARN_PARAM', vcArnParam.parameterName);
    vcArnParam.grantRead(smaFn);

    // ───── AgentCore Runtime warmup IAM + env wiring ─────
    //
    // Two grants needed for the SMA Lambda to pre-warm the AgentCore
    // microVM:
    //   1. bedrock-agentcore:InvokeAgentRuntime against the runtime ARN
    //      (POST /invocations is the data-plane invocation API).
    //   2. ssm:GetParameter + kms:Decrypt against the customer-id pepper
    //      SSM SecureString parameter (so the Lambda can derive the
    //      session id deterministically vs the agent-side helper).
    //
    // Both grants are conditional on the corresponding CfnParameter
    // being non-empty. Empty values produce no IAM statement — the
    // Lambda still deploys, just without warmup (logs
    // `warmup_skipped_no_runtime_arn`).
    const hasAgentRuntimeArn = new cdk.CfnCondition(this, 'HasAgentRuntimeArn', {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(agentRuntimeArnParam.valueAsString, ''),
      ),
    });
    const invokeRuntimePolicy = new iam.CfnPolicy(this, 'InvokeAgentRuntimePolicy', {
      policyName: cdk.Fn.sub('${P}-sma-invoke-agent-runtime', { P: prefix }),
      roles: [smaLambdaRole.roleName],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'InvokeAgentRuntimeForWarmup',
            Effect: 'Allow',
            Action: [
              'bedrock-agentcore:InvokeAgent',
              'bedrock-agentcore:InvokeAgentRuntime',
              'bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream',
              'bedrock-agentcore:InvokeAgentStream',
            ],
            Resource: [
              agentRuntimeArnParam.valueAsString,
              cdk.Fn.sub('${Arn}/runtime-endpoint/*', {
                Arn: agentRuntimeArnParam.valueAsString,
              }),
            ],
          },
        ],
      },
    });
    invokeRuntimePolicy.cfnOptions.condition = hasAgentRuntimeArn;

    const hasPepperParam = new cdk.CfnCondition(this, 'HasPepperParam', {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(customerIdPepperParameterArnParam.valueAsString, ''),
      ),
    });
    const pepperReadPolicy = new iam.CfnPolicy(this, 'PepperReadPolicy', {
      policyName: cdk.Fn.sub('${P}-sma-pepper-read', { P: prefix }),
      roles: [smaLambdaRole.roleName],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'ReadCustomerIdPepperFromSSM',
            Effect: 'Allow',
            Action: ['ssm:GetParameter'],
            Resource: [customerIdPepperParameterArnParam.valueAsString],
          },
          {
            // Pepper is a SecureString; SSM uses the AWS-managed
            // `aws/ssm` KMS key by default. The ViaService condition
            // narrows the kms:Decrypt grant so this role can ONLY
            // decrypt under SSM's umbrella, not from anywhere else.
            Sid: 'DecryptPepperViaSSM',
            Effect: 'Allow',
            Action: ['kms:Decrypt'],
            Resource: ['*'],
            Condition: {
              StringEquals: {
                'kms:ViaService': cdk.Fn.sub('ssm.${R}.amazonaws.com', {
                  R: cdk.Aws.REGION,
                }),
              },
            },
          },
        ],
      },
    });
    pepperReadPolicy.cfnOptions.condition = hasPepperParam;

    // Pass the pepper SSM parameter NAME (not ARN) to the Lambda so it
    // matches the AGENT-side env var convention. The agent's
    // pstn_customer.py uses `os.environ["CUSTOMER_ID_PEPPER_PARAMETER_NAME"]`
    // and calls ssm.get_parameter(Name=...), so we keep the contract
    // identical here. The CDK CfnParameter already carries the ARN so
    // we extract the parameter name via Fn::Split on `:parameter`.
    const pepperParamName = cdk.Fn.select(
      1,
      cdk.Fn.split(':parameter', customerIdPepperParameterArnParam.valueAsString),
    );
    smaFn.addEnvironment('CUSTOMER_ID_PEPPER_PARAMETER_NAME', pepperParamName);

    // ───────────── Chime SIP Media Application ─────────────
    const sma = new ChimeSipMediaApp(this, 'SipMediaApp', {
      name: cdk.Fn.sub('${P}-sma', { P: prefix }),
      region: cdk.Aws.REGION,
      endpoint: smaFn.functionArn,
    });

    // ───────────── Chime SIP Rule (ToPhoneNumber → SMA) ─────────────
    //
    // The TriggerValue is the E.164 threaded in from the persistent
    // IngressNumberStack via the `PhoneNumberE164` CfnParameter — this
    // stack no longer orders a number itself.  Rule name needs to be
    // globally-stable per account; appending the stack name
    // (`AWS::StackName`) isolates multi-tenant deploys in the same
    // account.
    const sipRule = new ChimeSipRule(this, 'SipRule', {
      name: cdk.Fn.sub('${P}-rule-${S}', { P: prefix, S: cdk.Aws.STACK_NAME }),
      triggerType: TriggerType.TO_PHONE_NUMBER,
      triggerValue: phoneNumberE164,
      targetApplications: [
        {
          priority: 1,
          sipMediaApplicationId: sma.sipMediaAppId,
          region: cdk.Aws.REGION,
        },
      ],
    });

    // Silence unused-binding warnings — the constructs are standalone
    // resources referenced by Chime's control plane, not by our code.
    void sipRule;

    // ───────────── Outputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'SipMediaApplicationId', {
      value: sma.sipMediaAppId,
      description:
        'Chime SIP Media Application id. Observability only; no downstream stack consumes it.',
    });

    new cdk.CfnOutput(this, 'VoiceConnectorId', {
      value: voiceConnector.voiceConnectorId,
      description:
        'Chime Voice Connector id. Observability only; downstream stacks read the ARN from the SSM parameter instead.',
    });

    // ───────────── Per-construct cdk-nag suppressions ─────────────

    NagSuppressions.addResourceSuppressions(
      smaFn,
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime is pinned to Runtime.NODEJS_24_X (Apr 2026 LTS through Apr 2028). This is the current Lambda LTS — no newer managed runtime exists to upgrade to.',
        },
      ],
      true,
    );

    // The `cdk-amazon-chime-resources` constructs internally stand up their
    // own framework Lambdas + IAM roles with wildcards to call Chime SDK
    // APIs during stack create/update.  These are library-owned and not
    // user-modifiable.  Scope suppressions to the specific nested paths so
    // we do not accidentally paper over user code findings.
    for (const chimeConstruct of [voiceConnector, sma, sipRule]) {
      NagSuppressions.addResourceSuppressions(
        chimeConstruct,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason:
              '`cdk-amazon-chime-resources` v3 internal custom-resource Lambdas attach AWSLambdaBasicExecutionRole. Library-managed, not user-modifiable.',
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              '`cdk-amazon-chime-resources` v3 internal custom-resource Lambdas need broad `chime-sdk-voice:*` / `chime:*` permissions to provision VC/SMA/PhoneNumber/SipRule (no per-resource IAM exists for create-time Chime APIs). Library-managed, not user-modifiable.',
          },
          {
            id: 'AwsSolutions-L1',
            reason:
              '`cdk-amazon-chime-resources` v3 internal custom-resource Lambdas pin a specific Node runtime; upgrade comes via a library version bump. Library-managed, not user-modifiable.',
          },
        ],
        true,
      );
    }
  }
}
