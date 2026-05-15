# Provenance — Amazon Bedrock AgentCore Gateway Port

`backend/agentcore-gateway/` was ported verbatim from
`reference-project/backend/agentcore-gateway/` at commit
`a582cae3f4660ebba2a83e8386f095228c6170d3` on 2026-05-01.

Changes from the reference:
1. `test-client/` DELETED (design §8 non-goal #9 — no test-clients helper).
2. `--context apiGatewayId` input converted to `CfnParameter ApiGatewayId` (plus new CfnParameters `ApiGatewayUrl` and `ApiGatewayRestApiId`) per NFR15.
3. New CfnParameter `DeploymentPrefix` with regex validator declared locally on the stack.
4. Gateway name rewritten from `qsr-ordering-gateway` literal to `${DeploymentPrefix}-gateway` via `cdk.Fn.sub`.
5. Gateway service-role name rewritten to `${DeploymentPrefix}-gateway-service-role`.
6. API Gateway IAM resource ARNs in the provisioner Lambda's policy interpolate `ApiGatewayId` / `ApiGatewayRestApiId` CfnParameters.
7. Every `CfnOutput` emitted WITHOUT `exportName` (P5).
