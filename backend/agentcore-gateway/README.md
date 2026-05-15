# AgentCore Gateway

This module holds the CDK app that deploys `${prefix}-AgentCoreGatewayStack` —
an `AWS::BedrockAgentCore::Gateway` with MCP + AWS_IAM auth that fronts the
ordering REST API deployed by `${prefix}-ApiGatewayStack`.

Ported verbatim from `reference-project/backend/agentcore-gateway/` (see
`NOTICE.md` for the pinned commit SHA); patched only for stack naming +
`DeploymentPrefix` CfnParameter wiring + conversion of the reference's
`--context apiGatewayId` read to a proper CfnParameter.

## Stack

### `${prefix}-AgentCoreGatewayStack`

**CfnParameters**:
- `DeploymentPrefix` — regex `^[a-z][a-z0-9-]{1,19}$`.
- `ApiGatewayId` — from `cdk-outputs/tel-apigw.json`.
- `ApiGatewayUrl` — from `cdk-outputs/tel-apigw.json`.
- `ApiGatewayRestApiId` — from `cdk-outputs/tel-apigw.json` (used for IAM execute-api scoping).

**CfnOutputs** (no `exportName`):
- `GatewayUrl` — consumed by `${prefix}-AgentRuntimeStack` as the `AgentCoreGatewayUrl` CfnParameter.
- `GatewayId`, `GatewayArn`, `GatewayRoleArn` — observability.
- `TargetId`, `ApiGatewayId`, `ApiGatewayStage`, `Region`, `AccountId`,
  `DeploymentTimestamp`, `ToolFiltersCount`, `ToolOverridesCount` —
  carried through from the reference (no `exportName`).

**Resources**:
- Gateway-provisioner Lambda (`nodejs24.x`, NodejsFunction bundle): custom-resource
  handler that calls `bedrock-agentcore:CreateGateway` + `CreateGatewayTarget`.
  Function name `${prefix}-GatewayHandler`.
- Gateway service role (`${prefix}-gateway-service-role`): the role the gateway
  assumes to invoke the API Gateway's REST API via SigV4.
- `AWS::BedrockAgentCore::Gateway` named `${prefix}-gateway`, MCP + AWS_IAM protocol.
- `AWS::BedrockAgentCore::GatewayTarget` with the API Gateway's OpenAPI schema.

## cdk-nag

`AwsSolutionsChecks` applied via `bin/cdk.ts`. Documented suppressions cover:
- `IAM4` on `AWSLambdaBasicExecutionRole` for the provisioner Lambda (minimal-privilege managed policy).
- `IAM5` on `bedrock-agentcore:*Gateway*` wildcards — these APIs don't support resource-level IAM (design §11.5b).
- `L1` on the Provider framework's internal Lambdas (CDK-managed; not user-modifiable).
- `SF1` / `SF2` on custom-resource Provider framework internals (CDK-managed).

## Deploy

Typically deployed via workspace-root `scripts/deploy-all.sh` (Task 9.1). Manual:

```bash
cd backend/agentcore-gateway/cdk
npm install
npx cdk deploy AgentCoreGatewayStack \
  --parameters AgentCoreGatewayStack:DeploymentPrefix=qsr-tel \
  --parameters AgentCoreGatewayStack:ApiGatewayId=<from tel-apigw.json> \
  --parameters AgentCoreGatewayStack:ApiGatewayUrl=<from tel-apigw.json> \
  --parameters AgentCoreGatewayStack:ApiGatewayRestApiId=<from tel-apigw.json> \
  --outputs-file ../../../cdk-outputs/tel-gateway.json
```

See `NOTICE.md` for the pinned reference-project commit SHA.
