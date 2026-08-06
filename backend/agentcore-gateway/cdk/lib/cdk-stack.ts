import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * `${prefix}-AgentCoreGatewayStack` — provisions an AgentCore Gateway with
 * CUSTOM_JWT inbound auth so Amazon Connect can invoke MCP tools.
 *
 * Creates:
 *   - AgentCore Gateway (CUSTOM_JWT auth, MCP protocol) via custom resource
 *
 * CfnParameters:
 *   DeploymentPrefix    — resource name prefix
 *   ApiGatewayId        — REST API ID from cn-apigw
 *   ApiGatewayUrl       — API Gateway invoke URL from cn-apigw
 *   ApiGatewayRestApiId — REST API ID from cn-apigw
 *   ConnectInstanceUrl  — Connect instance URL for JWT inbound auth discovery
 *
 * CfnOutputs:
 *   GatewayId    — consumed by cn-ai-agent
 *   GatewayUrl   — AgentCore Gateway MCP endpoint, consumed by cn-ai-agent
 *   + observability outputs
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameters (6) ─────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
      description:
        'Deployment prefix applied to every physical resource + IAM ARN in this stack.',
    });
    const prefix = deploymentPrefix.valueAsString;

    const apiGatewayId = new cdk.CfnParameter(this, 'ApiGatewayId', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway id from cn-apigw (threaded by deploy-all.sh from cdk-outputs/cn-apigw.json).',
    });

    const apiGatewayUrl = new cdk.CfnParameter(this, 'ApiGatewayUrl', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway invoke URL from cn-apigw.',
    });

    const apiGatewayRestApiId = new cdk.CfnParameter(this, 'ApiGatewayRestApiId', {
      type: 'String',
      minLength: 1,
      description:
        'API Gateway REST API id from cn-apigw.',
    });

    // ConnectInstanceUrl: the Amazon Connect instance URL (without trailing slash).
    // Used to configure CUSTOM_JWT inbound auth on the AgentCore Gateway so that
    // Connect can authenticate when invoking MCP tools.
    // Example: https://qsr-cn-restaurant.my.connect.aws
    // Format: https://<instance-alias>.my.connect.aws
    const connectInstanceUrl = new cdk.CfnParameter(this, 'ConnectInstanceUrl', {
      type: 'String',
      minLength: 1,
      description:
        'Connect instance URL (e.g. https://qsr-cn-restaurant.my.connect.aws). Used for JWT inbound auth on the gateway.',
    });

    // Stage is fixed — the ported stack has always used `prod`. Not a
    // CfnParameter because upstream `${prefix}-ApiGatewayStack` also pins
    // `stageName: 'prod'` (see backend/backend-infrastructure/lib/api-gateway-stack.ts).
    const stage = 'prod';

    // Prefixed physical names (rendered at deploy time via Fn::Sub).
    const gatewayName = cdk.Fn.sub('${P}-gateway', { P: prefix });
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
    // 1) bedrock-agentcore gateway management actions.
    // Gateway ARN pattern: arn:aws:bedrock-agentcore:REGION:ACCOUNT:gateway/${gatewayName}-{random}
    // CreateGateway and ListGateways cannot be scoped to a specific gateway ARN
    // because the gateway ID is not known until after creation. All other actions
    // are scoped to the specific gateway name prefix this Lambda manages.
    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreGatewayCreate',
      actions: [
        // CreateGateway and List* cannot be scoped — gateway ID is unknown at create time.
        // See: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html
        'bedrock-agentcore:CreateGateway',
        'bedrock-agentcore:ListGateways',
        'bedrock-agentcore:ListGatewayTargets',
        'bedrock-agentcore:CreateWorkloadIdentity',
        'bedrock-agentcore:ListWorkloadIdentities',
        'bedrock-agentcore:DeleteWorkloadIdentity',
      ],
      resources: ['*'],
    }));

    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreGatewayManage',
      actions: [
        'bedrock-agentcore:DeleteGateway',
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
        'bedrock-agentcore:GetGatewayTarget',
        'bedrock-agentcore:SynchronizeGatewayTargets',
        'bedrock-agentcore:UpdateGateway',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:DeleteWorkloadIdentity',
        'bedrock-agentcore:GetWorkloadIdentity',
      ],
      // Scoped to the gateway name prefix this Lambda manages.
      // Gateway ARN format: arn:aws:bedrock-agentcore:REGION:ACCOUNT:gateway/${gatewayName}-{10chars}
      resources: [
        cdk.Fn.sub(
          'arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:gateway/${P}-gateway*',
          { P: prefix },
        ),
      ],
    }));

    // 2) IAM role CRUD for the gateway service role.
    // The handler creates a /service-role/ path role named
    // AmazonBedrockAgentCoreGatewayServiceRole-${gatewayName} and a managed
    // policy named AmazonBedrockAgentCoreGatewayBasePolicyProd-${gatewayId}.
    // Resources are scoped to exactly those name patterns + /service-role/ path.
    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iam:CreateRole',
        'iam:GetRole',
        'iam:DeleteRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:PassRole',
      ],
      resources: [
        cdk.Fn.sub(
          'arn:aws:iam::${AWS::AccountId}:role/service-role/AmazonBedrockAgentCoreGatewayServiceRole-${P}-gateway*',
          { P: prefix },
        ),
      ],
    }));

    gatewayHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iam:CreatePolicy',
        'iam:DeletePolicy',
        'iam:GetPolicy',
      ],
      resources: [
        cdk.Fn.sub(
          'arn:aws:iam::${AWS::AccountId}:policy/service-role/AmazonBedrockAgentCoreGatewayBasePolicyProd-*',
        ),
      ],
    }));

    // 3) API Gateway read — fetch the OpenAPI schema at target-create time.
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
    // Note: NO explicit logGroupName on the framework log group below —
    // when both the CFN-managed log group and AWS Lambda's lazy
    // auto-create logic target the same name, the framework Lambda's
    // last-invocation flush during stack delete recreates the group
    // outside CFN's ownership and the orphan blocks the next deploy.
    // CDK's auto-generated hash-suffixed name avoids the collision.
    const providerLogGroup = new logs.LogGroup(this, 'GatewayProviderLogs', {
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
        // ConnectInstanceUrl enables CUSTOM_JWT inbound auth so Amazon Connect
        // can authenticate when invoking MCP tools through this gateway.
        ConnectInstanceUrl: connectInstanceUrl.valueAsString,
      },
    });

    // ───────────── CfnOutputs ─────────────
    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gateway.getAttString('GatewayUrl'),
      description: 'AgentCore Gateway MCP endpoint URL',
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
    cdk.Tags.of(this).add('Application', 'restaurant-connect-ai-host');

    // McpNamespace = GatewayId — consumed by cn-ai-agent for:
    //   1. AppIntegrations registration (done in cn-ai-agent where Connect instance is known)
    //   2. Security profile namespace
    //   3. MCP toolId construction
    new cdk.CfnOutput(this, 'McpNamespace', {
      value: gateway.getAttString('GatewayId'),
      description: 'AppIntegrations namespace for the MCP server (= gateway ID)',
    });
  }
}
