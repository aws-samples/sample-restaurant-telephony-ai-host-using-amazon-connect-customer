#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentEcrStack } from '../lib/ecr-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

// Stack logical ID is 'AgentEcrStack'; the CloudFormation stack name is set
// at deploy time by scripts/deploy-all.sh via `cdk deploy ${prefix}-AgentEcrStack`.
// The DeploymentPrefix CfnParameter is also passed at that time via --parameters
// — not via context (r4 rule).
new AgentEcrStack(app, 'AgentEcrStack', {
  env: { region: 'us-east-1' },
});

// Apply cdk-nag AwsSolutions checks per NFR13.
// No suppressions needed for this stack — ECR with scan-on-push and lifecycle
// is fully compliant out of the box.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
