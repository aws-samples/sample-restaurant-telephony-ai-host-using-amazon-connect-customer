#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ConnectInstanceStack } from '../lib/connect-instance-stack';

/**
 * ${prefix}-ConnectInstanceStack
 *
 * Deploys a fresh Amazon Connect instance with Connect Customer (AI capabilities)
 * enabled, plus the Amazon Connect AI Agents assistant that the AI Agent needs.
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
    'Amazon Connect instance with Connect Customer AI capabilities and the Amazon Connect AI Agents assistant',
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
      'Custom-resource Lambdas need connect:* and wisdom:* to manage Connect Customer enablement and the Amazon Connect AI Agents assistant lifecycle. These APIs do not support resource-level IAM. Scoped to account and region via the execution role.',
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
