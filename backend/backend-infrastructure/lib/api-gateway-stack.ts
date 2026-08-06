import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * {prefix}-ApiGatewayStack — the REST API.
 *
 * Ported from reference-project/backend/backend-infrastructure/lib/api-gateway-stack.ts.
 * Changes vs reference:
 *   • `DeploymentPrefix` + ten `*LambdaArn` CfnParameters declared locally.
 *     The ten Lambda ARNs flow in from `cdk-outputs/tel-lambdas.json` at deploy
 *     time; the stack resolves each via `lambda.Function.fromFunctionArn`.
 *   • No more `userPool` / `CognitoUserPoolsAuthorizer` wiring (design §8 non-goal #8).
 *     Every method keeps `AuthorizationType.IAM` (which the reference already uses).
 *   • `restApiName` parameterized via `cdk.Fn.sub('${P}-Ordering-API', …)`.
 *   • Access-log group path parameterized via `cdk.Fn.sub('/aws/apigateway/${P}-api-access-logs', …)`.
 *   • CfnOutput `exportName` clauses stripped (P5).
 */
export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // Ten CfnParameters — one per ordering Lambda ARN.
    const mkArnParam = (name: string, desc: string) =>
      new cdk.CfnParameter(this, name, {
        type: 'String',
        minLength: 1,
        description: desc,
      });

    const getCustomerProfileArn = mkArnParam(
      'GetCustomerProfileLambdaArn',
      'ARN of GetCustomerProfile Lambda (from cdk-outputs/tel-lambdas.json)',
    );
    const getPreviousOrdersArn = mkArnParam(
      'GetPreviousOrdersLambdaArn',
      'ARN of GetPreviousOrders Lambda',
    );
    const getMenuArn = mkArnParam('GetMenuLambdaArn', 'ARN of GetMenu Lambda');
    const addToCartArn = mkArnParam(
      'AddToCartLambdaArn',
      'ARN of AddToCart Lambda',
    );
    const getCartArn = mkArnParam('GetCartLambdaArn', 'ARN of GetCart Lambda');
    const updateCartArn = mkArnParam(
      'UpdateCartLambdaArn',
      'ARN of UpdateCart Lambda',
    );
    const placeOrderArn = mkArnParam(
      'PlaceOrderLambdaArn',
      'ARN of PlaceOrder Lambda',
    );
    const getNearestLocationsArn = mkArnParam(
      'GetNearestLocationsLambdaArn',
      'ARN of GetNearestLocations Lambda',
    );
    const findLocationAlongRouteArn = mkArnParam(
      'FindLocationAlongRouteLambdaArn',
      'ARN of FindLocationAlongRoute Lambda',
    );
    const geocodeAddressArn = mkArnParam(
      'GeocodeAddressLambdaArn',
      'ARN of GeocodeAddress Lambda',
    );

    // Resolve each ARN back to an IFunction. `fromFunctionArn` produces a
    // handle suitable for `LambdaIntegration` — but because the Lambda was
    // created in a different stack, CDK cannot automatically add the
    // resource-based `AWS::Lambda::Permission` that lets API Gateway invoke
    // it. We add those permissions explicitly below (see `addInvokePermission`)
    // after the RestApi is constructed so we know `this.api.restApiId` is
    // available.
    const fn = (id: string, arnParam: cdk.CfnParameter) =>
      lambda.Function.fromFunctionAttributes(this, id, {
        functionArn: arnParam.valueAsString,
        sameEnvironment: true,
      });

    const getCustomerProfile = fn(
      'GetCustomerProfileRef',
      getCustomerProfileArn,
    );
    const getPreviousOrders = fn(
      'GetPreviousOrdersRef',
      getPreviousOrdersArn,
    );
    const getMenu = fn('GetMenuRef', getMenuArn);
    const addToCart = fn('AddToCartRef', addToCartArn);
    const getCart = fn('GetCartRef', getCartArn);
    const updateCart = fn('UpdateCartRef', updateCartArn);
    const placeOrder = fn('PlaceOrderRef', placeOrderArn);
    const getNearestLocations = fn(
      'GetNearestLocationsRef',
      getNearestLocationsArn,
    );
    const findLocationAlongRoute = fn(
      'FindLocationAlongRouteRef',
      findLocationAlongRouteArn,
    );
    const geocodeAddress = fn('GeocodeAddressRef', geocodeAddressArn);

    // CloudWatch access-log group.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: cdk.Fn.sub('/aws/apigateway/${P}-api-access-logs', {
        P: prefix,
      }),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // REST API.
    this.api = new apigateway.RestApi(this, 'QSRApi', {
      restApiName: cdk.Fn.sub('${P}-Ordering-API', { P: prefix }),
      description:
        'REST API for QSR ordering system (AgentCore Gateway + telephony agent are the only callers; AWS_IAM authz)',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // ───── Lambda invoke permissions (one AWS::Lambda::Permission per fn) ─────
    //
    // Every Lambda integrated via `LambdaIntegration` needs a resource-based
    // policy allowing `apigateway.amazonaws.com` to `lambda:InvokeFunction` on
    // it, scoped to this REST API's source ARN. CDK auto-generates these
    // statements when the Function construct is in the same synth tree — but
    // here we split the stacks and the Lambdas arrive via `fromFunctionArn`,
    // so we must emit the permission ourselves or API Gateway returns
    // `"Execution failed due to configuration error: Invalid permissions on
    // Lambda function"` and every method returns 500.
    //
    // Source ARN pattern `${apiArn}/*/*/*` covers stage/method/resource —
    // the three-wildcard form API Gateway recommends for integrations that
    // don't need tight method-level scoping.
    const lambdaPermissionTargets: { id: string; arnParam: cdk.CfnParameter }[] = [
      { id: 'GetCustomerProfilePermission', arnParam: getCustomerProfileArn },
      { id: 'GetPreviousOrdersPermission', arnParam: getPreviousOrdersArn },
      { id: 'GetMenuPermission', arnParam: getMenuArn },
      { id: 'AddToCartPermission', arnParam: addToCartArn },
      { id: 'GetCartPermission', arnParam: getCartArn },
      { id: 'UpdateCartPermission', arnParam: updateCartArn },
      { id: 'PlaceOrderPermission', arnParam: placeOrderArn },
      { id: 'GetNearestLocationsPermission', arnParam: getNearestLocationsArn },
      { id: 'FindLocationAlongRoutePermission', arnParam: findLocationAlongRouteArn },
      { id: 'GeocodeAddressPermission', arnParam: geocodeAddressArn },
    ];
    const apiSourceArn = cdk.Fn.sub(
      'arn:aws:execute-api:${R}:${A}:${Id}/*/*/*',
      {
        R: cdk.Aws.REGION,
        A: cdk.Aws.ACCOUNT_ID,
        Id: this.api.restApiId,
      },
    );
    for (const t of lambdaPermissionTargets) {
      new lambda.CfnPermission(this, t.id, {
        action: 'lambda:InvokeFunction',
        functionName: t.arnParam.valueAsString,
        principal: 'apigateway.amazonaws.com',
        sourceArn: apiSourceArn,
      });
    }

    // Response models
    const successResponseModel = this.api.addModel('SuccessResponse', {
      contentType: 'application/json',
      modelName: 'SuccessResponse',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Success Response',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          statusCode: { type: apigateway.JsonSchemaType.INTEGER },
          body: { type: apigateway.JsonSchemaType.STRING },
        },
      },
    });

    const errorResponseModel = this.api.addModel('ErrorResponse', {
      contentType: 'application/json',
      modelName: 'ErrorResponse',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Error Response',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          statusCode: { type: apigateway.JsonSchemaType.INTEGER },
          message: { type: apigateway.JsonSchemaType.STRING },
        },
      },
    });

    // Request body models.
    const addToCartRequestModel = this.api.addModel('AddToCartRequest', {
      contentType: 'application/json',
      modelName: 'AddToCartRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Add To Cart Request',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          customerId: { type: apigateway.JsonSchemaType.STRING },
          locationId: { type: apigateway.JsonSchemaType.STRING },
          items: {
            type: apigateway.JsonSchemaType.ARRAY,
            items: {
              type: apigateway.JsonSchemaType.OBJECT,
              properties: {
                itemId: { type: apigateway.JsonSchemaType.STRING },
                quantity: { type: apigateway.JsonSchemaType.INTEGER },
              },
              required: ['itemId', 'quantity'],
            },
          },
        },
        required: ['customerId', 'locationId', 'items'],
      },
    });

    const placeOrderRequestModel = this.api.addModel('PlaceOrderRequest', {
      contentType: 'application/json',
      modelName: 'PlaceOrderRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'Place Order Request',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          customerId: { type: apigateway.JsonSchemaType.STRING },
          locationId: { type: apigateway.JsonSchemaType.STRING },
          channel: { type: apigateway.JsonSchemaType.STRING },
          anonymousCaller: { type: apigateway.JsonSchemaType.BOOLEAN },
          fromPhoneNumber: { type: apigateway.JsonSchemaType.STRING },
        },
        required: ['customerId', 'locationId'],
      },
    });

    const requestValidator = new apigateway.RequestValidator(
      this,
      'RequestValidator',
      {
        restApi: this.api,
        requestValidatorName: 'request-body-validator',
        validateRequestBody: true,
        validateRequestParameters: true,
      },
    );

    // Lambda integrations (proxy).
    const integ = (f: lambda.IFunction) =>
      new apigateway.LambdaIntegration(f, {
        proxy: true,
        allowTestInvoke: true,
      });

    // Customer ops
    const customers = this.api.root.addResource('customers', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
      },
    });

    const customerProfile = customers.addResource('profile');
    customerProfile.addMethod('GET', integ(getCustomerProfile), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetCustomerProfile',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
    });

    const orders = customers.addResource('orders');
    orders.addMethod('GET', integ(getPreviousOrders), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetPreviousOrders',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
    });

    // Menu
    const menu = this.api.root.addResource('menu');
    menu.addMethod('GET', integ(getMenu), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetMenu',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.locationId': true,
      },
    });

    // Cart
    const cart = this.api.root.addResource('cart');
    cart.addMethod('POST', integ(addToCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'AddToCart',
      requestValidator,
      requestModels: { 'application/json': addToCartRequestModel },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });
    cart.addMethod('GET', integ(getCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetCart',
      requestParameters: {
        'method.request.querystring.customerId': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });
    cart.addMethod('PUT', integ(updateCart), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'UpdateCart',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });

    // Order
    const order = this.api.root.addResource('order');
    order.addMethod('POST', integ(placeOrder), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'PlaceOrder',
      requestValidator,
      requestModels: { 'application/json': placeOrderRequestModel },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
    });

    // Locations
    const locations = this.api.root.addResource('locations');
    const nearest = locations.addResource('nearest');
    nearest.addMethod('GET', integ(getNearestLocations), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GetNearestLocations',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.latitude': true,
        'method.request.querystring.longitude': true,
        'method.request.querystring.maxResults': false,
      },
    });

    const route = locations.addResource('route');
    route.addMethod('GET', integ(findLocationAlongRoute), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'FindLocationAlongRoute',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.startLatitude': true,
        'method.request.querystring.startLongitude': true,
        'method.request.querystring.endLatitude': true,
        'method.request.querystring.endLongitude': true,
        'method.request.querystring.maxDetourMinutes': false,
      },
    });

    const geocode = locations.addResource('geocode');
    geocode.addMethod('GET', integ(geocodeAddress), {
      authorizationType: apigateway.AuthorizationType.IAM,
      operationName: 'GeocodeAddress',
      methodResponses: [
        {
          statusCode: '200',
          responseModels: { 'application/json': successResponseModel },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        { statusCode: '400', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '401', responseModels: { 'application/json': errorResponseModel } },
        { statusCode: '500', responseModels: { 'application/json': errorResponseModel } },
      ],
      requestParameters: {
        'method.request.querystring.address': true,
      },
    });

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      description: 'API Gateway endpoint URL',
    });
    new cdk.CfnOutput(this, 'ApiGatewayId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
    });
    new cdk.CfnOutput(this, 'ApiGatewayRestApiId', {
      value: this.api.restApiId,
      description:
        'API Gateway REST API ID (consumed by AgentCoreGatewayStack for its execute-api resource ARN)',
    });
    new cdk.CfnOutput(this, 'ApiGatewayArn', {
      value: cdk.Fn.sub('arn:aws:execute-api:${R}:${A}:${Id}/*', {
        R: this.region,
        A: this.account,
        Id: this.api.restApiId,
      }),
      description: 'API Gateway ARN for IAM permissions',
    });

    // ───────────── cdk-nag suppressions ─────────────
    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-COG4',
          reason:
            'REST API uses AWS_IAM authorization, not a Cognito User Pool Authorizer. Cognito is deliberately out of scope for telephony (design §8 non-goal #8); the AgentCore Gateway SigV4-invokes this API using its own IAM role.',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason:
            'WAF is out of scope for the MVP (design §8 non-goals). Revisit before production.',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'CORS preflight OPTIONS methods use `AuthorizationType.NONE` by design — authenticated OPTIONS is not a pattern supported by CloudFront/browsers. All non-OPTIONS methods use AWS_IAM.',
        },
      ],
      true,
    );
  }
}
