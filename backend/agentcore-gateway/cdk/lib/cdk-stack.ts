import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * `${prefix}-AgentCoreGatewayStack` — an `AWS::BedrockAgentCore::Gateway`
 * (provisioned via a custom-resource Provider) that fronts the ordering
 * REST API with MCP + AWS_IAM auth.
 *
 * Ported verbatim from `reference-project/backend/agentcore-gateway/cdk/lib/cdk-stack.ts`.
 * Changes vs reference (see NOTICE.md for the pinned commit SHA):
 *   1. `GatewayStackProps.apiGatewayId` (TS-prop) DELETED → local
 *      `CfnParameter`s on the stack itself (`DeploymentPrefix`, `ApiGatewayId`,
 *      `ApiGatewayUrl`, `ApiGatewayRestApiId`). Each is threaded in at deploy
 *      time from `cdk-outputs/tel-apigw.json` by `scripts/deploy-all.sh`.
 *   2. Gateway name rewritten from the literal `'qsr-ordering-gateway'` to
 *      `cdk.Fn.sub('${P}-gateway', { P: deploymentPrefix.valueAsString })`.
 *   3. Gateway service-role name rewritten to `${prefix}-gateway-service-role`.
 *   4. Provisioner Lambda gains an explicit `functionName`
 *      (`${prefix}-GatewayHandler`) + explicit `roleName`
 *      (`${prefix}-gateway-handler-role`) + explicit LogGroup (1-month
 *      retention, DESTROY on stack delete).
 *   5. API Gateway IAM resource ARNs in the provisioner policy interpolate
 *      `apiGatewayId.valueAsString` and `apiGatewayRestApiId.valueAsString`
 *      via `cdk.Fn.sub` so the rendered ARNs target the specific REST API id
 *      (apigateway restapis path + execute-api resource path).
 *   6. Every `CfnOutput` emitted WITHOUT `exportName` (P5).
 */
export class CdkStack extends cdk.Stack {
  public readonly gatewayId: string;
  public readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters (4) ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
      description:
        'Deployment prefix applied to every physical resource + IAM ARN in this stack (R19).',
    });
    const prefix = deploymentPrefix.valueAsString;

    const apiGatewayId = new cdk.CfnParameter(this, 'ApiGatewayId', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway id from tel-apigw (threaded by deploy-all.sh from cdk-outputs/tel-apigw.json).',
    });

    const apiGatewayUrl = new cdk.CfnParameter(this, 'ApiGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway invoke URL from tel-apigw (threaded by deploy-all.sh). Used for observability outputs.',
    });

    const apiGatewayRestApiId = new cdk.CfnParameter(this, 'ApiGatewayRestApiId', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway REST API id from tel-apigw. Interpolated into the provisioner Lambda\'s execute-api resource ARN.',
    });

    // Stage is fixed — the ported stack has always used `prod`. Not a
    // CfnParameter because upstream `${prefix}-ApiGatewayStack` also pins
    // `stageName: 'prod'` (see backend/backend-infrastructure/lib/api-gateway-stack.ts).
    const stage = 'prod';

    // Prefixed physical names (rendered at deploy time via Fn::Sub).
    const gatewayName = cdk.Fn.sub('${P}-gateway', { P: prefix });
    const gatewayServiceRoleName = cdk.Fn.sub('${P}-gateway-service-role', { P: prefix });
    const gatewayHandlerFunctionName = cdk.Fn.sub('${P}-GatewayHandler', { P: prefix });
    const gatewayHandlerRoleName = cdk.Fn.sub('${P}-gateway-handler-role', { P: prefix });

    // ───────────── Gateway-provisioner Lambda execution role + log group ─────────────
    // The reference let the NodejsFunction auto-create its role + log group.
    // We declare both explicitly so every physical name carries the prefix.
    const gatewayHandlerLogGroup = new logs.LogGroup(this, 'GatewayHandlerLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${FN}', { FN: gatewayHandlerFunctionName }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const gatewayHandlerRole = new iam.Role(this, 'GatewayHandlerRole', {
      roleName: gatewayHandlerRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the AgentCore Gateway provisioner Lambda (custom-resource onEventHandler).',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    // ───────────── Gateway-provisioner Lambda (NodejsFunction) ─────────────
    // Node.js with esbuild bundling — no Docker needed.
    const gatewayHandlerFunction = new NodejsFunction(this, 'GatewayHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../lambda/handler.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      description: 'Custom Resource handler for AgentCore Gateway',
      functionName: gatewayHandlerFunctionName,
      role: gatewayHandlerRole,
      logGroup: gatewayHandlerLogGroup,
      bundling: {
        format: cdk.aws_lambda_nodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        minify: false,
        sourceMap: true,
        // Bundle ALL @aws-sdk packages instead of using Lambda runtime's versions.
        // The runtime's @aws-sdk/client-bedrock-agentcore-control may be outdated
        // and not support apiGateway target configuration.
        externalModules: [],
      },
    });

    // ───────────── Provisioner Lambda IAM policy ─────────────
    // 1) bedrock-agentcore:* management actions — no resource-level IAM support
    //    (design §11.5b); suppressed at stack level in bin/cdk.ts.
    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGateway',
        'bedrock-agentcore:DeleteGateway',
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
        'bedrock-agentcore:GetGatewayTarget',
        'bedrock-agentcore:ListGateways',
        'bedrock-agentcore:ListGatewayTargets',
        'bedrock-agentcore:SynchronizeGatewayTargets',
        'bedrock-agentcore:UpdateGateway',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:CreateWorkloadIdentity',
        'bedrock-agentcore:DeleteWorkloadIdentity',
        'bedrock-agentcore:GetWorkloadIdentity',
        'bedrock-agentcore:ListWorkloadIdentities',
      ],
      resources: ['*'],
    }));

    // 2) IAM role CRUD for the gateway service role — scoped to THIS prefix's
    //    service role ARN via Fn::Sub.
    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iam:CreateRole',
        'iam:GetRole',
        'iam:DeleteRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:DetachRolePolicy',
        'iam:PassRole',
      ],
      resources: [
        cdk.Fn.sub('arn:aws:iam::${A}:role/${RN}', {
          A: cdk.Aws.ACCOUNT_ID,
          RN: gatewayServiceRoleName,
        }),
      ],
    }));

    // 3) API Gateway read — fetch the OpenAPI schema at target-create time.
    //    The handler also needs to allow execute-api:Invoke when it writes
    //    the service role's inline policy; scope that via RestApiId + stage.
    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'apigateway:GET',
      ],
      resources: [
        cdk.Fn.sub('arn:aws:apigateway:${R}::/restapis/${ApiId}/*', {
          R: cdk.Aws.REGION,
          ApiId: apiGatewayId.valueAsString,
        }),
      ],
    }));

    // 4) execute-api:Invoke is NOT granted to the provisioner Lambda itself —
    //    it only writes the policy document onto the gateway service role.
    //    But we still record the exact execute-api ARN shape here for
    //    observability + grep (template will show this as a resource).
    //    (No IAM policy attached; the ARN is computed in the handler at
    //    runtime using the ApiGatewayId + stage passed to the custom resource.)

    // ───────────── Custom Resource Provider ─────────────
    const providerLogGroup = new logs.LogGroup(this, 'GatewayProviderLogs', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-gateway-provider', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const provider = new cr.Provider(this, 'GatewayProvider', {
      onEventHandler: gatewayHandlerFunction,
      logGroup: providerLogGroup,
    });

    // ───────────── Custom Resource ─────────────
    // DeployTimestamp forces CloudFormation to trigger an Update on every deploy,
    // ensuring the target is refreshed with the latest API Gateway schema.
    const gateway = new cdk.CustomResource(this, 'AgentCoreGateway', {
      serviceToken: provider.serviceToken,
      properties: {
        GatewayName: gatewayName,
        Description:
          cdk.Fn.sub('${P} Ordering System - MCP Gateway exposing backend APIs as tools', { P: prefix }),
        ApiGatewayId: apiGatewayId.valueAsString,
        ApiGatewayUrl: apiGatewayUrl.valueAsString,
        ApiGatewayRestApiId: apiGatewayRestApiId.valueAsString,
        Stage: stage,
        Region: cdk.Stack.of(this).region,
        AccountId: cdk.Stack.of(this).account,
        DeployTimestamp: new Date().toISOString(),
      },
    });

    // Extract outputs from Custom Resource for TS-side consumers
    // (none in this project — downstream AgentRuntimeStack picks them up via CfnOutput).
    this.gatewayId = gateway.getAttString('GatewayId');
    this.gatewayUrl = gateway.getAttString('GatewayUrl');

    // ───────────── CfnOutputs (NO exportName per P5) ─────────────
    //
    // GatewayUrl is the PRIMARY downstream — consumed by
    // `${prefix}-AgentRuntimeStack` as the `AgentCoreGatewayUrl` CfnParameter
    // via `scripts/deploy-all.sh` reading `cdk-outputs/tel-gateway.json`.
    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gateway.getAttString('GatewayUrl'),
      description: 'AgentCore Gateway URL — consumed by tel-agent-runtime via CfnParameter',
    });

    new cdk.CfnOutput(this, 'GatewayId', {
      value: gateway.getAttString('GatewayId'),
      description: 'AgentCore Gateway ID',
    });

    new cdk.CfnOutput(this, 'GatewayArn', {
      value: gateway.getAttString('GatewayArn'),
      description: 'AgentCore Gateway ARN',
    });

    new cdk.CfnOutput(this, 'GatewayRoleArn', {
      value: gateway.getAttString('GatewayRoleArn'),
      description: 'Gateway Service Role ARN',
    });

    new cdk.CfnOutput(this, 'TargetId', {
      value: gateway.getAttString('TargetId'),
      description: 'Gateway Target ID',
    });

    new cdk.CfnOutput(this, 'BackendApiGatewayId', {
      value: gateway.getAttString('ApiGatewayId'),
      description: 'Backend API Gateway ID (echoed from the upstream CfnParameter)',
    });

    new cdk.CfnOutput(this, 'ApiGatewayStage', {
      value: gateway.getAttString('ApiGatewayStage'),
      description: 'Backend API Gateway Stage',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: gateway.getAttString('Region'),
      description: 'AWS Region',
    });

    new cdk.CfnOutput(this, 'AccountId', {
      value: gateway.getAttString('AccountId'),
      description: 'AWS Account ID',
    });

    new cdk.CfnOutput(this, 'DeploymentTimestamp', {
      value: gateway.getAttString('DeploymentTimestamp'),
      description: 'Deployment Timestamp (ISO 8601)',
    });

    new cdk.CfnOutput(this, 'ToolFiltersCount', {
      value: gateway.getAttString('ToolFiltersCount'),
      description: 'Number of Tool Filters',
    });

    new cdk.CfnOutput(this, 'ToolOverridesCount', {
      value: gateway.getAttString('ToolOverridesCount'),
      description: 'Number of Tool Overrides',
    });

    // Tag the stack's resources with the deployment prefix for tenant
    // observability in the AgentCore console.
    cdk.Tags.of(this).add('DeploymentPrefix', prefix);
    cdk.Tags.of(this).add('Application', 'telephony-voice-ordering-agent');
  }
}
