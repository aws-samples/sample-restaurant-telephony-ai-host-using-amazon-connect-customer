#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { CdkStack } from '../lib/cdk-stack';

/**
 * `${prefix}-AgentCoreGatewayStack` — the `AWS::BedrockAgentCore::Gateway`
 * (MCP + AWS_IAM) fronting the ordering REST API.
 *
 * Ported verbatim from `reference-project/backend/agentcore-gateway/cdk/bin/cdk.ts`.
 * Changes vs reference:
 *   • Reference's context-based `apiGatewayId` read is DELETED — a
 *     `CfnParameter` on the stack itself now carries every upstream identifier
 *     (`DeploymentPrefix`, `ApiGatewayId`, `ApiGatewayUrl`, `ApiGatewayRestApiId`).
 *     The `DeploymentPrefix` flows in via `parameters` (per NFR15, no context
 *     threading).
 *   • `env.region` pinned to `us-east-1` (ground truth §1.3).
 *   • `AwsSolutionsChecks` aspect + stack-level suppressions applied here per
 *     NFR13 / design §11.5b.
 *
 * Stack logical id `AgentCoreGatewayStack`; CloudFormation stack name is set at
 * deploy time by `scripts/deploy-all.sh` via `cdk deploy ${prefix}-AgentCoreGatewayStack`.
 */
const app = new cdk.App();

// Reaper-opt-out tag: the account-level auto-delete sweeper treats the
// absence of this tag as implicit consent to delete. Applied to every
// CDK app in this workspace — see working-agreements.md.
cdk.Tags.of(app).add('auto-delete', 'no');

const stack = new CdkStack(app, 'AgentCoreGatewayStack', {
  env: { region: 'us-east-1' },
  description:
    'AgentCore Gateway — MCP server (AWS_IAM authorizer) fronting the ordering REST API',
});

// Apply cdk-nag AwsSolutions checks per NFR13.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// ───────────── Stack-level cdk-nag suppressions ─────────────
// Each suppression is cascading (applies to all framework-managed constructs
// created downstream of the stack). Per-construct suppressions live in
// lib/cdk-stack.ts.
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole is attached by the CDK Provider framework and the NodejsFunction-based gateway-provisioner Lambda to grant CloudWatch Logs put/create only — minimal-privilege managed policy, CDK-managed, not user-modifiable. The provisioner Lambda\'s own gateway-create permissions are added as explicit PolicyStatements in lib/cdk-stack.ts.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'bedrock-agentcore:CreateGateway, ListGateways, ListGatewayTargets, CreateWorkloadIdentity, and ListWorkloadIdentities cannot be scoped to a specific gateway ARN because the gateway ID is not known until after creation. All other bedrock-agentcore actions are scoped to the specific gateway name prefix. Residual Provider-framework wildcards (s3:* on the CDK staging bucket) are CDK-managed and not user-modifiable.',
  },
  {
    id: 'AwsSolutions-L1',
    reason:
      'The gateway-provisioner NodejsFunction pins Runtime.NODEJS_24_X (Apr 2026 LTS). The Provider framework\'s internal `is-complete`/`on-event` Lambdas are CDK-controlled; cdk-nag may flag them transiently as CDK updates the default — they are not user-modifiable.',
  },
  {
    id: 'AwsSolutions-SF1',
    reason:
      'Provider framework state-machine is CDK-managed. The state machine runs only during stack create/update while the `bedrock-agentcore:CreateGateway` + `CreateGatewayTarget` custom-resource calls are in flight, then becomes idle.',
  },
  {
    id: 'AwsSolutions-SF2',
    reason:
      'Provider framework state-machine X-Ray setting is CDK-managed; the gateway-provisioner waiter is a short-lived deploy-time resource with no steady-state traffic to trace.',
  },
]);
