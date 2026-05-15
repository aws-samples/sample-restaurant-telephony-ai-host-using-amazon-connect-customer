#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AgentBuildStack } from '../lib/build-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'AgentBuildStack'; CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-AgentBuildStack`.
const stack = new AgentBuildStack(app, 'AgentBuildStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── cdk-nag suppressions (with written justification) ─────────────
//
// Each suppression below covers a finding that arises from a legitimate and
// unavoidable pattern in this stack. No finding is silenced without reason.

// AwsSolutions-CB3 — CodeBuild project has privileged mode enabled.
// Required for Docker-in-Docker (docker buildx inside the build container).
// AgentCore Runtime mandates ARM64 OCI images, and the project has to build
// and push those images itself — there is no equivalent non-privileged path.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-CB3',
    reason:
      'CodeBuild privileged mode is required for docker buildx inside the build container — the project is the single path that builds and pushes the ARM64 agent image. No non-privileged alternative exists for DinD on CodeBuild.',
  },
  {
    id: 'AwsSolutions-CB4',
    reason:
      'CodeBuild project uses the AWS-managed standard image without a customer-managed KMS key. The build output is a public-ECR image layer; no sensitive data crosses the build environment, and customer-managed KMS adds key-rotation overhead without a data-at-rest benefit for this workload.',
  },
  // AwsSolutions-IAM4 — Managed policy on a role.
  // The Provider framework auto-attaches AWSLambdaBasicExecutionRole to the
  // waiter Lambda's role. CDK does not expose a way to replace it with an
  // inline policy for Provider-managed functions. The managed policy grants
  // only basic logs permissions — no privilege escalation surface.
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole is attached by the CDK Provider framework to its framework Lambdas and to the NodejsFunction waiter. Policy grants only CloudWatch Logs put/create — minimal privilege, CDK-managed.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  // AwsSolutions-IAM5 — Wildcards in an IAM policy.
  // ecr:GetAuthorizationToken is account-scoped only — the service does not
  // support resource-level IAM for it. Same applies to the BucketDeployment
  // helper's internal s3:List* on the staging bucket and Lambda log-group
  // ARN patterns (logs:/aws/codebuild/* is already prefix-scoped to this
  // feature, but ":*" log-stream suffix is unavoidable for log-stream creation).
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Residual wildcards: (a) ecr:GetAuthorizationToken is account-scoped by AWS — no resource-level IAM; (b) BucketDeployment internal Lambda needs s3:* on CDK staging bucket (managed by CDK); (c) logs:* targets /aws/codebuild/<projectName>:* and /aws/lambda/<fnName>:* log streams (prefix-scoped). None of these leak privileges beyond this stack\'s workload.',
  },
  // AwsSolutions-L1 — Lambda runtime is latest supported.
  // BucketDeployment and the Provider framework pin their own internal Lambda
  // runtimes (CDK-controlled). Our own NodejsFunctions use nodejs24.x — the
  // latest LTS supported by Lambda as of April 2026 per design r2.
  {
    id: 'AwsSolutions-L1',
    reason:
      'Our NodejsFunctions pin Runtime.NODEJS_24_X (latest AWS Lambda LTS, Apr 2026). BucketDeployment/Provider internal Lambdas are CDK-controlled; cdk-nag may flag them transiently as CDK updates the default; they are not user-modifiable.',
  },
  // AwsSolutions-S1 — S3 bucket has server access logging disabled.
  // The source bucket only holds a zip of the agent source tree (5 MB) and
  // retains 30-day versioning. Access-logging adds a second bucket + noise;
  // the source tree is the committed repo. Revisit if a compliance reviewer
  // requires audit trails for source ingestion.
  // AwsSolutions-SF1 / SF2 — Provider framework's internal Step Function.
  // The CDK Provider uses a Step Function State Machine to drive the
  // isComplete polling. Its logging and X-Ray tracing are not configurable
  // by the user — the framework owns that state machine. Once the build
  // finishes, the state machine has no further purpose.
  {
    id: 'AwsSolutions-SF1',
    reason:
      'Provider framework state-machine is CDK-managed; its logging level is not user-configurable. The state machine runs only during stack create/update while the CodeBuild build is in flight, then becomes idle.',
  },
  {
    id: 'AwsSolutions-SF2',
    reason:
      'Provider framework state-machine X-Ray setting is CDK-managed; the waiter is a short-lived deploy-time resource with no steady-state traffic to trace.',
  },
]);
