import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { buildspec } from './buildspec';

/**
 * Chime SDK Voice Connector source-IP allowlist for us-east-1.
 *
 * Source of truth:
 *   https://docs.aws.amazon.com/chime-sdk/latest/ag/network-config.html
 *
 * Chime VC signaling originates from a single /23 in us-east-1 for SIP
 * (TCP/UDP 5060). RTP media originates from the signaling /23 plus four
 * additional media /25 blocks. These CIDRs are pinned into both the NLB
 * SG (for r6's NLB-proxied path) and the task SG (client-IP-preserved
 * on UDP + direct RTP under r7).
 *
 * Exported so the synth-time assertion test in `test/sip-gateway-stack.test.ts`
 * can verify the generated security group rules match this list verbatim
 * — any drift fails the deploy (R27, R28, R31).
 *
 * Operational maintenance (R31): re-validate against the AWS docs URL
 * quarterly. Migrate to an AWS-managed prefix list when one is published.
 *
 * These are only correct for us-east-1. Multi-region deployments MUST
 * re-derive the list per region from the docs.
 */
export const CHIME_VC_SIGNALING_CIDRS: readonly string[] = [
  '3.80.16.0/23',
];
export const CHIME_VC_MEDIA_CIDRS: readonly string[] = [
  '3.80.16.0/23',
  '52.55.62.128/25',
  '52.55.63.0/25',
  '34.212.95.128/25',
  '34.223.21.0/25',
];

/**
 * `${prefix}-SipGatewayStack` — drachtio-server + Node.js SIP gateway on
 * Fargate that bridges Session Initiation Protocol (SIP) + Real-time
 * Transport Protocol (RTP) from the Chime Voice Connector (VC) into a
 * SigV4-signed WebSocket to the Bedrock AgentCore Runtime.
 *
 * Architecture: drachtio-server handles SIP signaling, a Node.js app
 * speaks Real-time Transport Protocol directly with Chime VC over UDP
 * (no separate media engine), bridges audio to AgentCore over a
 * SigV4-signed WebSocket, and emits `ActiveCalls` metrics. See
 * `backend/drachtio-sip-gateway/README.md` for the per-call sequence and
 * `.kiro/specs/telephony-voice-ordering-agent/design.md` §14-§22 for the
 * design history.
 *
 * Resources provisioned (r6 Task 10.4):
 *   1. Elastic Container Registry (ECR) repo `${prefix}-sip-gateway`.
 *   2. Source S3 bucket + CodeBuild project that builds the ARM64
 *      drachtio-server + rtpengine + Node.js image from
 *      `backend/drachtio-sip-gateway/` and pushes to ECR.
 *   3. Custom-resource build waiter so the ECS service cannot create until
 *      the image push completes (mirrors tel-agent-build's pattern).
 *   4. ECS cluster on the Network Stack's Virtual Private Cloud (VPC).
 *   5. Security Group for Fargate tasks — ingress TCP/5060 and UDP/16000-16048
 *      from the Network Load Balancer (NLB) security group; egress HTTPS for
 *      AWS API calls (Bedrock AgentCore InvokeAgentRuntime, CloudWatch Logs,
 *      ECR pull).
 *   6. Fargate task definition (ARM64, 1 vCPU / 2 GB) with task role scoped
 *      to `bedrock-agentcore:InvokeAgentRuntime` on the AgentRuntimeArn plus
 *      `cloudwatch:PutMetricData` on the `${prefix}/SipGateway` namespace.
 *   7. Internet-facing NLB in the Network Stack's public subnets. One
 *      TCP/5060 listener (SIP signaling). 49 UDP listeners 16000-16048,
 *      one per RTP port, each with its own target group. The NLB is
 *      public because the Chime SDK Voice Connector control plane runs
 *      outside our Virtual Private Cloud (VPC) and cannot deliver SIP
 *      INVITEs to private IPs — an internal NLB's DNS resolves publicly
 *      but the returned IPs are VPC-private and unroutable from Chime's
 *      side. Task backends stay in private subnets; only the NLB is
 *      publicly reachable on 5060/tcp + 16000-16048/udp.
 *   8. Application autoscaling with target-tracking on the custom CloudWatch
 *      metric `${prefix}/SipGateway/ActiveCalls`. Target value 6 calls/task;
 *      min 2 tasks, max = CfnParameter (default 10).
 *
 * CfnParameters (7):
 *   - DeploymentPrefix
 *   - VpcId (from ${prefix}-NetworkStack)
 *   - PrivateSubnetIds (from ${prefix}-NetworkStack)
 *   - AgentRuntimeArn (from ${prefix}-AgentRuntimeStack)
 *   - CallLifetimeSeconds (default 600)
 *   - MaxTasksPerService (default 10)
 *   - AgentVoiceId (Nova Sonic voice, default 'tiffany')
 *
 * CfnOutputs (no exportName, per P5):
 *   - NlbDnsName         — consumed by ${prefix}-IngressStack (VC origination route).
 *   - NlbHostedZoneId    — optional for downstream Route53 alias.
 *   - SipGatewayEcrRepoUri — observability / rollback tag lookup.
 *   - BuildWaiterArn     — downstream DependsOn handle (reserved for future use).
 *   - SipGatewayServiceName / SipGatewayClusterName — operator observability.
 */
export class SipGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      minLength: 1,
      description:
        'VPC id from ${prefix}-NetworkStack (threaded from cdk-outputs/tel-network.json).',
    });

    const privateSubnetIds = new cdk.CfnParameter(this, 'PrivateSubnetIds', {
      type: 'CommaDelimitedList',
      description:
        'Comma-delimited list of private subnet ids for the Fargate tasks.',
    });

    const publicSubnetIds = new cdk.CfnParameter(this, 'PublicSubnetIds', {
      type: 'CommaDelimitedList',
      description:
        'Comma-delimited list of public subnet ids for the internet-facing NLB. Required because the Chime SDK Voice Connector cannot route to private IPs.',
    });

    const agentRuntimeArn = new cdk.CfnParameter(this, 'AgentRuntimeArn', {
      type: 'String',
      minLength: 1,
      description:
        'Bedrock AgentCore Runtime ARN. The Fargate task role gets scoped ' +
        'bedrock-agentcore:InvokeAgentRuntime grants against this ARN plus ' +
        'the runtime-endpoint/* suffix (data-plane actually checks the suffix).',
    });

    const callLifetimeSeconds = new cdk.CfnParameter(this, 'CallLifetimeSeconds', {
      type: 'Number',
      default: 600,
      minValue: 60,
      maxValue: 3600,
      description:
        'Per-call max duration in seconds. Wired to the drachtio dialplan as a per-leg session timeout.',
    });

    const maxTasksPerService = new cdk.CfnParameter(this, 'MaxTasksPerService', {
      type: 'Number',
      default: 10,
      minValue: 1,
      maxValue: 50,
      description:
        'Upper bound for Fargate service autoscaling. Minimum is fixed at 2 tasks.',
    });

    const agentVoiceId = new cdk.CfnParameter(this, 'AgentVoiceId', {
      type: 'String',
      default: 'tiffany',
      allowedValues: ['matthew', 'tiffany', 'amy'],
      description:
        'Nova Sonic voice id passed to AgentCore Runtime as the voice_id query param.',
    });

    // ───────────── Derived constants ─────────────
    //
    // RTP port range. Matches backend/drachtio-sip-gateway/rtpengine.conf
    // (port-min=16000, port-max=16048). Constrained to 50 ports because
    // Network Load Balancer allows a maximum of 50 listeners per load
    // balancer and that quota is NOT adjustable
    // (https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-limits.html).
    // One TCP listener (5060) + 49 UDP listeners (16000-16048) = 50 exactly.
    // (We reserve one slot by using 49 RTP ports instead of 50 so we stay
    //  under the cap even if a future audit wants headroom.)
    const RTP_PORT_START = 16000;
    // 49 ports leaves headroom under the NLB's 50-listener-per-LB limit
    // (we already use 1 listener for TCP 5060 SIP signaling).
    const RTP_PORT_COUNT = 49;
    const RTP_PORT_END = RTP_PORT_START + RTP_PORT_COUNT - 1; // 16048

    // ───────────── Chime Voice Connector source allowlist (us-east-1) ─────────────
    //
    // Sourced from the AWS docs:
    //   https://docs.aws.amazon.com/chime-sdk/latest/ag/network-config.html
    //
    // As of r7 the Chime VC CIDR lists are module-scope `readonly`
    // constants at the top of this file (R31), exported so the
    // synth-time assertion test in `test/sip-gateway-stack.test.ts`
    // can verify the generated security group rules match them
    // verbatim — any drift fails the deploy (R27, R28).

    // ───────────── ECR repository ─────────────
    //
    // Removal policy DESTROY (not RETAIN) to align with the
    // "iterate-and-fail is cheap" posture of this reference project.  A
    // failed stack create would otherwise leave an orphaned ECR repo
    // that blocks retries with `repository already exists`; forcing
    // CFN to clean it up on delete lets iteration loops run freely.
    //
    // For PRODUCTION deployments where rollback history matters,
    // operators should flip this back to RETAIN (and re-enable
    // emptyOnDelete: false) so a stack teardown preserves shipped
    // images.  See README "Production hardening" for the exact edit.
    const imageRepo = new ecr.Repository(this, 'SipGatewayRepo', {
      repositoryName: cdk.Fn.sub('${P}-sip-gateway', { P: prefix }),
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: 'Retain only the 10 most recent images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    // ───────────── CodeBuild source bucket + source upload ─────────────
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: cdk.Fn.sub('${P}-sip-gateway-source-${A}-${R}', {
        P: prefix,
        A: cdk.Aws.ACCOUNT_ID,
        R: cdk.Aws.REGION,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload the drachtio SIP gateway source tree to the bucket. Path
    // is four levels up from this file (lib/) → cdk/ → telephony-sip-gateway/
    // → telephony-interface/ → repo root, then down into
    // backend/drachtio-sip-gateway/.
    const sourceDeployment = new s3deploy.BucketDeployment(
      this,
      'SipGatewaySourceDeployment',
      {
        sources: [
          s3deploy.Source.asset(
            path.join(__dirname, '../../..', '..', 'backend', 'drachtio-sip-gateway'),
          ),
        ],
        destinationBucket: sourceBucket,
        destinationKeyPrefix: 'sip-gateway-source',
        retainOnDelete: false,
        memoryLimit: 512,
      },
    );

    // ───────────── CodeBuild project role ─────────────
    const buildRole = new iam.Role(this, 'BuildRole', {
      roleName: cdk.Fn.sub('${P}-sip-gateway-build-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        'Role assumed by the CodeBuild project that builds the drachtio SIP gateway image.',
    });

    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogsWrite',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          cdk.Fn.sub('arn:aws:logs:${R}:${A}:log-group:/aws/codebuild/*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuthToken',
        actions: ['ecr:GetAuthorizationToken'],
        // ecr:GetAuthorizationToken does not support resource-level IAM.
        resources: ['*'],
      }),
    );

    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrImagePush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: [imageRepo.repositoryArn],
      }),
    );

    sourceBucket.grantRead(buildRole, 'sip-gateway-source/*');

    // ───────────── CodeBuild project ─────────────
    const buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/codebuild/${P}-sip-gateway-build', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const buildProject = new codebuild.Project(this, 'SipGatewayBuild', {
      projectName: cdk.Fn.sub('${P}-sip-gateway-build', { P: prefix }),
      role: buildRole,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'sip-gateway-source/',
      }),
      environment: {
        // ARM64 native build — no QEMU emulation, matches Fargate's ARM64 runtime.
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true, // Docker-in-Docker for `docker buildx`.
        // MEDIUM (4 vCPU, 7 GB RAM) is enough for the drachtio-server +
        // rtpengine source compile. drachtio pulls sofia-sip as a submodule
        // and the C++ compile is ~8 min on MEDIUM; rtpengine is another
        // ~3 min; the apt install + Node deps layer caching dominates the
        // remaining time. Total ~15 min end-to-end on MEDIUM.
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject(buildspec),
      // 45 min cap is comfortable headroom over a typical ~15 min build.
      timeout: cdk.Duration.minutes(45),
      logging: {
        cloudWatch: { enabled: true, logGroup: buildLogGroup },
      },
    });

    buildProject.node.addDependency(sourceDeployment);

    // ───────────── Build-waiter Lambda + custom resource ─────────────
    const waiterHandlerEntry = path.join(
      __dirname,
      '..',
      'lambda',
      'build-waiter',
      'handler.ts',
    );

    const waiterLogGroup = new logs.LogGroup(this, 'BuildWaiterLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-sip-gateway-build-waiter', {
        P: prefix,
      }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const waiterIsCompleteLogGroup = new logs.LogGroup(
      this,
      'BuildWaiterIsCompleteLogGroup',
      {
        logGroupName: cdk.Fn.sub('/aws/lambda/${P}-sip-gateway-build-waiter-check', {
          P: prefix,
        }),
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const waiterProviderLogGroup = new logs.LogGroup(
      this,
      'BuildWaiterProviderLogGroup',
      {
        logGroupName: cdk.Fn.sub('/aws/lambda/${P}-sip-gateway-build-waiter-provider', {
          P: prefix,
        }),
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const waiterFn = new NodejsFunction(this, 'BuildWaiterFn', {
      functionName: cdk.Fn.sub('${P}-sip-gateway-build-waiter', { P: prefix }),
      entry: waiterHandlerEntry,
      handler: 'onEvent',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: waiterLogGroup,
    });

    const waiterIsCompleteFn = new NodejsFunction(this, 'BuildWaiterIsCompleteFn', {
      functionName: cdk.Fn.sub('${P}-sip-gateway-build-waiter-check', { P: prefix }),
      entry: waiterHandlerEntry,
      handler: 'isComplete',
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
      logGroup: waiterIsCompleteLogGroup,
    });

    const projectArn = cdk.Fn.sub(
      'arn:aws:codebuild:${R}:${A}:project/${P}-sip-gateway-build',
      { R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID, P: prefix },
    );
    const codeBuildPolicy = new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [projectArn],
    });
    waiterFn.addToRolePolicy(codeBuildPolicy);
    waiterIsCompleteFn.addToRolePolicy(codeBuildPolicy);

    const waiterProvider = new cr.Provider(this, 'BuildWaiterProvider', {
      onEventHandler: waiterFn,
      isCompleteHandler: waiterIsCompleteFn,
      queryInterval: cdk.Duration.seconds(30),
      // Match CodeBuild timeout + a cushion. drachtio + rtpengine source
      // compile is ~15 min on MEDIUM; 60 min gives plenty of headroom
      // for cold-start registry churn.
      totalTimeout: cdk.Duration.minutes(60),
      logGroup: waiterProviderLogGroup,
    });

    const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: waiterProvider.serviceToken,
      properties: {
        ProjectName: buildProject.projectName,
        // Re-build on every source-tree change.
        TriggerHash: cdk.Fn.join(',', sourceDeployment.objectKeys),
      },
    });

    buildTrigger.node.addDependency(buildProject);
    buildTrigger.node.addDependency(sourceDeployment);

    // ───────────── VPC import ─────────────
    //
    // We look up the VPC + subnets by id/ids rather than by tag+lookup so the
    // stack synthesizes without needing live AWS creds.  Because
    // PrivateSubnetIds is a CommaDelimitedList CfnParameter, we can only
    // iterate it with Fn::Select; CDK's `Vpc.fromVpcAttributes` accepts the
    // token array directly for `privateSubnetIds`.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: vpcId.valueAsString,
      // We deliberately pass static AZ letters here; the subnet-to-AZ pairing
      // isn't actually used at synth time because our Fargate service pins
      // subnets explicitly (vpcSubnets: { subnets: vpc.privateSubnets }) and
      // the NLB uses the same pinning.  CDK only requires that
      // availabilityZones.length matches privateSubnetIds.length for the
      // token-array to pass validation — so we extract each subnet id from
      // the CommaDelimitedList via Fn::Select and pair it with a
      // placeholder AZ letter.  AZ letters are never read by downstream
      // constructs.
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      privateSubnetIds: [
        cdk.Fn.select(0, privateSubnetIds.valueAsList),
        cdk.Fn.select(1, privateSubnetIds.valueAsList),
      ],
      publicSubnetIds: [
        cdk.Fn.select(0, publicSubnetIds.valueAsList),
        cdk.Fn.select(1, publicSubnetIds.valueAsList),
      ],
    });

    // ───────────── Security groups ─────────────
    //
    // Under r7 (design §19/§20) the NLB handles SIP/TCP 5060 only; RTP
    // goes direct from Chime to each task's public IP. The SGs below
    // reflect that split:
    //   • nlbSg  : Chime VC CIDRs → TCP 5060 (signaling, via NLB).
    //   • taskSg : ingress TCP 5060 from nlbSg only; ingress UDP
    //     16000-16048 from Chime VC CIDRs directly; egress TCP 443 to
    //     AWS APIs (AgentCore WebSocket / CloudWatch / ECR pull).
    //
    // The task SG is the ENTIRE perimeter defense for the RTP path
    // because tasks have public IPs. R27/R28/R31 invariants are
    // synth-asserted in `test/sip-gateway-stack.test.ts`.
    const nlbSg = new ec2.SecurityGroup(this, 'NlbSg', {
      vpc,
      // No `securityGroupName` — let CDK derive a unique auto-generated
      // name from the logical id. Reason: AWS::EC2::SecurityGroup treats
      // `GroupDescription` as IMMUTABLE, so any prose edit forces CFN to
      // replace the SG. With an explicit name set, the replacement collides
      // with the still-living old SG and the deploy fails with
      // `AlreadyExists`. Auto-generated names carry a random suffix that
      // changes on every replacement, so the collision is impossible.
      description:
        'Chime Voice Connector to internal NLB for the drachtio SIP gateway (TCP/5060 signaling + UDP RTP range).',
      allowAllOutbound: false,
    });

    // Chime VC source-CIDR allowlist — lock port 5060 down to the
    // Chime SIP signaling range in us-east-1. Without this, anyone on
    // the internet can send SIP INVITEs to our public NLB (scanners
    // routinely do this with fake user= names like `sommer:sommer`
    // which chew up Nova Sonic quota and taint our call-quality logs).
    for (const cidr of CHIME_VC_SIGNALING_CIDRS) {
      nlbSg.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(5060),
        `SIP signaling from Chime Voice Connector (${cidr})`,
      );
    }

    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      // No `securityGroupName` — see NlbSg comment above.
      description:
        'drachtio SIP gateway Fargate tasks - ingress from the NLB SG on SIP + RTP; egress HTTPS only.',
      allowAllOutbound: false,
    });

    // TCP 5060 signaling — scoped to NLB SG. Any direct-internet TCP
    // 5060 is denied; Chime signaling arrives via the NLB only (R28).
    taskSg.addIngressRule(
      nlbSg,
      ec2.Port.tcp(5060),
      'SIP signaling from the internal NLB',
    );

    // UDP 16000-16048 media — direct from Chime VC source CIDRs. Under
    // r7 the NLB does NOT proxy RTP; Chime sends media straight to the
    // task's public IP. Task SG is the perimeter defense. R27 invariant
    // (zero 0.0.0.0/0; Chime CIDRs only) is synth-asserted.
    for (const cidr of CHIME_VC_MEDIA_CIDRS) {
      taskSg.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.udpRange(RTP_PORT_START, RTP_PORT_END),
        `RTP media from Chime Voice Connector (${cidr})`,
      );
    }

    taskSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to AWS service APIs (Bedrock AgentCore Runtime WebSocket upgrade, CloudWatch Logs/Metrics, ECR pull)',
    );

    // NLB SG egress to taskSg on TCP 5060 only (r7). Without an explicit
    // egress rule, a `allowAllOutbound: false` SG blocks the NLB's
    // health-check probes and forwarded traffic to backends (verified
    // via VPC Reachability Analyzer `ENI_SG_RULES_MISMATCH`). Narrow
    // scope to task SG on exactly the port the NLB forwards.
    nlbSg.addEgressRule(
      taskSg,
      ec2.Port.tcp(5060),
      'SIP signaling forwarded to Fargate tasks',
    );

    // ───────────── ECS cluster ─────────────
    const cluster = new ecs.Cluster(this, 'SipGatewayCluster', {
      clusterName: cdk.Fn.sub('${P}-sip-gateway', { P: prefix }),
      vpc,
      containerInsights: true,
    });

    // ───────────── Task role + execution role ─────────────
    //
    // Task role = the role containers assume (for AWS API calls during the
    // call: SigV4-signing the WebSocket URL, publishing ActiveCalls metric).
    // Execution role = the role the ECS agent assumes to pull the image,
    // write container logs.
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: cdk.Fn.sub('${P}-sip-gateway-task-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Role assumed by drachtio SIP gateway tasks to call Bedrock AgentCore + publish ActiveCalls metrics.',
    });

    // InvokeAgentRuntime* — the WebSocket data plane on Bedrock
    // AgentCore requires the full InvokeAgent* action family
    // (InvokeAgent / InvokeAgentRuntime / InvokeAgentRuntimeWithWebSocketStream
    // / InvokeAgentStream). Granting just InvokeAgentRuntime yields 403
    // on the wss:/<arn>/ws upgrade because the server maps the upgrade
    // request to InvokeAgentRuntimeWithWebSocketStream, not the HTTP
    // sibling action.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeAgentRuntime',
        actions: [
          'bedrock-agentcore:InvokeAgent',
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream',
          'bedrock-agentcore:InvokeAgentStream',
        ],
        resources: [
          agentRuntimeArn.valueAsString,
          cdk.Fn.sub('${Arn}/runtime-endpoint/*', {
            Arn: agentRuntimeArn.valueAsString,
          }),
        ],
      }),
    );

    // PutMetricData — namespace-scoped via condition key.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchPutMetric',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'], // service does not support resource-level IAM
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': [
              cdk.Fn.sub('${P}/SipGateway', { P: prefix }),
            ],
          },
        },
      }),
    );

    // ECS Exec — SSM Messages channel grants so `aws ecs execute-command`
    // can open an interactive shell into a running task. Used for
    // diagnostics (ss / tcpdump / strace during a sofia bind that stops
    // responding, etc.). None of these actions expose data outside the
    // task; they are the signaling API Systems Manager Session Manager
    // uses.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsExecSsmMessages',
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'], // ssmmessages does not support resource-level IAM
      }),
    );

    // ec2:DescribeNetworkInterfaces + ecs:DescribeTasks — entrypoint.sh
    // uses these at task startup to resolve the public IP to advertise
    // to Chime in SDP c=/o= lines.
    //
    // r7 path (preferred): describe the task's OWN ENI (via
    // ECS_CONTAINER_METADATA_URI_V4 → ecs:DescribeTasks →
    // ec2:DescribeNetworkInterfaces) and publish that task's
    // auto-assigned public IP. Chime then sends RTP directly to the
    // task, bypassing the NLB entirely.
    //
    // r6 legacy fallback: describe all NLB ENIs, pick the one in the
    // task's AZ, advertise its EIP. Kept for the r7 staged cutover
    // so a single image works in both the pre-11.2 (private subnet,
    // NLB UDP) and post-11.2 (public subnet, direct RTP) layouts.
    //
    // Neither action supports resource-level IAM scoping beyond
    // account-wide; `resources: ['*']` is the only option AWS offers.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ResolveTaskPublicIpAtStartup',
        actions: [
          'ec2:DescribeNetworkInterfaces',
          'ecs:DescribeTasks',
        ],
        resources: ['*'],
      }),
    );

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: cdk.Fn.sub('${P}-sip-gateway-exec-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Role assumed by the ECS agent to pull the container image and write task logs.',
    });
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AmazonECSTaskExecutionRolePolicy',
      ),
    );

    // ───────────── Task definition ─────────────
    //
    // ARM64, 1 vCPU / 2 GB RAM.  drachtio-server itself uses ~50 MB; the
    // Node.js bridge another 100-200 MB; the rest gives RTP jitter
    // buffers headroom.  Tune after load testing per task 10.9.
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: cdk.Fn.sub('${P}-sip-gateway', { P: prefix }),
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
      taskRole,
      executionRole,
    });

    // ───────────── drachtio admin-port shared secret ─────────────
    //
    // The drachtio-server admin socket on TCP/9022 (loopback inside the
    // task) requires a shared secret to authenticate the Node.js client
    // process against the drachtio process. Both endpoints live in the
    // same container, but we still want the secret out of the task
    // definition (and out of CloudFormation events) so it never appears
    // in plaintext outside Secrets Manager itself.
    //
    // The secret value is auto-generated at create time. Rotation is
    // out of scope for this MVP — the secret only protects an in-task
    // loopback socket, not a network-reachable one (the task SG has no
    // ingress on TCP/9022 from anywhere).
    const drachtioSecret = new secretsmanager.Secret(this, 'DrachtioSecret', {
      secretName: cdk.Fn.sub('${P}-drachtio-admin-secret', { P: prefix }),
      description:
        'Shared secret for the drachtio admin TCP/9022 loopback socket inside the SIP gateway task. Auto-generated at create time.',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
        excludeCharacters: '"@/\\',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The execution role (the role the ECS agent assumes to start the
    // container) needs GetSecretValue on this secret so it can resolve
    // the secrets:/Secrets task-definition reference at task-start time.
    drachtioSecret.grantRead(executionRole);

    const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: cdk.Fn.sub('/ecs/${P}-sip-gateway', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer('SipGateway', {
      containerName: 'drachtio-sip-gateway',
      image: ecs.ContainerImage.fromEcrRepository(imageRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'sip-gateway',
        logGroup: taskLogGroup,
      }),
      environment: {
        DEPLOYMENT_PREFIX: prefix,
        AGENT_RUNTIME_ARN: agentRuntimeArn.valueAsString,
        AGENT_VOICE_ID: agentVoiceId.valueAsString,
        CALL_LIFETIME_SECONDS: callLifetimeSeconds.valueAsString,
        AWS_REGION: cdk.Aws.REGION,
        ENABLE_CLOUDWATCH_METRICS: 'true',
        // SIP_EXT_HOST / RTP_EXT_HOST are resolved at container start via
        // the entrypoint — it looks up the NLB DNS name via the env var
        // SIP_EXT_HOST below.  We pass the NLB DNS name explicitly because
        // tasks in Fargate cannot call DescribeLoadBalancers without extra
        // IAM, and hard-coding the DNS via env is simpler and more reliable.
        //
        // Populated post-hoc below after the NLB is defined.
      },
    });

    // Expose SIP TCP and the full RTP UDP range as container port mappings.
    container.addPortMappings({
      containerPort: 5060,
      hostPort: 5060,
      protocol: ecs.Protocol.TCP,
    });
    // The drachtio Node.js app allocates RTP ports dynamically within
    // the 16000-16048 range.
    // AwsVPC networking assigns each task an ENI and ALL configured container
    // ports are reachable on that ENI, but ECS still requires explicit port
    // mapping entries.  We loop the full range here.
    for (let p = RTP_PORT_START; p <= RTP_PORT_END; p++) {
      container.addPortMappings({
        containerPort: p,
        hostPort: p,
        protocol: ecs.Protocol.UDP,
      });
    }

    // ───────────── Internet-facing NLB + listeners + target groups ─────────────
    //
    // The NLB MUST be internet-facing (in public subnets) because the
    // Chime SDK Voice Connector control plane lives outside our Virtual
    // Private Cloud (VPC) and cannot route to private IPs. An internal
    // NLB's DNS name resolves fine from anywhere (it is published to
    // public DNS), but the returned IPs are VPC-private — the Chime VC
    // cannot actually deliver SIP INVITEs to them.
    //
    // Security posture is unchanged: the task backends stay in private
    // subnets, the NLB security group ingress is restricted to the SIP
    // and RTP ports, and the tasks never have public IPs. Only the NLB
    // listeners are reachable from the public internet (on the two port
    // ranges), which is the standard SIP trunking topology.
    const nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      loadBalancerName: cdk.Fn.sub('${P}-sip-gateway-nlb', { P: prefix }),
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // r7 (design §21 step 8): NLB is TCP-only now, so cross-zone is
      // back to `true`. Under r6 (post-commit `abc268f`) we ran with
      // cross-zone `false` to bound the UDP flow-hash damage to a
      // single AZ; that constraint is relaxed in r7 because the NLB
      // no longer handles media. TCP flow-hashing across AZs is fine
      // — SIP signaling is short-lived connections and NLB picks a
      // target once per connection.
      crossZoneEnabled: true,
      securityGroups: [nlbSg],
    });

    // TCP/5060 target group + listener
    const sipTg = new elbv2.NetworkTargetGroup(this, 'SipTg', {
      targetGroupName: cdk.Fn.sub('${P}-sip-gateway-sip', { P: prefix }),
      vpc,
      port: 5060,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      preserveClientIp: false, // Chime VC sources are already AWS-internal
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '5060',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    nlb.addListener('SipListener', {
      port: 5060,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [sipTg],
    });

    // ───────────── r7: media path bypasses the NLB entirely ─────────────
    //
    // Under r7 (design §19) the NLB is SIP-only. Fargate tasks have
    // auto-assigned public IPs and advertise their own IP in the SDP
    // `c=` line, so Chime Voice Connector sends RTP directly to each
    // task's public IP on UDP 16000-16048. The Node bridge binds the
    // socket on `0.0.0.0:<rtpPort>` per call.
    //
    // Resources removed in r7 task 11.10:
    //   • 49 × AWS::ELBv2::TargetGroup (UDP ports 16000-16048)
    //   • 49 × AWS::ELBv2::Listener (NLB UDP listeners)
    //   • AWS::Lambda::Function `${prefix}-rtp-target-registrar`
    //   • AWS::Events::Rule `${prefix}-rtp-target-registrar-rule`
    //   • Associated IAM (elasticloadbalancing:Describe/Register/Deregister)
    //   • SG rules: taskSg UDP-from-nlbSg ingress, nlbSg UDP-to-taskSg egress
    //
    // See commit history + design §21 for the staged cutover that
    // preceded this removal (tasks 11.1-11.9 landed before this change).

    // ───────────── Fargate service ─────────────
    //
    // Note: we attach the SIP target group via the standard ECS
    // loadBalancers slot.  The 49 RTP target groups have their targets
    // registered by the RTP target-registrar Lambda below (ECS doesn't
    // support attaching 50 target groups to a single service, and each
    // RTP target group has a different port anyway).  The registrar
    // subscribes to `ECS Task State Change` events on the default
    // EventBridge bus and (de)registers task ENIs against each RTP
    // target group on task lifecycle transitions.
    const service = new ecs.FargateService(this, 'SipGatewayService', {
      serviceName: cdk.Fn.sub('${P}-sip-gateway', { P: prefix }),
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2, // matches autoscaling minimum
      // r7 (design §19 / task 11.2): tasks live in PUBLIC subnets with
      // auto-assigned public IPs so Chime can send RTP directly to
      // each task's own public IP. The task SG remains the perimeter
      // defense — under r7 it MUST only allow UDP 16000-16048 from
      // the pinned Chime VC CIDRs (R27) and TCP 5060 from the NLB SG
      // (R28). Synth-time assertions in `test/sip-gateway-stack.test.ts`
      // fail the deploy if either invariant drifts.
      //
      // (r6 legacy, kept as a commit-history marker:
      //  assignPublicIp: false + `vpcSubnets: { subnets: vpc.privateSubnets }`
      //  routed RTP via NLB UDP listeners. That layout flow-hashed UDP
      //  independently of SIP, causing cross-task RTP misroutes — see
      //  commit abc268f for the cross-zone-off interim fix and design
      //  §19.1 for the full rationale.)
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      // Expanded grace period so we have time to `aws ecs execute-command`
      // into a freshly started task for diagnostics before NLB health
      // check failures cause ECS to replace it. Trim back to 60s once
      // the SIP plane is proven stable.
      healthCheckGracePeriod: cdk.Duration.seconds(600),
      // Wait for the build trigger so the image exists before tasks try to pull.
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      // ECS Exec lets us `aws ecs execute-command` into a running task for
      // on-demand diagnostics (ss, netstat, tcpdump). Safe because the
      // feature uses AWS Systems Manager Session Manager (no public port
      // exposure), the task role grants only the minimum scoped privileges,
      // and ingress on the exec channel is SigV4-authed by IAM.
      enableExecuteCommand: true,
    });

    service.node.addDependency(buildTrigger);
    service.attachToNetworkTargetGroup(sipTg);

    // Now that we have the NLB DNS, inject it into the container env. The
    // drachtio entrypoint uses the ENI IP directly for the SIP contact and
    // rtpengine bind (resolved from the ECS Container Metadata V4 endpoint),
    // so SIP_EXT_HOST / RTP_EXT_HOST are not actually consumed in the
    // drachtio path. We leave them set for observability / audit and in
    // case future dialplan code wants the public-facing DNS.
    //
    // DRACHTIO_SECRET is sourced from AWS Secrets Manager, not from a
    // plain environment variable. The task definition references the
    // secret ARN via the `Secrets:` property; ECS resolves the
    // reference at task start using the execution role's
    // `secretsmanager:GetSecretValue` permission, and exposes the
    // resolved value to the container as the `DRACHTIO_SECRET`
    // environment variable. The secret value never appears in the task
    // definition, in CloudFormation events, or in any log line — only
    // the secret ARN does.
    const cfnTaskDef = taskDef.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride(
      'ContainerDefinitions.0.Environment',
      [
        { Name: 'DEPLOYMENT_PREFIX', Value: prefix },
        { Name: 'AGENT_RUNTIME_ARN', Value: agentRuntimeArn.valueAsString },
        { Name: 'AGENT_VOICE_ID', Value: agentVoiceId.valueAsString },
        {
          Name: 'CALL_LIFETIME_SECONDS',
          Value: callLifetimeSeconds.valueAsString,
        },
        { Name: 'AWS_REGION', Value: cdk.Aws.REGION },
        { Name: 'ENABLE_CLOUDWATCH_METRICS', Value: 'true' },
        { Name: 'SIP_EXT_HOST', Value: nlb.loadBalancerDnsName },
        { Name: 'RTP_EXT_HOST', Value: nlb.loadBalancerDnsName },
      ],
    );
    cfnTaskDef.addPropertyOverride('ContainerDefinitions.0.Secrets', [
      {
        Name: 'DRACHTIO_SECRET',
        ValueFrom: drachtioSecret.secretArn,
      },
    ]);

    // ───────────── r7: no RTP target-registrar needed ─────────────
    //
    // Under r6 the `${prefix}-rtp-target-registrar` Lambda listened on
    // `ECS Task State Change` events and (de)registered each task's
    // private IP against all 49 RTP target groups. Under r7 the NLB no
    // longer proxies RTP at all — Chime sends media directly to each
    // task's public IP — so the Lambda + its EventBridge rule + its
    // IAM are deleted (task 11.10).

    // ───────────── Autoscaling on ActiveCalls metric ─────────────
    //
    // Custom metric name `${prefix}/SipGateway/ActiveCalls` published every
    // 30 s by the cloudwatch-metrics.js module inside each drachtio SIP gateway task.
    // Target-tracking on an average-per-task value means the policy scales
    // up when avg(ActiveCalls) > 6 across the service and scales down when
    // avg < 6.
    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: maxTasksPerService.valueAsNumber,
    });

    // Target-tracking on a CUSTOMIZED metric (the L2 target-tracking helper
    // below accepts `Metric` objects directly).
    scalableTarget.scaleToTrackCustomMetric('ActiveCallsTracking', {
      metric: new cdk.aws_cloudwatch.Metric({
        namespace: cdk.Fn.sub('${P}/SipGateway', { P: prefix }),
        metricName: 'ActiveCalls',
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
        // The sidecar emits one data point per task per 30s; the service-wide
        // autoscaling target tracks the average across tasks.
      }),
      targetValue: 6,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    // ───────────── Outputs (no exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: nlb.loadBalancerDnsName,
      description:
        'Internal NLB DNS name. Consumed by ${prefix}-IngressStack as the Chime Voice Connector origination-route host (task 10.7).',
    });

    new cdk.CfnOutput(this, 'NlbHostedZoneId', {
      value: nlb.loadBalancerCanonicalHostedZoneId,
      description:
        'NLB hosted zone id — optional for downstream Route53 alias records.',
    });

    new cdk.CfnOutput(this, 'SipGatewayEcrRepoUri', {
      value: imageRepo.repositoryUri,
      description:
        'ECR repository URI for the drachtio SIP gateway image. Operator observability only.',
    });

    new cdk.CfnOutput(this, 'BuildWaiterArn', {
      value: waiterFn.functionArn,
      description:
        'ARN of the build-waiter Lambda. Reserved for downstream DependsOn handles (e.g. a future target-registrar stack).',
    });

    new cdk.CfnOutput(this, 'SipGatewayServiceName', {
      value: service.serviceName,
      description: 'Fargate service name — operator observability.',
    });

    new cdk.CfnOutput(this, 'SipGatewayClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name — operator observability.',
    });

    // ───────────── Per-construct cdk-nag suppressions ─────────────

    // drachtio admin secret — rotation deliberately not scheduled.
    // The secret protects only an in-task loopback socket on TCP/9022;
    // the task SG has no ingress rule on 9022 from any source. Rotating
    // the secret would force a task restart with no marginal security
    // benefit (no external attacker can reach the socket regardless
    // of the secret value). If the threat model evolves to expose the
    // admin port, schedule rotation via Secret.addRotationSchedule.
    NagSuppressions.addResourceSuppressions(drachtioSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'The secret protects an in-task loopback socket (drachtio admin TCP/9022) that has no SG ingress from outside the container. Rotation provides no incremental security benefit while the loopback-only posture holds.',
      },
    ]);

    // Source bucket access logging — same rationale as tel-agent-build.
    NagSuppressions.addResourceSuppressions(sourceBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Source bucket holds a zipped snapshot of the committed drachtio-sip-gateway/ source tree (<1 MiB, 30-day versioning). All ingestion is traceable via git + BucketDeployment CloudWatch logs. Access logging adds a second bucket + noise for no audit benefit.',
      },
    ]);

    // Task role residual wildcards.
    NagSuppressions.addResourceSuppressions(
      taskRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData is already scoped by a StringEquals condition on cloudwatch:namespace = ${prefix}/SipGateway (the only wildcard on this role). AWS IAM for PutMetricData does not support resource-level ARNs — namespace conditioning is the documented least-privilege pattern.',
        },
      ],
      true,
    );

    // Exec role uses the AWS-managed AmazonECSTaskExecutionRolePolicy.  This
    // is the standard pattern documented by ECS and is equivalent to a
    // hand-rolled policy for ecr:GetAuthorizationToken + ecr pull APIs +
    // logs:CreateLogStream + logs:PutLogEvents on this task's log group.
    NagSuppressions.addResourceSuppressions(
      executionRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AmazonECSTaskExecutionRolePolicy is the AWS-recommended managed policy for Fargate execution roles (ECR pull + CloudWatch Logs). Hand-rolling this set of permissions offers no security improvement; the role trust policy is scoped to ecs-tasks.amazonaws.com so only this cluster can assume it.',
        },
      ],
      true,
    );

    // Build role residual wildcards (ecr:GetAuthorizationToken).
    NagSuppressions.addResourceSuppressions(
      buildRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken is an account-scoped API that does not support resource-level IAM; the CodeBuild role uses it to obtain temporary creds for `docker login` against this prefix\'s image repo. All other ECR actions are scoped to the repo ARN.',
        },
      ],
      true,
    );

    // Waiter Lambda — default managed policy for CloudWatch Logs.
    NagSuppressions.addResourceSuppressions(
      [waiterFn, waiterIsCompleteFn],
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'The NodejsFunction default execution role includes AWSLambdaBasicExecutionRole for writing to its own log group. CodeBuild StartBuild/BatchGetBuilds permissions are added separately and are scoped to this stack\'s single project ARN.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AWSLambdaBasicExecutionRole contains wildcards scoped to the function\'s own log group — these are operational, not destructive, and standard practice for CDK-created Lambdas.',
        },
      ],
      true,
    );

    // NLB + target groups — no access logs configured.  S3 access logs on an
    // NLB add a second bucket + CloudWatch noise; Chime VC + call-data
    // traffic is already traceable via VPC Flow Logs (which the operator
    // enables separately at the VPC level) and the CloudWatch custom
    // ActiveCalls metric.
    NagSuppressions.addResourceSuppressions(
      nlb,
      [
        {
          id: 'AwsSolutions-ELB2',
          reason:
            'NLB access logs add a second S3 bucket + CloudWatch noise for marginal audit value. The SIP + RTP traffic is already traceable via VPC Flow Logs (operator-enabled at the VPC level) plus the CloudWatch custom `ActiveCalls` metric emitted per-task. Access logs don\'t capture UDP anyway, so they\'d only cover the TCP SIP path.',
        },
      ],
      true,
    );

    // Suppress unused-parameter warnings during synth.  VpcId is already
    // consumed via ec2.Vpc.fromVpcAttributes; touch it here so the
    // CfnParameter renders in the template with Ref.
    void vpcId;
  }
}
