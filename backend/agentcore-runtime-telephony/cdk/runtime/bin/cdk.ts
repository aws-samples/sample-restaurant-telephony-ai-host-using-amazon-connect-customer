#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AgentRuntimeStack } from '../lib/runtime-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'AgentRuntimeStack'; CloudFormation stack name is set at
// deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-AgentRuntimeStack`.
const stack = new AgentRuntimeStack(app, 'AgentRuntimeStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── cdk-nag suppressions (with written justification) ─────────────
// Each finding below is either CDK-framework-managed (Provider, BucketDeployment,
// NodejsFunction log-retention default) or an unavoidable service-scope
// wildcard documented in design §11.1.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole is attached by the CDK Provider framework to its framework Lambdas and by NodejsFunction to the pepper-manager. Policy grants only CloudWatch Logs put/create — minimal privilege, CDK-managed, not user-modifiable.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Residual wildcards: (a) CDK-managed Provider + NodejsFunction internals (s3:* on CDK staging bucket, ssm:* on the pepper parameter scoped to this prefix); (b) agent runtime role wildcards are scoped to AWS-mandated patterns (ecr:GetAuthorizationToken / xray:* / cloudwatch:PutMetricData are account-scoped by service; cloudwatch:PutMetricData is further conditioned on `cloudwatch:namespace` = `bedrock-agentcore`; bedrock: foundation-model/* is the Nova Sonic family pattern). r5-era Kinesis Video Streams + Chime SMA + S3 playback grants have been removed in r6 (Task 10.6). See runtime-stack.ts in-code comments.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Our NodejsFunction (pepper-manager) pins Runtime.NODEJS_24_X (Apr 2026 LTS). Provider internal Lambdas are CDK-controlled; cdk-nag may flag them transiently as CDK updates the default — they are not user-modifiable.',
  },
  {
    id: 'AwsSolutions-SF1',
    reason:
      'Provider framework state-machine is CDK-managed. The state machine runs only during stack create/update while the pepper SSM put is in flight (or a future pepper-rotation custom resource invocation), then becomes idle.',
  },
  {
    id: 'AwsSolutions-SF2',
    reason:
      'Provider framework state-machine X-Ray setting is CDK-managed; the pepper-manager waiter is a short-lived deploy-time resource with no steady-state traffic to trace.',
  },
]);
