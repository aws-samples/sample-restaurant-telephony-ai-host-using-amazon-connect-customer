#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ConnectAIAgentStack } from '../lib/connect-ai-agent-stack';

/**
 * ${prefix}-ConnectAIAgentStack
 *
 * Creates the Amazon Lex V2 bot (CfnBot with QInConnectIntent inline,
 * CfnBotVersion, CfnBotAlias), the AI Guardrail, and the ORCHESTRATION
 * AI Agent (CfnAIAgent). AwsCustomResource is used only where no L1
 * construct exists: system prompt ID lookup, MCP app registration, and
 * activating the agent on the assistant.
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
  description: 'Connect AI Agent - Lex bot with QInConnectIntent, AI Guardrail, and ORCHESTRATION AI Agent',
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

NagSuppressions.addStackSuppressions(stack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole on the AwsCustomResource framework Lambda. CDK-managed, grants CloudWatch Logs put/create only.' },
  { id: 'AwsSolutions-IAM5', reason: 'wisdom:* and polly:SynthesizeSpeech do not support resource-level IAM. AwsCustomResource policy uses ANY_RESOURCE as required by the SDK call framework.' },
  { id: 'AwsSolutions-L1', reason: 'AwsCustomResource internal Lambda runtime is CDK-managed.' },
]);
