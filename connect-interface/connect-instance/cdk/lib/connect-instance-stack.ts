import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * ConnectInstanceStack
 *
 * Creates the Connect instance and Q in Connect assistant.
 * HoursOfOperation and Queue are NOT created here — not needed for demo.
 *
 * CfnOutputs:
 *   - ConnectInstanceArn  -> full instance ARN
 *   - ConnectInstanceId   -> UUID
 *   - AssistantId         -> UUID
 *   - AssistantArn        -> full ARN
 */
export class ConnectInstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── CfnParameter ────────────────────────────────────────────────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription: 'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // ─── Connect Instance ─────────────────────────────────────────────────────
    const instance = new connect.CfnInstance(this, 'ConnectInstance', {
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: cdk.Fn.sub('${P}-restaurant', { P: prefix }),
      attributes: {
        inboundCalls: true,
        outboundCalls: false,
        contactflowLogs: true,
        contactLens: true,           // required for AI Agent voice
        autoResolveBestVoices: true,
        useCustomTtsVoices: false,
        earlyMedia: true,
      },
    });

    // ─── AppIntegrations service-linked role ─────────────────────────────────
    // Create AWSServiceRoleForAppIntegrations if it doesn't already exist.
    // ignoreErrorCodesMatching handles the case where it already exists.
    const appIntegrationsSlr = new cr.AwsCustomResource(this, 'AppIntegrationsServiceLinkedRole', {
      onCreate: {
        service: 'IAM',
        action: 'createServiceLinkedRole',
        parameters: {
          AWSServiceName: 'app-integrations.amazonaws.com',
        },
        physicalResourceId: cr.PhysicalResourceId.of('AWSServiceRoleForAppIntegrations'),
        ignoreErrorCodesMatching: 'InvalidInput',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // ─── Connect Customer enabler (Custom Resource) ───────────────────────────
    // Enables ENHANCED_CONTACT_MONITORING (Connect AI Agents) and BOT_MANAGEMENT
    // (required for Lex bots with Agentic Voice) on the Connect instance.
    const enablerLogGroup = new logs.LogGroup(this, 'ConnectCustomerEnablerLogGroup', {
      logGroupName: cdk.Fn.sub('/aws/lambda/${P}-connect-customer-enabler', { P: prefix }),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const enablerRole = new iam.Role(this, 'ConnectCustomerEnablerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Connect Customer enabler custom-resource Lambda',
    });

    enablerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ConnectCustomerToggle',
      actions: [
        'connect:UpdateInstanceAttribute',
        'connect:DescribeInstanceAttribute',
      ],
      // Scoped to the specific Connect instance this Lambda manages.
      // connect:UpdateInstanceAttribute supports resource-level permissions —
      // see https://docs.aws.amazon.com/connect/latest/adminguide/security_iam_service-with-iam.html
      resources: [
        cdk.Fn.sub('arn:aws:connect:${AWS::Region}:${AWS::AccountId}:instance/${InstanceId}', {
          InstanceId: instance.attrId,
        }),
      ],
    }));

    // iam:PutRolePolicy required when enabling BOT_MANAGEMENT —
    // Connect internally updates its service-linked role policy for that attribute.
    enablerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IamForConnectBotManagement',
      actions: ['iam:PutRolePolicy'],
      resources: [
        cdk.Fn.sub('arn:aws:iam::${AWS::AccountId}:role/aws-service-role/connect.amazonaws.com/*'),
      ],
    }));

    enablerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        enablerLogGroup.logGroupArn,
        cdk.Fn.sub('${Arn}:*', { Arn: enablerLogGroup.logGroupArn }),
      ],
    }));

    const enablerFn = new NodejsFunction(this, 'ConnectCustomerEnablerFn', {
      functionName: cdk.Fn.sub('${P}-connect-customer-enabler', { P: prefix }),
      entry: path.join(__dirname, '..', 'lambda', 'connect-customer-enabler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      role: enablerRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: enablerLogGroup,
      bundling: {
        format: OutputFormat.CJS,
        target: 'node24',
        minify: false,
        sourceMap: false,
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
    });

    const enablerProviderLogGroup = new logs.LogGroup(this, 'ConnectCustomerEnablerProviderLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const enablerProvider = new cr.Provider(this, 'ConnectCustomerEnablerProvider', {
      onEventHandler: enablerFn,
      logGroup: enablerProviderLogGroup,
    });

    const connectCustomerEnabler = new cdk.CustomResource(this, 'ConnectCustomerEnabler', {
      serviceToken: enablerProvider.serviceToken,
      properties: {
        InstanceId: instance.attrId,
      },
    });
    connectCustomerEnabler.node.addDependency(instance);

    // ─── Q in Connect Assistant ───────────────────────────────────────────────
    const assistant = new wisdom.CfnAssistant(this, 'QConnectAssistant', {
      name: cdk.Fn.sub('${P}-assistant', { P: prefix }),
      type: 'AGENT',
      description: 'Q in Connect Assistant for restaurant AI ordering agent',
    });
    assistant.node.addDependency(connectCustomerEnabler);

    // ─── IntegrationAssociation: Connect instance ↔ Q in Connect Assistant ───
    const assistantAssociation = new connect.CfnIntegrationAssociation(this, 'AssistantAssociation', {
      instanceId: instance.attrArn,
      integrationType: 'WISDOM_ASSISTANT',
      integrationArn: assistant.attrAssistantArn,
    });
    assistantAssociation.node.addDependency(assistant);
    assistantAssociation.node.addDependency(connectCustomerEnabler);

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ConnectInstanceArn', {
      value: instance.attrArn,
      description: 'Connect instance ARN (full).',
    });

    new cdk.CfnOutput(this, 'ConnectInstanceId', {
      value: instance.attrId,
      description: 'Connect instance UUID.',
    });

    new cdk.CfnOutput(this, 'AssistantId', {
      value: assistant.attrAssistantId,
      description: 'Q in Connect Assistant UUID',
    });

    new cdk.CfnOutput(this, 'AssistantArn', {
      value: assistant.attrAssistantArn,
      description: 'Q in Connect Assistant ARN',
    });
  }
}
