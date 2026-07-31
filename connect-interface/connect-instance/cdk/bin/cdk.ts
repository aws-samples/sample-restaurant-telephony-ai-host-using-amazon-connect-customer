#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ConnectInstanceStack } from '../lib/connect-instance-stack';

/**
 * ${prefix}-ConnectInstanceStack
 *
 * Deploys a fresh Amazon Connect instance with Connect Customer (AI capabilities)
 * enabled, plus the Q in Connect Assistant required for AI Agents.
 *
 * Stack outputs flow to cn-ai-agent and cn-telephony via cdk-outputs/cn-instance.json.
 */
const app = new cdk.App();

cdk.Tags.of(app).add('auto-delete', 'no');
cdk.Tags.of(app).add('Project', 'restaurant-connect-ai-host');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

const stack = new ConnectInstanceStack(app, 'ConnectInstanceStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description:
    'Amazon Connect instance with Connect Customer AI capabilities and Q in Connect Assistant',
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole attached to custom-resource Lambdas for CloudWatch Logs write — minimal-privilege managed policy, CDK-managed.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Custom-resource Lambdas need connect:* and wisdom:* to manage Connect Customer enablement and Q in Connect Assistant lifecycle. These APIs do not support resource-level IAM. Scoped to account + region via execution role.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'Custom-resource Lambdas pin nodejs24.x (current LTS). CDK Provider framework internals are CDK-managed.',
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Provider framework state machine is CDK-managed, deploy-time only.',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'Provider framework state machine X-Ray is CDK-managed, deploy-time only.',
  },
]);
