# QSR Backend Infrastructure

This module holds the 4 CDK stacks that implement the ordering backend —
DynamoDB tables, Location Service resources, 10 ordering Lambdas, and the
REST API Gateway.

Ported verbatim from `reference-project/backend/backend-infrastructure/`
(see NOTICE.md for the pinned commit SHA); patched only for stack naming +
`DeploymentPrefix` CfnParameter wiring + Cognito/frontend strip.

## Stacks (all single CDK app; 4 independent stacks deployed in order)

### `${prefix}-DynamoDBStack`
- **CfnParameters**: `DeploymentPrefix`
- **CfnOutputs** (no `exportName`): `MenuTableName`, `CartsTableName`, `OrdersTableName`, `CustomersTableName`, `LocationsTableName`, `MenuTableArn`, `CartsTableArn`, `OrdersTableArn`, `CustomersTableArn`, `LocationsTableArn`
- 5 tables: Customers, Orders, Menu, Carts, Locations. PAY_PER_REQUEST, PITR enabled. Carts has TTL on `expiresAt`. Orders has GSI1 for location-based queries.

### `${prefix}-LocationStack`
- **CfnParameters**: `DeploymentPrefix`
- **CfnOutputs** (no `exportName`): `PlaceIndexName`, `PlaceIndexArn`, `RouteCalculatorName`, `RouteCalculatorArn`
- Place-index (Esri) + route-calculator (Esri). `CfnMap` from the reference is dropped (frontend-only, design §8 non-goal #7).

### `${prefix}-LambdaStack`
- **CfnParameters**: `DeploymentPrefix`, `MenuTableName`, `CartsTableName`, `OrdersTableName`, `CustomersTableName`, `LocationsTableName`, `PlaceIndexName`, `RouteCalculatorName`
- **CfnOutputs** (no `exportName`): 10 × `*LambdaArn` (`GetCustomerProfileLambdaArn`, `GetPreviousOrdersLambdaArn`, `GetMenuLambdaArn`, `AddToCartLambdaArn`, `GetCartLambdaArn`, `UpdateCartLambdaArn`, `PlaceOrderLambdaArn`, `GetNearestLocationsLambdaArn`, `FindLocationAlongRouteLambdaArn`, `GeocodeAddressLambdaArn`)
- 10 Lambdas on `nodejs24.x`: `GetCustomerProfile`, `GetPreviousOrders`, `GetMenu`, `AddToCart`, `GetCart`, `UpdateCart`, `PlaceOrder`, `GetNearestLocations`, `FindLocationAlongRoute`, `GeocodeAddress`. Per-function execution role scoped to only the DDB tables + Location resources it reads/writes.
- **`PlaceOrder` R9 baseline**: accepts `channel`, `fromPhoneNumber`, `anonymousCaller`, `customerId` on the request body. Writes them onto the Orders row. Validates: if `anonymousCaller===false`, `fromPhoneNumber` MUST match E.164; else MUST be empty. HTTP 400 on validation failure.

### `${prefix}-ApiGatewayStack`
- **CfnParameters**: `DeploymentPrefix`, 10 × `*LambdaArn`
- **CfnOutputs** (no `exportName`): `ApiGatewayId`, `ApiGatewayUrl`, `ApiGatewayRestApiId`, `ApiGatewayArn`
- REST API, `AuthorizationType.IAM` only (Cognito authorizer stripped during port — design §8 non-goal #8). The AgentCore Gateway SigV4-invokes this API.

## cdk-nag

All 4 stacks have `AwsSolutionsChecks` applied via `bin/app.ts`. Suppressions with written reasons live inline — framework-wide suppressions in `bin/app.ts`, per-resource suppressions in each stack file.

## Deploy

Typically deployed via workspace-root `scripts/deploy-all.sh` (Task 9.1). Manual:

```bash
cd backend/backend-infrastructure
npm install
npx cdk deploy DynamoDBStack --parameters DynamoDBStack:DeploymentPrefix=qsr-tel --outputs-file ../../cdk-outputs/tel-ddb.json
npx cdk deploy LocationStack --parameters LocationStack:DeploymentPrefix=qsr-tel --outputs-file ../../cdk-outputs/tel-location.json
# LambdaStack needs 5 table names + 2 location resource names threaded in:
npx cdk deploy LambdaStack \
  --parameters LambdaStack:DeploymentPrefix=qsr-tel \
  --parameters LambdaStack:MenuTableName=$(jq -r '."qsr-tel-DynamoDBStack".MenuTableName' ../../cdk-outputs/tel-ddb.json) \
  --parameters LambdaStack:CartsTableName=... \
  --parameters LambdaStack:OrdersTableName=... \
  --parameters LambdaStack:CustomersTableName=... \
  --parameters LambdaStack:LocationsTableName=... \
  --parameters LambdaStack:PlaceIndexName=... \
  --parameters LambdaStack:RouteCalculatorName=... \
  --outputs-file ../../cdk-outputs/tel-lambdas.json
# ApiGatewayStack needs 10 Lambda ARNs threaded in:
npx cdk deploy ApiGatewayStack --parameters ApiGatewayStack:DeploymentPrefix=qsr-tel --parameters ApiGatewayStack:GetCustomerProfileLambdaArn=... # (+9 more)
```

See `NOTICE.md` for the pinned reference-project commit SHA.
