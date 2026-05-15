# Provenance — Backend Infrastructure (DynamoDB, Location, Lambda, API Gateway)

`backend/backend-infrastructure/` was ported verbatim from
`reference-project/backend/backend-infrastructure/` at commit
`a582cae3f4660ebba2a83e8386f095228c6170d3` on 2026-05-01.

Changes from the reference:

1. `lib/cognito-stack.ts` DELETED (design §8 non-goal #8 — no end-user auth surface for telephony).
2. `lib/api-gateway-stack.ts` Cognito authorizer stripped; REST API uses `AuthorizationType.IAM` only.
3. `lib/location-stack.ts` `CfnMap` dropped (design §8 non-goal #7 — no frontend).
4. Stack IDs renamed `QSR-*` → `${prefix}-*` via `DeploymentPrefix` CfnParameter.
5. Every physical resource name parameterized via `cdk.Fn.sub('${P}-...', { P: deploymentPrefix.valueAsString })`.
6. Every `CfnOutput` `exportName` clause stripped (P5).
7. Cross-stack wiring refactored from shared construct references to CfnParameter + `--outputs-file` (R4).
8. `lambda/place-order/index.js` updated to accept `channel`, `fromPhoneNumber`, `anonymousCaller`, `customerId` as baseline body fields (R9).
