import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * {prefix}-AgentEcrStack — ECR repository that holds the agent container image.
 *
 * Per design §3(#4) and §9.2:
 * - One ECR repository named `{DeploymentPrefix}-agent`.
 * - `imageScanOnPush=true` to catch CVEs on every build.
 * - Lifecycle policy: keep the 10 most recent images (older ones are deleted).
 *
 * Wiring (r4 pattern — design §4.4, §4.5):
 * - INPUT:  `DeploymentPrefix` CfnParameter (threaded by scripts/deploy-all.sh).
 * - OUTPUTS: `AgentEcrRepoUri`, `AgentEcrRepoArn` — emitted WITHOUT `exportName`.
 *   scripts/deploy-all.sh reads them from cdk-outputs/tel-agent-ecr.json via
 *   json_val and passes them as --parameters to:
 *     - `{prefix}-AgentBuildStack` (both URI + ARN — the build role pushes here),
 *     - `{prefix}-AgentRuntimeStack` (URI only — the runtime pulls this image;
 *       the ARN is derived inside the runtime stack via Fn::Split on the URI).
 *
 * NOTE on removal policy: the repo uses `RemovalPolicy.DESTROY` +
 * `emptyOnDelete: true` to keep dev iteration loops simple - a failed
 * CodeBuild push would otherwise leave an orphaned repo that blocks
 * retries with `repository already exists`.  For PRODUCTION, flip to
 * RETAIN + `emptyOnDelete: false` so a stack teardown preserves shipped
 * images.  `cleanup-all.sh` handles explicit teardown either way.
 * Design §13.1 F7 covers the deploy-failure flow - this stack has no
 * runtime dependency on the image existing.
 */
export class AgentEcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameter: DeploymentPrefix ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // ───────────── ECR Repository ─────────────
    //
    // Removal policy DESTROY (not RETAIN) to align with the
    // "iterate-and-fail is cheap" posture of this reference project.  A
    // failed CodeBuild push would otherwise leave an orphaned repo that
    // blocks retries with `repository already exists`; emptyOnDelete
    // plus DESTROY lets iteration loops run freely.
    //
    // For PRODUCTION deployments where rollback history matters, flip
    // this back to RETAIN + emptyOnDelete=false so a stack teardown
    // preserves shipped images.  See README "Production hardening" for
    // the exact edit.
    const repo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: cdk.Fn.sub('${P}-agent', { P: prefix }),
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE, // `:latest` is overwritten each build
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

    // ───────────── Outputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'AgentEcrRepoUri', {
      value: repo.repositoryUri,
      description:
        'ECR repo URI — consumed by tel-agent-build (CodeBuild push) and tel-agent-runtime (CfnRuntime containerUri) via CfnParameter',
    });

    new cdk.CfnOutput(this, 'AgentEcrRepoArn', {
      value: repo.repositoryArn,
      description:
        'ECR repo ARN — consumed by tel-agent-build (CodeBuild role IAM scope) via CfnParameter',
    });
  }
}
