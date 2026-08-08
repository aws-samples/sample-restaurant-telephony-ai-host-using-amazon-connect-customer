#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { LocationStack } from '../lib/location-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ApiGatewayStack } from '../lib/api-gateway-stack';

/**
 * Single CDK app, four independent stacks. Deployed per-stack via
 * `cdk deploy <StackId>` from scripts/deploy-all.sh. Each stack takes every
 * cross-stack value through its own `CfnParameter`s. There are deliberately
 * no shared construct references between stacks (no
 * `new LambdaStack(app, ..., { tables: dynamoDBStack.tables })`), so any one
 * stack can be deployed or redeployed on its own.
 *
 * Stack IDs are un-prefixed here (the construct id is the template's
 * logical id). The CloudFormation stack name at deploy time is prefixed
 * by scripts/deploy-all.sh via `cdk deploy ${prefix}-DynamoDBStack` etc.
 * The `DeploymentPrefix` CfnParameter on each stack controls the physical
 * resource names inside the template.
 *
 * `addDependency` calls ARE expressed here so the single `cdk synth` from
 * a developer workstation respects the right ordering; at deploy time each
 * stack is deployed independently and the script already runs them in
 * DAG order, so these same dependencies are a redundant belt-and-braces.
 */

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const dynamoDBStack = new DynamoDBStack(app, 'DynamoDBStack', {
  env,
  description:
    'DynamoDB tables for customers, orders, menu, carts, and locations',
});

const locationStack = new LocationStack(app, 'LocationStack', {
  env,
  description:
    'AWS Location Service place-index + route-calculator for QSR geocoding and routing',
});

const lambdaStack = new LambdaStack(app, 'LambdaStack', {
  env,
  description:
    'Ten ordering Lambdas (customer / menu / cart / order / location).',
});

const apiGatewayStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  description:
    'REST API Gateway with Lambda integrations and AWS_IAM authorization',
});

// DependsOn hints — useful if the four stacks are ever deployed from a
// single `cdk deploy --all` invocation. The production path (scripts/deploy-all.sh)
// deploys them one-by-one in this same order.
lambdaStack.addDependency(dynamoDBStack);
lambdaStack.addDependency(locationStack);
apiGatewayStack.addDependency(lambdaStack);

// Global tags.
cdk.Tags.of(app).add('Project', 'telephony-voice-ordering-agent');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
// Reaper-opt-out tag: some account-level auto-delete sweepers treat the
// absence of this tag as implicit consent to delete.
cdk.Tags.of(app).add('auto-delete', 'no');

// cdk-nag aspect (AwsSolutions-*). Per-stack + per-resource suppressions
// live inside each stack file; the framework-level suppressions that apply
// to all four stacks live here.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

for (const stack of [
  dynamoDBStack,
  locationStack,
  lambdaStack,
  apiGatewayStack,
]) {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        "AWSLambdaBasicExecutionRole is an AWS-managed policy that grants CloudWatch Logs put/create only. Each Lambda's data-layer access is scoped separately via explicit DynamoDB and Location Service grants.",
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Wildcards are scoped to specific ARNs interpolated from the DeploymentPrefix CfnParameter (DynamoDB table ARNs, Location place-index and route-calculator ARNs). Actions are scoped per function, for example geo:SearchPlaceIndexForPosition and dynamodb:BatchGetItem.',
    },
    {
      id: 'AwsSolutions-APIG2',
      reason:
        "Each Lambda handler performs its own body validation: place-order validates customerId and locationId plus the order body fields, add-to-cart validates the items array, and so on. API Gateway models already cover the add-to-cart and place-order body shapes, so an additional request validator would be redundant in this sample.",
    },
  ]);
}
