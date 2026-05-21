import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { buildspec } from './buildspec';

/**
 * {prefix}-AgentBuildStack — source bucket, ARM64 CodeBuild project, and a
 * custom-resource build waiter that blocks the stack on build completion.
 *
 * Per design §3(#5), §9.2, §13 F7 and tasks.md task 4:
 * 1. Source S3 bucket `{prefix}-agent-source-{account}-{region}` holds a zip
 *    of the `agent/` directory uploaded by `BucketDeployment`.
 * 2. CodeBuild project `{prefix}-agent-build` runs the
 *    `LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0` image in privileged mode
 *    (Docker-in-Docker) against the committed buildspec — which runs the
 *    reproducibility gate (NFR3 / P8), then `docker buildx --platform=linux/arm64`,
 *    then `docker push`.
 * 3. Custom-resource `AwsCustomResource` / Provider pair starts the build on
 *    stack create/update and waits for `SUCCEEDED`. Non-SUCCEEDED fails the
 *    stack with a link to the CodeBuild log stream.
 *
 * Wiring (r4 pattern — design §4.4, §4.5):
 * - INPUTS: `DeploymentPrefix`, `AgentEcrRepoUri`, `AgentEcrRepoArn` —
 *   all three CfnParameters. The first is threaded from the top-level
 *   --deploymentPrefix flag; the latter two are threaded by scripts/deploy-all.sh
 *   from cdk-outputs/tel-agent-ecr.json.
 * - OUTPUTS: `AgentCodeBuildProjectName`, `AgentCodeBuildProjectArn`,
 *   `AgentSourceBucketName`, `BuildWaiterArn` — all WITHOUT `exportName`.
 *   `BuildWaiterArn` is consumed by tel-agent-runtime (task 5) so the runtime
 *   CfnRuntime cannot be created until the image push is complete. The other
 *   three are emitted for operator observability (not downstream-consumed).
 */
export class AgentBuildStack extends cdk.Stack {
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

    const agentEcrRepoUri = new cdk.CfnParameter(this, 'AgentEcrRepoUri', {
      type: 'String',
      minLength: 1,
      description:
        'ECR repo URI from tel-agent-ecr (threaded by scripts/deploy-all.sh from cdk-outputs/tel-agent-ecr.json)',
    });

    const agentEcrRepoArn = new cdk.CfnParameter(this, 'AgentEcrRepoArn', {
      type: 'String',
      minLength: 1,
      description:
        'ECR repo ARN from tel-agent-ecr — used to scope the CodeBuild push policy',
    });

    // ───────────── Source S3 bucket ─────────────
    // Bucket name is constructed from the prefix + account + region. Using
    // Aws.ACCOUNT_ID / Aws.REGION means the name renders at deploy time (no
    // synth-time account boundary crossing needed).
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: cdk.Fn.sub('${P}-agent-source-${A}-${R}', {
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

    // Upload agent/ source tree to the bucket under `agent-source/`. The CDK
    // BucketDeployment helper packs the directory into a zip and uploads
    // (creating one new version of the zip per deploy). CodeBuild pulls the
    // latest version as its primary source.
    //
    // The relative path walks up from `backend/agentcore-runtime-telephony/cdk/build/lib/`
    // four levels to `backend/agentcore-runtime-telephony/` then down into `agent/`.
    const deployment = new s3deploy.BucketDeployment(this, 'AgentSourceDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../..', 'agent'))],
      destinationBucket: sourceBucket,
      destinationKeyPrefix: 'agent-source',
      // Keep old versions so a rollback can reference a prior source tree.
      retainOnDelete: false,
      // 1 GiB memory is plenty for a <5 MiB source tree; keep ephemeral storage small.
      memoryLimit: 512,
    });

    // ───────────── CodeBuild project role ─────────────
    // Hand-rolled role so cdk-nag can see the scoped permissions.
    const buildRole = new iam.Role(this, 'BuildRole', {
      roleName: cdk.Fn.sub('${P}-agent-build-role', { P: prefix }),
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        'Role assumed by the CodeBuild project that builds the telephony agent image.',
    });

    // CloudWatch Logs — CodeBuild uses /aws/codebuild/<projectName>.
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          cdk.Fn.sub('arn:aws:logs:${R}:${A}:log-group:/aws/codebuild/*', {
            R: cdk.Aws.REGION,
            A: cdk.Aws.ACCOUNT_ID,
          }),
        ],
      }),
    );

    // ECR login (account-scoped API; service doesn't support resource IAM).
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // ECR push, scoped to THIS prefix's repo via the ARN CfnParameter (NFR12).
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: [agentEcrRepoArn.valueAsString],
      }),
    );

    // Source bucket read — scoped to the source bucket only.
    sourceBucket.grantRead(buildRole, 'agent-source/*');

    // ───────────── CodeBuild project ─────────────
    const project = new codebuild.Project(this, 'AgentBuild', {
      projectName: cdk.Fn.sub('${P}-agent-build', { P: prefix }),
      role: buildRole,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'agent-source/', // BucketDeployment writes a zip here.
      }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true, // Docker-in-Docker for `docker buildx`.
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: {
            value: agentEcrRepoUri.valueAsString,
          },
          AWS_ACCOUNT_ID: {
            value: cdk.Aws.ACCOUNT_ID,
          },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject(buildspec),
      timeout: cdk.Duration.minutes(45),
      // Explicit log group — gives us predictable ARN patterns and lifecycle
      // under operator control.
      logging: {
        cloudWatch: {
          enabled: true,
          logGroup: new logs.LogGroup(this, 'BuildLogGroup', {
            logGroupName: cdk.Fn.sub('/aws/codebuild/${P}-agent-build', { P: prefix }),
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    // CodeBuild requires source + deployment to be staged before the first build.
    project.node.addDependency(deployment);

    // ───────────── Build waiter custom resource ─────────────
    // One bundled Lambda serves both `onEvent` (StartBuild) and `isComplete`
    // (BatchGetBuilds poll). Provider framework drives the 30s polling cadence.
    const waiterHandlerEntry = path.join(
      __dirname,
      '..',
      'lambda',
      'build-waiter',
      'handler.ts',
    );

    const waiterLogGroup = new logs.LogGroup(this, 'BuildWaiterLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-agent-build-waiter', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const waiterIsCompleteLogGroup = new logs.LogGroup(this, 'BuildWaiterIsCompleteLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-agent-build-waiter-check', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Note: NO explicit logGroupName on the cr.Provider's framework log
    // group — see runtime-stack.ts pepper provider for the same
    // rationale. Setting an explicit `/aws/lambda/<name>` collides with
    // AWS Lambda's last-invocation lazy-create during stack destroy and
    // leaves an orphan that blocks the next deploy.
    const providerFrameworkLogGroup = new logs.LogGroup(this, 'BuildWaiterProviderFrameworkLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const waiterFn = new NodejsFunction(this, 'BuildWaiterFn', {
      functionName: cdk.Fn.sub('${P}-agent-build-waiter', { P: prefix }),
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
        // @aws-sdk/client-codebuild is bundled explicitly because the Node 24
        // Lambda runtime ships only @aws-sdk/* v3 on-demand; explicit bundle
        // cuts the cold-start.
        externalModules: ['@aws-sdk/*'],
      },
      logGroup: waiterLogGroup,
    });

    // Separate isComplete handler in the same bundle.
    const waiterIsCompleteFn = new NodejsFunction(this, 'BuildWaiterIsCompleteFn', {
      functionName: cdk.Fn.sub('${P}-agent-build-waiter-check', { P: prefix }),
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

    // Permissions for the waiter Lambda(s): start + describe this project only.
    const projectArn = cdk.Fn.sub(
      'arn:aws:codebuild:${R}:${A}:project/${P}-agent-build',
      { R: cdk.Aws.REGION, A: cdk.Aws.ACCOUNT_ID, P: prefix },
    );
    const projectPolicy = new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [projectArn],
    });
    waiterFn.addToRolePolicy(projectPolicy);
    waiterIsCompleteFn.addToRolePolicy(projectPolicy);

    const provider = new cr.Provider(this, 'BuildWaiterProvider', {
      onEventHandler: waiterFn,
      isCompleteHandler: waiterIsCompleteFn,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(60),
      providerFunctionEnvEncryption: undefined,
      logGroup: providerFrameworkLogGroup,
    });

    // The custom resource that "runs" the build on every stack create/update.
    // `TriggerHash` cache-buster forces CFN to re-invoke `onEvent` when the
    // CodeBuild project's project-name or the source deployment's source-hash
    // changes, which ensures a rebuild whenever the agent source tree does.
    const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: project.projectName,
        // deployedObjectKeys changes whenever BucketDeployment sees new content,
        // so it serves as a natural cache-buster.
        TriggerHash: cdk.Fn.join(',', deployment.objectKeys),
      },
    });

    // Custom resource depends on the project existing AND on the source zip
    // being in place. Without this, the first invocation can race the source
    // upload.
    buildTrigger.node.addDependency(project);
    buildTrigger.node.addDependency(deployment);

    // ───────────── Outputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'AgentCodeBuildProjectName', {
      value: project.projectName,
      description:
        'CodeBuild project name — emitted for operator observability (not consumed downstream)',
    });

    new cdk.CfnOutput(this, 'AgentCodeBuildProjectArn', {
      value: project.projectArn,
      description:
        'CodeBuild project ARN — emitted for operator observability',
    });

    new cdk.CfnOutput(this, 'AgentSourceBucketName', {
      value: sourceBucket.bucketName,
      description:
        'S3 bucket holding the zipped agent source tree — observability only',
    });

    new cdk.CfnOutput(this, 'BuildWaiterArn', {
      value: waiterFn.functionArn,
      description:
        'ARN of the build-waiter Lambda — consumed by tel-agent-runtime so CfnRuntime waits for the image push to complete before creation',
    });

    // ───────────── Per-construct cdk-nag suppressions ─────────────
    // Stack-level suppressions don't cascade to child constructs; each
    // suppression below is attached to the specific resource that raises it.
    // Written justification per NFR13.
    //
    // S3 access logs: the source bucket holds only a zipped snapshot of the
    // committed `agent/` source tree (<5 MiB, versioned 30 days). Access
    // logging would create a second bucket plus access-log noise for
    // negligible audit value — all ingestion is traceable via git + the
    // BucketDeployment CloudWatch log stream.
    NagSuppressions.addResourceSuppressions(sourceBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Source bucket holds a zipped snapshot of the committed agent/ source tree (<5 MiB, 30-day versioning). All ingestion is traceable via git + BucketDeployment CloudWatch logs. Access logging adds a second bucket + noise for no audit benefit.',
      },
    ]);
  }
}
