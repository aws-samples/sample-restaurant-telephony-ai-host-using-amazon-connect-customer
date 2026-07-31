#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ConnectTelephonyStack } from '../lib/connect-telephony-stack';

const app = new cdk.App();

cdk.Tags.of(app).add('auto-delete', 'no');
cdk.Tags.of(app).add('Project', 'restaurant-connect-ai-host');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

const stack = new ConnectTelephonyStack(app, 'ConnectTelephonyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description:
    'Connect phone number + contact flow routing inbound calls to the restaurant AI agent',
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole on Provider framework internals — CDK-managed.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'No custom resource Lambdas in this stack. The contact flow content is static JSON.',
  },
]);
