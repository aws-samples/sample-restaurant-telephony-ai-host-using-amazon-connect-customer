#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { IngressStack } from '../lib/ingress-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'IngressStack'; the CloudFormation stack name is set
// at deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-IngressStack`.
const stack = new IngressStack(app, 'IngressStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── Stack-level cdk-nag suppressions ─────────────
// CDK-framework-managed findings that cascade across many constructs. Each
// entry carries a written justification. Per-construct suppressions live
// inside `lib/ingress-stack.ts`.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      '`cdk-amazon-chime-resources` v3 attaches AWSLambdaBasicExecutionRole to its internal custom-resource Lambdas that provision Chime VC / SMA / PhoneNumber / SipRule. Library-managed, not user-modifiable. The user-owned SMA handler role (`{prefix}-sma-lambda-role`) uses explicit least-privilege statements instead of the managed policy (design §11.2).',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Residual wildcards are either (a) unavoidable because the AWS service does not support resource-level IAM for the action (chime-sdk-voice:GetVoiceConnector, kinesisvideo:ListStreams), or (b) internal to library-managed Chime custom-resource Lambdas. User-owned wildcards are scoped to the `ChimeVoiceConnector-*` stream pattern or the account+region pair. See per-construct suppressions in lib/ingress-stack.ts for justification.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Our user-owned NodejsFunction pins Runtime.NODEJS_24_X (Apr 2026 LTS through Apr 2028). Library-managed internal Lambdas from cdk-amazon-chime-resources v3 pin their own runtime; upgrades flow through a library version bump.',
  },
]);
