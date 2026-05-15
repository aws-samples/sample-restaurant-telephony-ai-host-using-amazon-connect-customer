import * as cdk from 'aws-cdk-lib';
import * as location from 'aws-cdk-lib/aws-location';
import { Construct } from 'constructs';

/**
 * {prefix}-LocationStack — place-index + route-calculator.
 *
 * Ported from reference-project/backend/backend-infrastructure/lib/location-stack.ts.
 * Changes vs reference:
 *   • `DeploymentPrefix` CfnParameter declared locally (R19).
 *   • `indexName: 'QSRRestaurantIndex'` → `cdk.Fn.sub('${P}-RestaurantIndex', …)`.
 *   • `calculatorName: 'QSRRouteCalculator'` → `cdk.Fn.sub('${P}-RouteCalculator', …)`.
 *   • `CfnMap` dropped entirely — frontend-only (design §8 non-goal #7).
 *   • CfnOutput `exportName` clauses stripped (P5).
 */
export class LocationStack extends cdk.Stack {
  public readonly placeIndex: location.CfnPlaceIndex;
  public readonly routeCalculator: location.CfnRouteCalculator;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // Place Index for geocoding and place search
    this.placeIndex = new location.CfnPlaceIndex(this, 'QSRPlaceIndex', {
      indexName: cdk.Fn.sub('${P}-RestaurantIndex', { P: prefix }),
      dataSource: 'Esri',
      description: 'Place index for QSR restaurant geocoding and search',
      pricingPlan: 'RequestBasedUsage',
    });

    // Route Calculator for route optimization
    this.routeCalculator = new location.CfnRouteCalculator(
      this,
      'QSRRouteCalculator',
      {
        calculatorName: cdk.Fn.sub('${P}-RouteCalculator', { P: prefix }),
        dataSource: 'Esri',
        description: 'Route calculator for QSR restaurant route optimization',
        pricingPlan: 'RequestBasedUsage',
      },
    );

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'PlaceIndexName', {
      value: this.placeIndex.indexName,
      description: 'Place Index name for geocoding and address search',
    });
    new cdk.CfnOutput(this, 'PlaceIndexArn', {
      value: this.placeIndex.attrIndexArn,
      description: 'Place Index ARN',
    });
    new cdk.CfnOutput(this, 'RouteCalculatorName', {
      value: this.routeCalculator.calculatorName,
      description: 'Route Calculator name for route optimization',
    });
    new cdk.CfnOutput(this, 'RouteCalculatorArn', {
      value: this.routeCalculator.attrCalculatorArn,
      description: 'Route Calculator ARN',
    });
  }
}
