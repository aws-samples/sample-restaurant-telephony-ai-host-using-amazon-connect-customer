#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { SipGatewayStack } from '../lib/sip-gateway-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'SipGatewayStack'; CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-SipGatewayStack`.
const stack = new SipGatewayStack(app, 'SipGatewayStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── cdk-nag suppressions (with written justification) ─────────────
//
// Each suppression below covers a finding that arises from a legitimate and
// unavoidable pattern in this stack. No finding is silenced without reason.
// Per-resource suppressions with narrower justifications are added alongside
// their resources in sip-gateway-stack.ts.
NagSuppressions.addStackSuppressions(stack, [
  // AwsSolutions-CB3 — CodeBuild privileged mode. Required for `docker buildx`
  // inside the build container (DinD); no non-privileged equivalent exists.
  {
    id: 'AwsSolutions-CB3',
    reason:
      'CodeBuild privileged mode is required for docker buildx inside the build container — the project is the single path that builds and pushes the ARM64 SIP gateway image. No non-privileged alternative exists for DinD on CodeBuild.',
  },
  // AwsSolutions-CB4 — CodeBuild KMS key. Same rationale as tel-agent-build.
  {
    id: 'AwsSolutions-CB4',
    reason:
      'CodeBuild project uses the AWS-managed standard image without a customer-managed KMS key. The build output is a container image published to a private ECR repo; no sensitive data crosses the build environment. Customer-managed KMS adds key-rotation overhead without a data-at-rest benefit for this workload.',
  },
  // AwsSolutions-IAM4 — AWS-managed policies.
  // Provider framework auto-attaches AWSLambdaBasicExecutionRole; Fargate
  // execution role uses AmazonECSTaskExecutionRolePolicy (the AWS-recommended
  // pattern).
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole attaches to the Provider framework and NodejsFunction waiter Lambdas (CDK-managed, minimal privilege — just CloudWatch Logs). AmazonECSTaskExecutionRolePolicy is the AWS-recommended managed policy for the Fargate execution role (ECR pull + log write).',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    ],
  },
  // AwsSolutions-IAM5 — residual wildcards.
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Residual wildcards: (a) ecr:GetAuthorizationToken is account-scoped by AWS - no resource-level IAM; (b) cloudwatch:PutMetricData is namespace-conditioned; (c) BucketDeployment internal Lambda needs s3:* on CDK staging bucket (managed by CDK); (d) logs:* targets /aws/codebuild/<projectName>:* and /aws/lambda/<fnName>:* log streams (prefix-scoped); (e) bedrock-agentcore:InvokeAgentRuntime on ${Arn}/runtime-endpoint/* is the data-plane-authorized shape documented by AWS; (f) elasticloadbalancing:DescribeTargetGroups + DescribeTags are account-scoped discovery APIs that the service does not support resource-level IAM for - the RTP target registrar Lambda uses them to discover our tagged target groups at cold start (the mutating RegisterTargets/DeregisterTargets grants ARE ARN-scoped). None of these leak privileges beyond this stack\'s workload.',
  },
  // AwsSolutions-L1 — latest Lambda runtime.
  {
    id: 'AwsSolutions-L1',
    reason:
      'Our NodejsFunctions pin Runtime.NODEJS_24_X (latest AWS Lambda LTS, Apr 2026). BucketDeployment/Provider internal Lambdas are CDK-controlled; cdk-nag may flag them transiently as CDK updates the default; they are not user-modifiable.',
  },
  // AwsSolutions-SF1 / SF2 — framework-managed Step Function.
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
  // AwsSolutions-EC23 — NLB SG allows 0.0.0.0/0 on SIP + RTP ports.
  // Traffic reaching the NLB comes exclusively from the Chime Voice Connector,
  // which originates from AWS-internal source IPs that change over time (there
  // is no published static CIDR allowlist to pin). The NLB itself is in
  // private subnets, so an attacker with VPC access would be needed to reach
  // it — the 0.0.0.0/0 rule restricts the "reachable-from-inside-VPC"
  // universe, not the public internet.
  {
    id: 'AwsSolutions-EC23',
    reason:
      'NLB security group permits 0.0.0.0/0 on TCP/5060 and UDP/16000-16048. The NLB is internal (private subnets only) so the effective reachable surface is the VPC, not the public internet. Chime Voice Connector originating IPs are AWS-internal and not pinned via a public CIDR allowlist — restricting the SG to a static set would break origination. All task-level ingress is gated on the NLB SG (not 0.0.0.0/0) on the Fargate task SG.',
  },
  // AwsSolutions-ECS2 — container env vars in plaintext.
  // All env vars passed to the SIP gateway container are non-secret (deployment
  // prefix, Nova Sonic voice id, call duration, AgentCore Runtime ARN, NLB
  // DNS name, AWS_REGION). The SigV4 signing credentials come from the task
  // role at runtime (IMDS), never embedded in env.
  {
    id: 'AwsSolutions-ECS2',
    reason:
      'Container env vars are all non-secret (DeploymentPrefix, AgentRuntimeArn, AgentVoiceId, CallLifetimeSeconds, NLB DNS name, AWS_REGION, ENABLE_CLOUDWATCH_METRICS). AWS credentials for SigV4-signing the AgentCore WebSocket URL are obtained at runtime from the task role via IMDS, never from env. There is nothing in env that warrants the SSM Parameter Store / Secrets Manager indirection.',
  },
]);
