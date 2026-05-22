import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * {prefix}-LambdaStack — the ten ordering Lambdas.
 *
 * Ported from reference-project/backend/backend-infrastructure/lib/lambda-stack.ts.
 * Changes vs reference:
 *   • `DeploymentPrefix` CfnParameter declared locally (R19).
 *   • Seven additional CfnParameters accept upstream identifiers as strings
 *     (table names + place-index name + route-calculator name). Values flow in
 *     at deploy time from `cdk-outputs/tel-ddb.json` + `cdk-outputs/tel-location.json`.
 *   • Each DDB table is re-materialized inside this stack via `Table.fromTableName`
 *     so the CDK `grantReadData` / `grantReadWriteData` affordances still work,
 *     but the stack does NOT depend on construct references from DynamoDBStack.
 *   • Each Lambda `functionName` is parameterized via `cdk.Fn.sub('${P}-<Name>', …)`.
 *   • Each Lambda exec-role `roleName` is parameterized the same way.
 *   • Every Lambda runtime pinned to `lambda.Runtime.NODEJS_24_X` (inherited).
 *   • CfnOutput `exportName` clauses stripped (P5).
 *   • `this.functions` still exposed for within-app `addDependency`.
 */
export class LambdaStack extends cdk.Stack {
  public readonly functions: {
    getCustomerProfile: lambda.Function;
    getPreviousOrders: lambda.Function;
    getMenu: lambda.Function;
    addToCart: lambda.Function;
    getCart: lambda.Function;
    updateCart: lambda.Function;
    placeOrder: lambda.Function;
    getNearestLocations: lambda.Function;
    findLocationAlongRoute: lambda.Function;
    geocodeAddress: lambda.Function;
  };

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters (8) ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    const menuTableNameParam = new cdk.CfnParameter(this, 'MenuTableName', {
      type: 'String',
      minLength: 1,
      description: 'Menu table name (from cdk-outputs/tel-ddb.json)',
    });
    const cartsTableNameParam = new cdk.CfnParameter(this, 'CartsTableName', {
      type: 'String',
      minLength: 1,
      description: 'Carts table name (from cdk-outputs/tel-ddb.json)',
    });
    const ordersTableNameParam = new cdk.CfnParameter(this, 'OrdersTableName', {
      type: 'String',
      minLength: 1,
      description: 'Orders table name (from cdk-outputs/tel-ddb.json)',
    });
    const customersTableNameParam = new cdk.CfnParameter(
      this,
      'CustomersTableName',
      {
        type: 'String',
        minLength: 1,
        description: 'Customers table name (from cdk-outputs/tel-ddb.json)',
      },
    );
    const locationsTableNameParam = new cdk.CfnParameter(
      this,
      'LocationsTableName',
      {
        type: 'String',
        minLength: 1,
        description: 'Locations table name (from cdk-outputs/tel-ddb.json)',
      },
    );
    const placeIndexNameParam = new cdk.CfnParameter(this, 'PlaceIndexName', {
      type: 'String',
      minLength: 1,
      description: 'Location Service place-index name (from cdk-outputs/tel-location.json)',
    });
    const routeCalculatorNameParam = new cdk.CfnParameter(
      this,
      'RouteCalculatorName',
      {
        type: 'String',
        minLength: 1,
        description:
          'Location Service route-calculator name (from cdk-outputs/tel-location.json)',
      },
    );

    // ───────────── Re-materialize tables from names ─────────────
    // fromTableName yields an ITable; grantReadData / grantReadWriteData work
    // against it and CDK synthesizes the correct * scoped arn patterns.
    const customersTable = dynamodb.Table.fromTableName(
      this,
      'CustomersTableRef',
      customersTableNameParam.valueAsString,
    );
    const ordersTable = dynamodb.Table.fromTableName(
      this,
      'OrdersTableRef',
      ordersTableNameParam.valueAsString,
    );
    const menuTable = dynamodb.Table.fromTableName(
      this,
      'MenuTableRef',
      menuTableNameParam.valueAsString,
    );
    const cartsTable = dynamodb.Table.fromTableName(
      this,
      'CartsTableRef',
      cartsTableNameParam.valueAsString,
    );
    const locationsTable = dynamodb.Table.fromTableName(
      this,
      'LocationsTableRef',
      locationsTableNameParam.valueAsString,
    );

    // Location Service resource ARNs — built from the CfnParameter names.
    const placeIndexArn = cdk.Fn.sub(
      'arn:aws:geo:${R}:${A}:place-index/${N}',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        N: placeIndexNameParam.valueAsString,
      },
    );
    const routeCalculatorArn = cdk.Fn.sub(
      'arn:aws:geo:${R}:${A}:route-calculator/${N}',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        N: routeCalculatorNameParam.valueAsString,
      },
    );

    // Helper to build an execution role with a prefixed name.
    const makeRole = (logicalId: string, suffix: string) =>
      new iam.Role(this, logicalId, {
        roleName: cdk.Fn.sub(`\${P}-lambda-${suffix}-role`, { P: prefix }),
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
          ),
        ],
      });

    // Helper to pre-create the CloudWatch log group each Lambda writes to.
    //
    // Why explicit: when a Lambda is invoked for the first time, AWS lazily
    // creates `/aws/lambda/<functionName>` if it does not already exist.
    // CDK never owned that log group, so `cdk destroy` cannot delete it.
    // The next deploy then fails with `Resource of type AWS::Logs::LogGroup
    // ... already exists` because CFN refuses to claim ownership of an
    // existing resource. Pre-creating the log group through CDK with
    // `RemovalPolicy.DESTROY` makes the lifecycle symmetric: CFN creates
    // it on deploy, deletes it on destroy, no orphans.
    const makeLogGroup = (logicalId: string, functionSuffix: string) =>
      new logs.LogGroup(this, logicalId, {
        logGroupName: cdk.Fn.sub(`/aws/lambda/\${P}-${functionSuffix}`, { P: prefix }),
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    // ───────────── 10 Lambdas ─────────────
    const getCustomerProfileRole = makeRole(
      'GetCustomerProfileRole',
      'GetCustomerProfile',
    );
    const getCustomerProfile = new lambda.Function(this, 'GetCustomerProfile', {
      functionName: cdk.Fn.sub('${P}-GetCustomerProfile', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/get-customer-profile'),
      ),
      role: getCustomerProfileRole,
      logGroup: makeLogGroup('GetCustomerProfileLogGroup', 'GetCustomerProfile'),
      environment: {
        CUSTOMERS_TABLE_NAME: customersTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Retrieve customer profile including name, email, phone, loyalty points, and tier.',
    });
    customersTable.grantReadData(getCustomerProfile);

    const getPreviousOrdersRole = makeRole(
      'GetPreviousOrdersRole',
      'GetPreviousOrders',
    );
    const getPreviousOrders = new lambda.Function(this, 'GetPreviousOrders', {
      functionName: cdk.Fn.sub('${P}-GetPreviousOrders', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/get-previous-orders'),
      ),
      role: getPreviousOrdersRole,
      logGroup: makeLogGroup('GetPreviousOrdersLogGroup', 'GetPreviousOrders'),
      environment: {
        ORDERS_TABLE_NAME: ordersTableNameParam.valueAsString,
        // Locations table is read with BatchGetItem to enrich each
        // order row with the human-readable address (street, city,
        // state). Without this the agent receives only locationId +
        // locationName and has no way to confirm the location to a
        // caller without speaking an opaque internal id.
        LOCATIONS_TABLE_NAME: locationsTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Retrieve customer order history (last 5 orders), enriched with location address fields from the Locations table.',
    });
    ordersTable.grantReadData(getPreviousOrders);
    locationsTable.grantReadData(getPreviousOrders);

    const getMenuRole = makeRole('GetMenuRole', 'GetMenu');
    const getMenu = new lambda.Function(this, 'GetMenu', {
      functionName: cdk.Fn.sub('${P}-GetMenu', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/get-menu')),
      role: getMenuRole,
      logGroup: makeLogGroup('GetMenuLogGroup', 'GetMenu'),
      environment: {
        MENU_TABLE_NAME: menuTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Retrieve location-specific menu items.',
    });
    menuTable.grantReadData(getMenu);

    const addToCartRole = makeRole('AddToCartRole', 'AddToCart');
    const addToCart = new lambda.Function(this, 'AddToCart', {
      functionName: cdk.Fn.sub('${P}-AddToCart', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/add-to-cart')),
      role: addToCartRole,
      logGroup: makeLogGroup('AddToCartLogGroup', 'AddToCart'),
      environment: {
        MENU_TABLE_NAME: menuTableNameParam.valueAsString,
        CARTS_TABLE_NAME: cartsTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Add menu items to shopping cart with availability verification.',
    });
    menuTable.grantReadData(addToCart);
    cartsTable.grantReadWriteData(addToCart);

    const getCartRole = makeRole('GetCartRole', 'GetCart');
    const getCart = new lambda.Function(this, 'GetCart', {
      functionName: cdk.Fn.sub('${P}-GetCart', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/get-cart')),
      role: getCartRole,
      logGroup: makeLogGroup('GetCartLogGroup', 'GetCart'),
      environment: {
        CARTS_TABLE_NAME: cartsTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description: 'Get current cart contents for a customer.',
    });
    cartsTable.grantReadData(getCart);

    const updateCartRole = makeRole('UpdateCartRole', 'UpdateCart');
    const updateCart = new lambda.Function(this, 'UpdateCart', {
      functionName: cdk.Fn.sub('${P}-UpdateCart', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/update-cart')),
      role: updateCartRole,
      logGroup: makeLogGroup('UpdateCartLogGroup', 'UpdateCart'),
      environment: {
        CARTS_TABLE_NAME: cartsTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description:
        'Update cart: clear all items, remove a specific item, update item quantity, or change pickup location.',
    });
    cartsTable.grantReadWriteData(updateCart);

    const placeOrderRole = makeRole('PlaceOrderRole', 'PlaceOrder');
    const placeOrder = new lambda.Function(this, 'PlaceOrder', {
      functionName: cdk.Fn.sub('${P}-PlaceOrder', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/place-order')),
      role: placeOrderRole,
      logGroup: makeLogGroup('PlaceOrderLogGroup', 'PlaceOrder'),
      environment: {
        CARTS_TABLE_NAME: cartsTableNameParam.valueAsString,
        ORDERS_TABLE_NAME: ordersTableNameParam.valueAsString,
        LOCATIONS_TABLE_NAME: locationsTableNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Create order from cart with automatic tax calculation based on location.',
    });
    cartsTable.grantReadWriteData(placeOrder);
    ordersTable.grantReadWriteData(placeOrder);
    locationsTable.grantReadData(placeOrder);

    const getNearestLocationsRole = makeRole(
      'GetNearestLocationsRole',
      'GetNearestLocations',
    );
    const getNearestLocations = new lambda.Function(this, 'GetNearestLocations', {
      functionName: cdk.Fn.sub('${P}-GetNearestLocations', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/get-nearest-locations'),
      ),
      role: getNearestLocationsRole,
      logGroup: makeLogGroup('GetNearestLocationsLogGroup', 'GetNearestLocations'),
      environment: {
        LOCATIONS_TABLE_NAME: locationsTableNameParam.valueAsString,
        PLACE_INDEX_NAME: placeIndexNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Find nearest restaurant locations using GPS coordinates.',
    });
    locationsTable.grantReadData(getNearestLocations);
    getNearestLocations.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['geo:SearchPlaceIndexForPosition'],
        resources: [placeIndexArn],
      }),
    );

    const findLocationAlongRouteRole = makeRole(
      'FindLocationAlongRouteRole',
      'FindLocationAlongRoute',
    );
    const findLocationAlongRoute = new lambda.Function(
      this,
      'FindLocationAlongRoute',
      {
        functionName: cdk.Fn.sub('${P}-FindLocationAlongRoute', { P: prefix }),
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          path.join(__dirname, '../lambda/find-location-along-route'),
        ),
        role: findLocationAlongRouteRole,
        logGroup: makeLogGroup('FindLocationAlongRouteLogGroup', 'FindLocationAlongRoute'),
        environment: {
          LOCATIONS_TABLE_NAME: locationsTableNameParam.valueAsString,
          ROUTE_CALCULATOR_NAME: routeCalculatorNameParam.valueAsString,
        },
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        description:
          'Find restaurant locations along a driving route with detour time calculation.',
      },
    );
    locationsTable.grantReadData(findLocationAlongRoute);
    findLocationAlongRoute.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['geo:CalculateRoute'],
        resources: [routeCalculatorArn],
      }),
    );

    const geocodeAddressRole = makeRole('GeocodeAddressRole', 'GeocodeAddress');
    const geocodeAddress = new lambda.Function(this, 'GeocodeAddress', {
      functionName: cdk.Fn.sub('${P}-GeocodeAddress', { P: prefix }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/geocode-address'),
      ),
      role: geocodeAddressRole,
      logGroup: makeLogGroup('GeocodeAddressLogGroup', 'GeocodeAddress'),
      environment: {
        PLACE_INDEX_NAME: placeIndexNameParam.valueAsString,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Convert street address to GPS coordinates using Amazon Location Service.',
    });
    geocodeAddress.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['geo:SearchPlaceIndexForText'],
        resources: [placeIndexArn],
      }),
    );

    this.functions = {
      getCustomerProfile,
      getPreviousOrders,
      getMenu,
      addToCart,
      getCart,
      updateCart,
      placeOrder,
      getNearestLocations,
      findLocationAlongRoute,
      geocodeAddress,
    };

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'GetCustomerProfileLambdaArn', {
      value: getCustomerProfile.functionArn,
      description: 'ARN of GetCustomerProfile Lambda',
    });
    new cdk.CfnOutput(this, 'GetPreviousOrdersLambdaArn', {
      value: getPreviousOrders.functionArn,
      description: 'ARN of GetPreviousOrders Lambda',
    });
    new cdk.CfnOutput(this, 'GetMenuLambdaArn', {
      value: getMenu.functionArn,
      description: 'ARN of GetMenu Lambda',
    });
    new cdk.CfnOutput(this, 'AddToCartLambdaArn', {
      value: addToCart.functionArn,
      description: 'ARN of AddToCart Lambda',
    });
    new cdk.CfnOutput(this, 'GetCartLambdaArn', {
      value: getCart.functionArn,
      description: 'ARN of GetCart Lambda',
    });
    new cdk.CfnOutput(this, 'UpdateCartLambdaArn', {
      value: updateCart.functionArn,
      description: 'ARN of UpdateCart Lambda',
    });
    new cdk.CfnOutput(this, 'PlaceOrderLambdaArn', {
      value: placeOrder.functionArn,
      description: 'ARN of PlaceOrder Lambda',
    });
    new cdk.CfnOutput(this, 'GetNearestLocationsLambdaArn', {
      value: getNearestLocations.functionArn,
      description: 'ARN of GetNearestLocations Lambda',
    });
    new cdk.CfnOutput(this, 'FindLocationAlongRouteLambdaArn', {
      value: findLocationAlongRoute.functionArn,
      description: 'ARN of FindLocationAlongRoute Lambda',
    });
    new cdk.CfnOutput(this, 'GeocodeAddressLambdaArn', {
      value: geocodeAddress.functionArn,
      description: 'ARN of GeocodeAddress Lambda',
    });

    // ───────────── cdk-nag suppressions (inherited from reference) ─────────────
    const lambdaFunctions = [
      getCustomerProfile,
      getPreviousOrders,
      getMenu,
      addToCart,
      getCart,
      updateCart,
      placeOrder,
      getNearestLocations,
      findLocationAlongRoute,
      geocodeAddress,
    ];
    lambdaFunctions.forEach((fn) => {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason:
              "Lambda basic execution role is AWS-managed; grants CloudWatch Logs put/create only. Each Lambda's data-layer access is scoped via explicit DDB/Location grants ported from reference-project.",
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Wildcards are scoped to specific ARNs interpolated from DeploymentPrefix CfnParameter (DDB table ARNs, Location place-index/route-calculator ARNs). Action-level scope (geo:SearchPlaceIndexForPosition, dynamodb:BatchGetItem, etc.) follows the reference-project grants verbatim.',
          },
          {
            id: 'AwsSolutions-L1',
            reason:
              'Lambda functions pin `nodejs24.x` (current LTS through Apr 2028). Runtime will be updated when a newer LTS becomes available.',
          },
        ],
        true,
      );
    });
  }
}
