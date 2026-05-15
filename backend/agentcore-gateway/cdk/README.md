# AgentCore Gateway CDK App

Pointer: the top-level README lives one directory up at
[`../README.md`](../README.md) — start there for the full stack description,
CfnParameter / CfnOutput catalog, and deploy instructions. The reference-project
provenance SHA is pinned in [`../NOTICE.md`](../NOTICE.md).

This directory (`cdk/`) is the self-contained CDK app:
- `bin/cdk.ts` — entry point, instantiates `CdkStack` and applies the
  `AwsSolutionsChecks` aspect with stack-level cdk-nag suppressions.
- `lib/cdk-stack.ts` — the `${prefix}-AgentCoreGatewayStack` definition.
  Declares four `CfnParameter`s (`DeploymentPrefix`, `ApiGatewayId`,
  `ApiGatewayUrl`, `ApiGatewayRestApiId`), a gateway-provisioner Lambda
  (`nodejs24.x`), and a custom-resource `Provider` that calls
  `bedrock-agentcore:CreateGateway` + `CreateGatewayTarget`.
- `lambda/handler.mjs` — the custom-resource `onEventHandler` (ported verbatim
  from the reference).
- `cdk.json`, `package.json`, `tsconfig.json` — per-app configs.

Per design §4 + NFR15 this app is deployed in isolation via
`cdk deploy AgentCoreGatewayStack --parameters Stack:Key=value`. No
`--context` threading, no CFN Exports, no `Fn::ImportValue`.
