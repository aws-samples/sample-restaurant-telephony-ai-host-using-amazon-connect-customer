#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ConnectAIAgentStack } from '../lib/connect-ai-agent-stack';

/**
 * ${prefix}-ConnectAIAgentStack
 *
 * Native CDK/CloudFormation only — no Lambda custom resources.
 * CfnBot with QInConnectIntent inline, CfnBotVersion, CfnBotAlias,
 * AwsCustomResource for system prompt ID lookup, CfnAIAgent.
 */
const app = new cdk.App();

cdk.Tags.of(app).add('auto-delete', 'no');
cdk.Tags.of(app).add('Project', 'restaurant-connect-ai-host');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

const stack = new ConnectAIAgentStack(app, 'ConnectAIAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Connect AI Agent — Lex bot with QInConnectIntent + SELF_SERVICE AI Agent',
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

NagSuppressions.addStackSuppressions(stack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole on AwsCustomResource framework Lambda — CDK-managed.' },
  { id: 'AwsSolutions-IAM5', reason: 'wisdom:* and polly:SynthesizeSpeech do not support resource-level IAM. AwsCustomResource policy uses ANY_RESOURCE as required by the SDK call framework.' },
  { id: 'AwsSolutions-L1', reason: 'AwsCustomResource internal Lambda runtime is CDK-managed.' },
]);
