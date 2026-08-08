import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * {prefix}-DynamoDBStack — Customers / Orders / Menu / Carts / Locations.
 *
 * Design notes:
 *   • `DeploymentPrefix` CfnParameter is declared locally. The same regex is
 *     duplicated in every stack on purpose: isolation beats DRY here, because
 *     each stack must be deployable on its own.
 *   • Every `tableName` is parameterized as `cdk.Fn.sub('${P}-Customers', …)`
 *     so a single deploy-time value drives the name.
 *   • Every `CfnOutput` has NO `exportName`, so stacks stay independently
 *     deployable. Logical IDs are kept stable (`MenuTableName`,
 *     `CartsTableName`, …) because scripts/deploy-all.sh reads them from the
 *     cdk-outputs JSON.
 *   • `this.tables` stays exposed for within-app use (addDependency), but
 *     downstream stacks (LambdaStack, ApiGatewayStack) MUST NOT reach into it
 *     for grants — they take table NAMES via their own CfnParameters.
 */
export class DynamoDBStack extends cdk.Stack {
  public readonly tables: {
    customers: dynamodb.Table;
    orders: dynamodb.Table;
    menu: dynamodb.Table;
    carts: dynamodb.Table;
    locations: dynamodb.Table;
  };

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // Customers Table — PK: CUSTOMER#{customerId}, SK: PROFILE
    const customersTable = new dynamodb.Table(this, 'CustomersTable', {
      tableName: cdk.Fn.sub('${P}-Customers', { P: prefix }),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Orders Table — PK: CUSTOMER#{customerId}, SK: ORDER#{orderId}#{timestamp}
    // GSI1 for location-based queries
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: cdk.Fn.sub('${P}-Orders', { P: prefix }),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });
    ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Menu Table — PK: LOCATION#{locationId}#ITEM#{itemId}
    const menuTable = new dynamodb.Table(this, 'MenuTable', {
      tableName: cdk.Fn.sub('${P}-Menu', { P: prefix }),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Carts Table — PK: SESSION#{sessionId}, TTL on expiresAt
    const cartsTable = new dynamodb.Table(this, 'CartsTable', {
      tableName: cdk.Fn.sub('${P}-Carts', { P: prefix }),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Locations Table — PK: LOCATION#{locationId}
    const locationsTable = new dynamodb.Table(this, 'LocationsTable', {
      tableName: cdk.Fn.sub('${P}-Locations', { P: prefix }),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    this.tables = {
      customers: customersTable,
      orders: ordersTable,
      menu: menuTable,
      carts: cartsTable,
      locations: locationsTable,
    };

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'CustomersTableName', {
      value: customersTable.tableName,
      description: 'Customers table name',
    });
    new cdk.CfnOutput(this, 'CustomersTableArn', {
      value: customersTable.tableArn,
      description: 'Customers table ARN',
    });
    new cdk.CfnOutput(this, 'OrdersTableName', {
      value: ordersTable.tableName,
      description: 'Orders table name',
    });
    new cdk.CfnOutput(this, 'OrdersTableArn', {
      value: ordersTable.tableArn,
      description: 'Orders table ARN',
    });
    new cdk.CfnOutput(this, 'MenuTableName', {
      value: menuTable.tableName,
      description: 'Menu table name',
    });
    new cdk.CfnOutput(this, 'MenuTableArn', {
      value: menuTable.tableArn,
      description: 'Menu table ARN',
    });
    new cdk.CfnOutput(this, 'CartsTableName', {
      value: cartsTable.tableName,
      description: 'Carts table name',
    });
    new cdk.CfnOutput(this, 'CartsTableArn', {
      value: cartsTable.tableArn,
      description: 'Carts table ARN',
    });
    new cdk.CfnOutput(this, 'LocationsTableName', {
      value: locationsTable.tableName,
      description: 'Locations table name',
    });
    new cdk.CfnOutput(this, 'LocationsTableArn', {
      value: locationsTable.tableArn,
      description: 'Locations table ARN',
    });
  }
}
