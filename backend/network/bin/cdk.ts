#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { NetworkStack } from '../lib/network-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'NetworkStack'; the CloudFormation stack name is set
// at deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-NetworkStack`.
// The DeploymentPrefix CfnParameter (declared in the stack) is also passed at
// that time via --parameters — not via context.
const stack = new NetworkStack(app, 'NetworkStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── cdk-nag suppressions (with written justification) ─────────────
//
// AwsSolutions-VPC7 — "VPC has Flow Logs enabled": not required for this MVP.
// The agent traffic is Bedrock/KVS/S3/Chime over public service endpoints via
// NAT, all of which are logged by the services themselves (CloudTrail,
// service-level access logs). Re-enable flow logs when a compliance reviewer
// asks for network-layer forensics — cost ~$10/month per GB ingested.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-VPC7',
    reason:
      'VPC Flow Logs not enabled for MVP. Agent-facing traffic is service-API via NAT — CloudTrail + per-service access logs cover forensics. Revisit when a compliance reviewer requires network-layer logging.',
  },
]);
