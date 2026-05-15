import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
  LOYALTY_PROMPT_TEXT,
  ANONYMOUS_PROMPT_TEXT,
} from './prompt-texts';

/**
 * {prefix}-AgentRuntimeStack — the AgentCore Runtime and its per-call
 * dependencies (customer-id pepper).
 *
 * r6 simplification (Task 10.6):
 *   - Networking mode changes from VPC → PUBLIC.  The agent no longer needs
 *     outbound UDP to Kinesis Video Streams (KVS) TURN; its only outbound
 *     is HTTPS to Bedrock / CloudWatch / SSM / MCP Gateway.
 *   - Drop CfnParameters `VpcId`, `PrivateSubnetIds`, `AgentSecurityGroupId`.
 *   - Drop the S3 playback bucket + BucketDeployment (fallback apology WAV).
 *     The r6 agent streams speech over a WebSocket via the Node SIP-gateway
 *     bridge; there is no more S3 playback path.
 *   - Drop Kinesis Video Streams IAM statements (KVSReadMedia, KVSSignaling)
 *     and the Chime SMA `UpdateSipMediaApplicationCall` grant.  The agent
 *     speaks to the Node SIP-gateway bridge directly over the WebSocket now.
 *   - Keep: Bedrock InvokeModel* for Nova Sonic, MCP Gateway invoke, SSM
 *     pepper read, ECR image pull, CloudWatch Logs, CloudWatch metrics,
 *     X-Ray.
 *
 * Per design §3(#6), §8.5 (pepper provisioning), §11.1 (IAM — trimmed for r6),
 * and tasks.md Task 10.6:
 *
 *  1. Four CfnParameters receive every upstream identifier:
 *     `DeploymentPrefix`, `AgentEcrRepoUri`, `AgentCoreGatewayUrl`,
 *     `BuildWaiterArn`.  No `Fn::ImportValue`, no CFN Exports (P5).
 *  2. The ECR repo ARN is DERIVED from the URI via `Fn::Split` /
 *     `Fn::Select` rather than taken as a separate parameter.
 *  3. Agent runtime IAM role — 8 statements remaining after the r6 trim:
 *     ECRTokenAccess, ECRImageAccess, LogsCreate, Metrics, XRay,
 *     BedrockInvoke, GatewayInvoke, SSMReadPepper.
 *  4. SSM pepper SecureString via a NodejsFunction-backed custom resource.
 *  5. `CfnRuntime` with `protocolConfiguration=HTTP`, default public
 *     network mode (no `networkConfiguration`), containerUri =
 *     `<AgentEcrRepoUri>:latest`, env vars for the agent container.
 *     Depends on the build waiter so the image push completes before
 *     CFN creates the runtime.
 *  6. Outputs `AgentRuntimeArn`, `CustomerIdPepperParameterName` — all
 *     WITHOUT `exportName` (P5).  `PlaybackBucketName` output dropped.
 *  7. cdk-nag + suppressions with written justification.
 */
export class AgentRuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters (4) ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    const agentEcrRepoUri = new cdk.CfnParameter(this, 'AgentEcrRepoUri', {
      type: 'String',
      minLength: 1,
      description:
        'ECR repo URI from tel-agent-ecr. The ARN is derived inside this stack (design §4.5).',
    });

    const agentCoreGatewayUrl = new cdk.CfnParameter(this, 'AgentCoreGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'AgentCore Gateway URL from ${prefix}-AgentCoreGatewayStack (read from cdk-outputs/tel-gateway.json — R15).',
    });

    const buildWaiterArn = new cdk.CfnParameter(this, 'BuildWaiterArn', {
      type: 'String',
      minLength: 1,
      description:
        'ARN of the tel-agent-build stack build waiter Lambda. Used as a DependsOn handle so CfnRuntime is not created until the agent image push is complete.',
    });

    // Customers table name — the prompt-renderer Lambda does a GetItem
    // on it to decide loyalty vs anonymous greeting. Threaded in from
    // cdk-outputs/tel-ddb.json by scripts/deploy-all.sh.
    const customersTableName = new cdk.CfnParameter(this, 'CustomersTableName', {
      type: 'String',
      minLength: 1,
      description:
        'Customers DynamoDB table name from ${prefix}-DynamoDBStack (read from cdk-outputs/tel-ddb.json).',
    });

    // ───────────── Derive the ECR repo ARN from the URI ─────────────
    //
    // URI shape: <account>.dkr.ecr.<region>.amazonaws.com/<repo-name>
    // ARN shape: arn:aws:ecr:<region>:<account>:repository/<repo-name>
    //
    // We use intrinsic Fn::Select + Fn::Split at deploy time so the URI
    // format never leaks into synth-time logic.
    const ecrRepoName = cdk.Fn.select(
      1,
      cdk.Fn.split('/', agentEcrRepoUri.valueAsString),
    );
    const ecrRepoArn = cdk.Fn.sub(
      'arn:aws:ecr:${R}:${A}:repository/${N}',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        N: ecrRepoName,
      },
    );

    // ───────────── SSM pepper custom resource ─────────────
    // A NodejsFunction backed by `custom_resources.Provider` creates (and on
    // stack delete, deletes) the SecureString. The pepper value never leaves
    // the Lambda nor appears in any CFN output.
    const pepperHandlerLogGroup = new logs.LogGroup(this, 'PepperManagerLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-pepper-manager', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const pepperProviderLogGroup = new logs.LogGroup(this, 'PepperProviderLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-pepper-manager-provider', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pepperFn = new NodejsFunction(this, 'PepperManagerFn', {
      functionName: cdk.Fn.sub('${P}-pepper-manager', { P: prefix }),
      entry: path.join(__dirname, '..', 'lambda', 'pepper-manager', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: pepperHandlerLogGroup,
    });

    const pepperParameterArn = cdk.Fn.sub(
      'arn:aws:ssm:${R}:${A}:parameter/${P}/customer-id-pepper',
      { R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID, P: prefix },
    );

    pepperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter'],
        resources: [pepperParameterArn],
      }),
    );

    const pepperProvider = new cr.Provider(this, 'PepperManagerProvider', {
      onEventHandler: pepperFn,
      logGroup: pepperProviderLogGroup,
    });

    const pepperResource = new cdk.CustomResource(this, 'CustomerIdPepper', {
      serviceToken: pepperProvider.serviceToken,
      properties: {
        DeploymentPrefix: prefix,
      },
    });

    // ───────────── Prompt templates (SSM String parameters) ─────────────
    //
    // Two `AWS::SSM::Parameter` resources hold the raw prompt text the
    // renderer Lambda serves to the agent container on every call.
    //
    // Rationale (working-agreements option B):
    //   - Source of truth stays in lib/prompt-texts.ts so edits are
    //     code-reviewable.
    //   - CDK writes the same text into SSM on every deploy — editing
    //     prompt-texts.ts + redeploying AgentRuntimeStack overwrites
    //     the SSM value in-place; live callers on subsequent calls pick
    //     up the new text WITHOUT a container image rebuild.
    //   - The renderer Lambda reads the value via `ssm:GetParameter`
    //     and caches it in-container for the Lambda's warm lifetime.
    //
    // Parameter names use the `/${prefix}/prompts/telephony-<kind>` path
    // so they live alongside the pepper under the project's SSM
    // namespace.
    const loyaltyPromptParam = new ssm.CfnParameter(this, 'LoyaltyPromptParam', {
      name: cdk.Fn.sub('/${P}/prompts/telephony-loyalty', { P: prefix }),
      type: 'String',
      value: LOYALTY_PROMPT_TEXT,
      description: 'Telephony loyalty-customer system prompt template. Edit lib/prompt-texts.ts + redeploy AgentRuntimeStack to overwrite.',
      tier: 'Standard',
    });

    const anonymousPromptParam = new ssm.CfnParameter(this, 'AnonymousPromptParam', {
      name: cdk.Fn.sub('/${P}/prompts/telephony-anonymous', { P: prefix }),
      type: 'String',
      value: ANONYMOUS_PROMPT_TEXT,
      description: 'Telephony anonymous-caller system prompt template. Edit lib/prompt-texts.ts + redeploy AgentRuntimeStack to overwrite.',
      tier: 'Standard',
    });

    // Serialize the two PutParameter calls so CloudFormation does not hit
    // SSM's low concurrent-PutParameter limit (~3/sec burst per account).
    // Without this, parallel creation of both params can fail one or both
    // with `GeneralServiceException` on first deploy.
    anonymousPromptParam.addDependency(loyaltyPromptParam);

    // ───────────── Prompt-renderer Lambda ─────────────
    //
    // Invoked by the agent container on every inbound call. Input is
    // the caller's E.164 + derived customerId; output is the rendered
    // system prompt (loyalty vs anonymous) plus the matched profile.
    //
    // 2-second timeout lives inside the agent's asyncio.gather() with
    // Nova Sonic + MCP setup so the Lambda fits comfortably under the
    // cold-start budget.
    const rendererHandlerLogGroup = new logs.LogGroup(this, 'PromptRendererLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-prompt-renderer', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const promptRendererFn = new NodejsFunction(this, 'PromptRendererFn', {
      functionName: cdk.Fn.sub('${P}-prompt-renderer', { P: prefix }),
      entry: path.join(__dirname, '..', 'lambda', 'prompt-renderer', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(3),
      memorySize: 256,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: rendererHandlerLogGroup,
      environment: {
        CUSTOMERS_TABLE_NAME: customersTableName.valueAsString,
        LOYALTY_PROMPT_PARAMETER_NAME: loyaltyPromptParam.ref,
        ANONYMOUS_PROMPT_PARAMETER_NAME: anonymousPromptParam.ref,
      },
    });

    // Renderer role permissions: GetItem on Customers, GetParameter on
    // both prompt parameters. No network egress required.
    promptRendererFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CustomersGetItem',
        actions: ['dynamodb:GetItem'],
        resources: [
          cdk.Fn.sub('arn:aws:dynamodb:${R}:${A}:table/${T}', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
            T: customersTableName.valueAsString,
          }),
        ],
      }),
    );
    promptRendererFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PromptParamsGet',
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Fn.sub('arn:aws:ssm:${R}:${A}:parameter/${P}/prompts/telephony-loyalty', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
            P: prefix,
          }),
          cdk.Fn.sub('arn:aws:ssm:${R}:${A}:parameter/${P}/prompts/telephony-anonymous', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
            P: prefix,
          }),
        ],
      }),
    );

    // ───────────── Agent runtime IAM role (design §11.1 — r6 trimmed) ─────────────
    const runtimeRole = new iam.Role(this, 'AgentRuntimeRole', {
      roleName: cdk.Fn.sub('${P}-agent-runtime-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description:
        'Role assumed by AgentCore Runtime sessions to pull the image, log, and call Bedrock / MCP Gateway / SSM. r6 removed all Kinesis Video Streams + Chime SMA grants.',
    });

    // Sid 1 — ECRTokenAccess (account-scoped; service does not support resource IAM)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRTokenAccess',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // Sid 2 — ECRImageAccess (scoped to this prefix's repo via derived ARN)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRImageAccess',
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [ecrRepoArn],
      }),
    );

    // Sid 3 — Logs lifecycle (AgentCore-managed log group path per design §11.1).
    //
    // Split into three statements matching the working reference qsr
    // runtime role:
    //
    //   (a) `logs:DescribeLogGroups` needs `log-group:*` (ALL log groups)
    //       because it is a list API — it returns cross-group metadata
    //       and AWS IAM validates against `arn:aws:logs:*:*:log-group:*`,
    //       NOT against a specific group prefix. If you constrain it to
    //       `/aws/bedrock-agentcore/runtimes/*`, the AWS CRT logs sink
    //       inside the container silently fails to initialise and
    //       nothing ever reaches CloudWatch (even though the container
    //       itself boots fine).  This was the "application logs never
    //       appeared" bug — sev-1 to diagnose, trivial to fix.
    //
    //   (b) `logs:CreateLogGroup` + `logs:DescribeLogStreams` on the
    //       runtime log-group prefix (lifecycle management on the
    //       group we own).
    //
    //   (c) `logs:CreateLogStream` + `logs:PutLogEvents` on the same
    //       prefix (actual write path).
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsDescribeGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [
          cdk.Fn.sub('arn:aws:logs:${R}:${A}:log-group:*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsGroupLifecycle',
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [
          cdk.Fn.sub(
            'arn:aws:logs:${R}:${A}:log-group:/aws/bedrock-agentcore/runtimes/*',
            { R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID },
          ),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsStreamWrite',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          cdk.Fn.sub(
            'arn:aws:logs:${R}:${A}:log-group:/aws/bedrock-agentcore/runtimes/*',
            { R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID },
          ),
        ],
      }),
    );

    // Sid 4 — Metrics (namespace-scoped by condition)
    // In r6 the `ActiveCalls` metric is emitted by the SIP-gateway container
    // (SipGatewayStack), not by the agent.  The agent itself only publishes
    // AgentCore-managed metrics in the `bedrock-agentcore` namespace.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': ['bedrock-agentcore'],
          },
        },
      }),
    );

    // Sid 5 — X-Ray (account-scoped)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'XRay',
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    // Sid 6 — BedrockInvoke (model ARNs wildcard — intended; Nova Sonic model family)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvoke',
        actions: [
          'bedrock:InvokeModelWithBidirectionalStream',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: [
          // Scoped to the Nova Sonic model family in the deployment region.
          // Cross-region wildcard removed in security-review pass — agent
          // only invokes Nova Sonic 2 (`amazon.nova-sonic-*`) in the same
          // region as the AgentCore Runtime container.
          cdk.Fn.sub('arn:aws:bedrock:${R}::foundation-model/amazon.nova-sonic-*', {
            R: cdk.Aws.REGION,
          }),
          cdk.Fn.sub('arn:aws:bedrock:${R}:${A}:*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // Sid 7 — GatewayInvoke (all agentcore gateways in this account+region)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GatewayInvoke',
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [
          cdk.Fn.sub('arn:aws:bedrock-agentcore:${R}:${A}:gateway/*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // Sid 8 — SSMRead (pepper parameter, this prefix only)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SSMReadPepper',
        actions: ['ssm:GetParameter'],
        resources: [pepperParameterArn],
      }),
    );

    // Sid 9 — InvokePromptRenderer (one Lambda, tightly scoped)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokePromptRenderer',
        actions: ['lambda:InvokeFunction'],
        resources: [promptRendererFn.functionArn],
      }),
    );

    // (r6-removed)  The following statements lived in r5 and are NOT added
    // in r6 — left as a breadcrumb so a future reader knows what changed:
    //   - Sid 8 KVSReadMedia  (kinesisvideo:GetDataEndpoint / GetMedia)
    //   - Sid 9 KVSSignaling  (kinesisvideo Create/Describe/Get* signaling)
    //   - Sid 10 ChimeUpdateCall (chime-sdk-voice:UpdateSipMediaApplicationCall)
    //   - Sid 11 PlaybackS3Put (s3:PutObject on playback bucket)

    // ───────────── CfnRuntime ─────────────
    //
    // NOTE on AgentRuntimeName: CloudFormation enforces the regex
    // `[a-zA-Z][a-zA-Z0-9_]{0,47}` — no hyphens allowed.  Since the
    // deployment prefix allows hyphens, we cannot interpolate it into the
    // name.  We use a fixed name and rely on AgentCore's auto-generated ARN
    // suffix for uniqueness.  This matches the reference-project pattern
    // and is consistent with design §8#4 (single agent runtime per account
    // — multi-tenancy is a non-goal for r1).  The `DeploymentPrefix` still
    // tags every other resource in this stack per R19.
    const agentRuntime = new bedrockagentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: 'telephony_agent_runtime',
      description:
        'Telephony voice ordering agent — Nova Sonic bidi over WebSocket, ARM64, public network mode (r6)',
      roleArn: runtimeRole.roleArn,

      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: cdk.Fn.sub('${U}:latest', {
            U: agentEcrRepoUri.valueAsString,
          }),
        },
      },

      // PUBLIC network mode (r6): AgentCore provides a service-managed
      // public ENI for the runtime.  The agent's only outbound traffic is
      // HTTPS to AWS service APIs (Bedrock, CloudWatch, SSM, MCP Gateway)
      // and the SigV4-presigned WebSocket URL that the Node SIP-gateway
      // bridge uses to connect IN — no outbound UDP, no Kinesis Video
      // Streams TURN, no VPC peering needed.
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },

      // WebSocket upgrade rides over HTTP — AgentCore Runtime's
      // /runtimes/<arn>/ws endpoint negotiates the upgrade on the standard
      // HTTP protocol channel.  HTTP remains the protocol config value.
      protocolConfiguration: 'HTTP',

      environmentVariables: {
        LOG_LEVEL: 'INFO',
        AGENTCORE_GATEWAY_URL: agentCoreGatewayUrl.valueAsString,
        DEPLOYMENT_PREFIX: prefix,
        CUSTOMER_ID_PEPPER_PARAMETER_NAME: cdk.Fn.sub('/${P}/customer-id-pepper', {
          P: prefix,
        }),
        PROMPT_RENDERER_FUNCTION_NAME: promptRendererFn.functionName,
      },
    });

    cdk.Tags.of(agentRuntime).add('DeploymentPrefix', prefix);
    cdk.Tags.of(agentRuntime).add('Application', 'telephony-voice-ordering-agent');

    // ───────────── Build-waiter dependency ─────────────
    // The `BuildWaiterArn` CfnParameter is the ARN of the tel-agent-build
    // stack's build-waiter Lambda.  By the time the previous stack's deploy
    // returned, the image IS pushed — but we encode the ordering intent via
    // a synthetic dependency so a future refactor keeps the invariant.
    const waiterMarker = new cdk.CfnResource(this, 'BuildWaiterDepMarker', {
      type: 'AWS::CloudFormation::WaitConditionHandle',
    });
    waiterMarker.node.addMetadata('BuildWaiterArn', buildWaiterArn.valueAsString);
    agentRuntime.addDependency(waiterMarker);

    // Pepper resource must exist before the runtime starts (the env var
    // points at it; the runtime reads it on first call).
    agentRuntime.addDependency(
      pepperResource.node.defaultChild as cdk.CfnResource,
    );

    // ───────────── Outputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentRuntime.attrAgentRuntimeArn,
      description:
        'AgentCore Runtime ARN — consumed by tel-sip-gateway (Fargate task role bedrock-agentcore:InvokeAgentRuntime scope) via CfnParameter.',
    });

    new cdk.CfnOutput(this, 'CustomerIdPepperParameterName', {
      value: pepperParameterArn,
      description:
        'SSM parameter ARN for the customer-id pepper (the VALUE is never output; see README "Pepper Rotation").',
    });

    new cdk.CfnOutput(this, 'PromptRendererFunctionName', {
      value: promptRendererFn.functionName,
      description:
        'Lambda function name invoked by the agent container per call to pick and render the loyalty/anonymous system prompt.',
    });

    new cdk.CfnOutput(this, 'LoyaltyPromptParameterName', {
      value: loyaltyPromptParam.ref,
      description:
        'SSM parameter path for the loyalty-caller system prompt template. Overwrite in place for hot-patch: aws ssm put-parameter --name <this> --type String --overwrite --value file://new.txt',
    });

    new cdk.CfnOutput(this, 'AnonymousPromptParameterName', {
      value: anonymousPromptParam.ref,
      description:
        'SSM parameter path for the anonymous-caller system prompt template.',
    });

    // ───────────── Per-construct cdk-nag suppressions ─────────────
    // Stack-level suppressions don't cascade to child constructs; each
    // suppression below is attached to the specific resource that raises it.
    // Written justification per NFR13.

    NagSuppressions.addResourceSuppressions(
      runtimeRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Residual wildcards on the r6-trimmed role: (a) ecr:GetAuthorizationToken is account-scoped by AWS — no resource-level IAM; (b) xray:* and cloudwatch:PutMetricData are service-scoped, not resource-scoped (PutMetricData is further conditioned on `cloudwatch:namespace` = `bedrock-agentcore`); (c) bedrock:InvokeModel* is now scoped to `arn:aws:bedrock:${region}::foundation-model/amazon.nova-sonic-*` — the Nova Sonic model family in the deployment region only. All r5 Kinesis Video Streams + Chime SMA + S3 playback grants removed in r6.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      promptRendererFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is used via CDK default for CloudWatch Logs writes; the concrete log group is explicitly provisioned above with a 30-day retention to satisfy NFR13.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda execution role has NO wildcard actions — DDB GetItem is scoped to the Customers table, SSM GetParameter is scoped to two specific prompt parameters. cdk-nag occasionally flags CDK-injected log-group permissions on managed basic-execution roles; those are not wildcards in practice.',
        },
      ],
      true,
    );
  }
}
