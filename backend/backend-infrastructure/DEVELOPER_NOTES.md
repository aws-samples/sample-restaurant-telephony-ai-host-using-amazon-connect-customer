# Developer Notes — Backend Infrastructure

Lessons learned and workarounds discovered while building the backend.

## API Gateway Method Responses for AgentCore Gateway

Every API Gateway method that will be exposed as an MCP tool through AgentCore Gateway MUST have `methodResponses` defined in the CDK stack. This is because AgentCore Gateway validates the OpenAPI specification when creating or updating a target, and methods without `responses` in the spec cause the target to fail with:

```
Failed to parse OpenAPI specification: attribute paths.'/cart'(get).responses is missing
```

**Rule of thumb:** When adding a new Lambda + API Gateway endpoint, always include at least:
```typescript
methodResponses: [
  { statusCode: '200', responseModels: { 'application/json': successResponseModel } },
  { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
  { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
],
```

## Lambda Runtime Version and CDK-Nag

All Lambda functions use `NODEJS_24_X` (latest as of February 2026). This satisfies the `AwsSolutions-L1` CDK-nag rule without needing a suppression. If you downgrade the runtime, you'll need to add the L1 suppression back to the `lambdaFunctions` array.

## Address Abbreviation Expansion

Speech models (like Nova 2 Sonic) mispronounce common street abbreviations:
- "Dr" → "Doctor" instead of "Drive"
- "St" → "S T" instead of "Street"
- "TX" → "Tea Ex" instead of "Texas"

The Lambda functions that return addresses (`get-nearest-locations`, `find-location-along-route`, `geocode-address`, `get-previous-orders`) include an inline street abbreviation expansion function as a safety net. The primary fix is in the synthetic data generator which builds addresses from structured Geo Places API fields (see `backend/synthetic-data/DEVELOPER_NOTES.md`).

## Cart API Design

The cart has three endpoints:
- `POST /cart` — Add items (accepts an array, validates against menu, merges quantities)
- `GET /cart` — View current cart (returns items, quantities, subtotal)
- `PUT /cart` — Modify cart (actions: `clear`, `remove_item`, `update_quantity`, `change_location`)

All three return the current cart state with `itemCount` and `subtotal` calculated, so the agent always knows the cart contents after any operation.

---

## Port notes (telephony-voice-ordering-agent)

See `NOTICE.md` for the pinned reference-project commit SHA and the complete list of port-time changes. Summary:

- **Cognito stripped** — no end-user auth surface for telephony (design §8 non-goal #8). `lib/cognito-stack.ts` + `AUTHENTICATION.md` + `test-api.sh` deleted.
- **Frontend stripped** — no `CfnMap` (design §8 non-goal #7).
- **Every physical name prefixed** via a local `DeploymentPrefix` CfnParameter on each of the four stacks (R19 / P12).
- **No shared construct references across stacks** — cross-stack values flow via CfnParameter + `cdk-outputs/*.json` + `--parameters <Stack>:<Key>=<Value>` (R4 / P5).
- **`place-order/index.js`** updated to accept `channel` / `fromPhoneNumber` / `anonymousCaller` / `customerId` as R9 baseline body fields and persist them onto the Orders row.
