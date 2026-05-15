#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { IngressNumberStack } from '../lib/ingress-number-stack';

const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

const stack = new IngressNumberStack(app, 'IngressNumberStack', {
  env: { region: 'us-east-1' },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Stack-level suppression for the library-owned custom-resource Lambdas that
// `cdk-amazon-chime-resources` uses to provision the Chime phone number.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      '`cdk-amazon-chime-resources` v3 attaches AWSLambdaBasicExecutionRole to its internal custom-resource Lambdas that provision Chime PhoneNumber. Library-managed, not user-modifiable.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      '`cdk-amazon-chime-resources` v3 internal custom-resource Lambdas need broad `chime-sdk-voice:*` / `chime:*` permissions to search inventory and place phone-number orders (no per-resource IAM exists for these APIs). Library-managed, not user-modifiable.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      '`cdk-amazon-chime-resources` v3 internal custom-resource Lambdas pin a specific Node runtime; upgrade comes via a library version bump.',
  },
]);
