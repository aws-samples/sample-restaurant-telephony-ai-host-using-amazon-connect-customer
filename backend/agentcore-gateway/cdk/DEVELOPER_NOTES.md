# Developer Notes — AgentCore Gateway CDK

Lessons learned and workarounds discovered while building this Custom Resource.

## AWS SDK Bundling (externalModules: [])

The `NodejsFunction` construct is configured with `externalModules: []`, which bundles ALL `@aws-sdk` packages into the Lambda instead of using the runtime's built-in versions. This produces a ~1MB output file (~32K lines).

**Why:** As of February 2026, the Node.js 24.x Lambda runtime's built-in `@aws-sdk/client-bedrock-agentcore-control` does not support the `apiGateway` target configuration type in `McpTargetConfiguration`. The runtime SDK's serializer crashes with `Cannot read properties of undefined (reading '0')` when trying to serialize the `apiGateway` field. Bundling a newer version of the SDK from npm resolves this.

**When to remove:** Once the Lambda runtime's built-in SDK is updated to include `apiGateway` support in `McpTargetConfiguration`, you can remove `externalModules: []` from the bundling config to reduce the bundle size significantly.

## Docker Not Required

The original Python implementation required Docker for bundling Lambda dependencies. The Node.js port uses `NodejsFunction` with esbuild, which runs locally — no Docker needed. This was a key requirement since many developer machines don't have Docker installed.

**Important:** `esbuild` must be in `devDependencies` in `package.json`. Without it, CDK falls back to Docker-based bundling and fails with `spawnSync docker ENOENT`.

## Custom Resource Response Format (cr.Provider)

The handler returns data as a plain object — it does NOT manually call the CloudFormation response URL. The `cr.Provider` framework handles the CF response lifecycle.

```javascript
// CORRECT — return object, let cr.Provider handle CF response
return {
  PhysicalResourceId: result.gatewayId,
  Data: { GatewayId: result.gatewayId, GatewayUrl: result.gatewayUrl, ... },
};

// WRONG — do NOT call the CF response URL manually
// await sendResponse(event, 'SUCCESS', responseData, physicalResourceId);
```

An earlier version manually sent the CF response AND returned data, causing the `cr.Provider` framework to send a second response that overwrote the first — resulting in `CustomResource attribute error: Vendor response doesn't contain GatewayArn attribute`.

## Target Update Strategy

The Update handler uses `UpdateGatewayTargetCommand` to update the existing target in place rather than delete+recreate. Delete+recreate was unreliable — new targets would consistently enter `FAILED` status with no reason provided, likely due to timing issues with target dissociation.

**Important:** `UpdateGatewayTargetCommand` requires the `name` field even though it's an update (not a create). Omitting it causes a validation error.

## API Gateway OpenAPI Spec Requirements

When connecting API Gateway as a target, the AgentCore Gateway validates the OpenAPI specification. Every method exposed as a tool MUST have `responses` defined in the spec. Missing responses cause the target to enter `FAILED` or `UPDATE_UNSUCCESSFUL` status with the error:

```
Failed to parse OpenAPI specification: attribute paths.'/cart'(get).responses is missing
```

**Fix:** Verify that all API Gateway methods have `methodResponses` defined in the CDK stack. Even a minimal `200` response is sufficient.

## DeployTimestamp Property

The Custom Resource includes a `DeployTimestamp` property that changes on every `cdk deploy`. This forces CloudFormation to trigger an Update event every time, ensuring the target is refreshed with the latest API Gateway schema. Without this, adding new API endpoints would not trigger a gateway update since the other properties (ApiGatewayId, Stage, etc.) don't change.

## Gateway Creation — ConflictException Handling

The Create handler catches `ConflictException` when the gateway already exists (e.g., from a previous failed deployment that left an orphaned gateway). It lists all gateways, finds the matching one by name, and reuses it instead of failing.

## IAM Role Propagation

After creating the IAM service role, the handler waits 10 seconds for IAM propagation before creating the gateway. Without this delay, the gateway creation can fail with permission errors because the role hasn't propagated to the Bedrock AgentCore service yet.
