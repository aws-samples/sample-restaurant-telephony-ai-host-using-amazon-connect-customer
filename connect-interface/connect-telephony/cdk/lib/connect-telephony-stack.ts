import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * ConnectTelephonyStack
 *
 * Creates:
 *   - Contact flow (EnableLogs → SetCallerPhone → CreateWisdomSession → StoreSessionArn
 *     → ConnectParticipantWithLexBot → CheckTool → Disconnect)
 *   - Phone number claimed to the Connect instance
 *   - Phone number → contact flow association
 *
 * Note: No queue created — not needed for demo. Escalate path disconnects.
 * In production, wire the Escalate condition to TransferToQueue.
 *
 * CfnParameters:
 *   - DeploymentPrefix
 *   - ConnectInstanceArn  (full ARN, from cn-instance)
 *   - AssistantArn        (from cn-instance, required by CreateWisdomSession)
 *   - LexBotId            (from cn-ai-agent)
 *   - LexBotAliasId       (from cn-ai-agent)
 *   - PhoneCountryCode    (default US)
 *   - PhoneType           (default DID)
 *
 * CfnOutputs:
 *   - PhoneNumberE164
 *   - ContactFlowArn
 */
export class ConnectTelephonyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── CfnParameters ───────────────────────────────────────────────────────
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription: 'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    const connectInstanceArn = new cdk.CfnParameter(this, 'ConnectInstanceArn', {
      type: 'String', minLength: 1,
      description: 'Full Connect instance ARN from cn-instance',
    });

    const assistantArn = new cdk.CfnParameter(this, 'AssistantArn', {
      type: 'String', minLength: 1,
      description: 'Q in Connect assistant ARN from cn-instance (required for CreateWisdomSession)',
    });

    const lexBotId = new cdk.CfnParameter(this, 'LexBotId', {
      type: 'String', minLength: 1,
      description: 'Lex bot ID from cn-ai-agent',
    });

    const lexBotAliasId = new cdk.CfnParameter(this, 'LexBotAliasId', {
      type: 'String', minLength: 1,
      description: 'Lex bot alias ID from cn-ai-agent',
    });

    const phoneCountryCode = new cdk.CfnParameter(this, 'PhoneCountryCode', {
      type: 'String',
      default: 'US',
      description: 'ISO country code for the phone number. Default: US',
    });

    const phoneType = new cdk.CfnParameter(this, 'PhoneType', {
      type: 'String',
      default: 'DID',
      allowedValues: ['DID', 'TOLL_FREE'],
      description: 'Phone number type. Default: DID',
    });

    const pushSessionDataFnArn = new cdk.CfnParameter(this, 'PushSessionDataFnArn', {
      type: 'String', minLength: 1,
      description: 'Lambda ARN for pushing session data (from cn-ai-agent)',
    });

    // ─── Contact Flow ─────────────────────────────────────────────────────────
    // Flow: EnableLogs → SetCallerPhone → CreateWisdomSession → StoreSessionArn
    //       → ConnectParticipantWithLexBot → CheckTool → Disconnect
    //
    // SetCallerPhone captures the caller ANI into a contact attribute so it
    // is available throughout the session.
    //
    // CreateWisdomSession is MANDATORY — without it Lex throws:
    // "Amazon Lex needs active session for Q In Connect"
    //
    // CheckTool reads $.Lex.SessionAttributes.Tool — set by Q in Connect
    // when the ORCHESTRATION agent fires Complete or Escalate (RETURN_TO_CONTROL).
    // Both conditions disconnect for demo. In production, wire Escalate to a queue.
    const lexBotAliasArn = cdk.Fn.sub(
      'arn:aws:lex:${AWS::Region}:${AWS::AccountId}:bot-alias/${BotId}/${AliasId}',
      {
        BotId: lexBotId.valueAsString,
        AliasId: lexBotAliasId.valueAsString,
      },
    );

    const contactFlowContent = cdk.Fn.sub(
      JSON.stringify({
        Version: '2019-10-30',
        StartAction: 'EnableLogs',
        Actions: [
          {
            Identifier: 'EnableLogs',
            Type: 'UpdateFlowLoggingBehavior',
            Parameters: { FlowLoggingBehavior: 'Enabled' },
            Transitions: { NextAction: 'SetVoice', Errors: [], Conditions: [] },
          },
          {
            Identifier: 'SetVoice',
            Type: 'UpdateContactTextToSpeechVoice',
            Parameters: {
              TextToSpeechVoice: 'KATIE',
              TextToSpeechEngine: 'connect:agentic',
            },
            Transitions: {
              NextAction: 'SetCallerPhone',
              Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'SetCallerPhone' }],
              Conditions: [],
            },
          },
          {
            Identifier: 'SetCallerPhone',
            Type: 'UpdateContactAttributes',
            Parameters: {
              Attributes: {
                callerPhoneNumber: '$.CustomerEndpoint.Address',
              },
              TargetContact: 'Current',
            },
            Transitions: {
              NextAction: 'CreateSession',
              Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'CreateSession' }],
              Conditions: [],
            },
          },
          {
            Identifier: 'CreateSession',
            Type: 'CreateWisdomSession',
            Parameters: { WisdomAssistantArn: '${AssistantArn}' },
            Transitions: {
              NextAction: 'StoreSessionArn',
              Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'GetInput' }],
              Conditions: [],
            },
          },
          {
            Identifier: 'StoreSessionArn',
            Type: 'UpdateContactData',
            Parameters: { WisdomSessionArn: '$.Wisdom.SessionArn' },
            Transitions: {
              NextAction: 'PushSessionData',
              Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'PushSessionData' }],
              Conditions: [],
            },
          },
          {
            Identifier: 'PushSessionData',
            Type: 'InvokeLambdaFunction',
            Parameters: {
              LambdaFunctionARN: '${PushSessionDataFnArn}',
              InvocationTimeLimitSeconds: '8',
              ResponseValidation: { ResponseType: 'STRING_MAP' },
            },
            Transitions: {
              NextAction: 'GetInput',
              Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'GetInput' }],
              Conditions: [],
            },
          },
          {
            Identifier: 'GetInput',
            Type: 'ConnectParticipantWithLexBot',
            Parameters: {
              Text: 'Thank you for calling, give me a moment to connect.',
              LexV2Bot: { AliasArn: '${LexBotAliasArn}' },
            },
            Transitions: {
              NextAction: 'CheckTool',
              Errors: [
                { ErrorType: 'InputTimeLimitExceeded', NextAction: 'Disconnect' },
                { ErrorType: 'NoMatchingError', NextAction: 'Disconnect' },
                { ErrorType: 'NoMatchingCondition', NextAction: 'Disconnect' },
              ],
              Conditions: [],
            },
          },
          {
            Identifier: 'CheckTool',
            Type: 'Compare',
            Parameters: { ComparisonValue: '$.Lex.SessionAttributes.Tool' },
            Transitions: {
              NextAction: 'Disconnect',
              Errors: [{ ErrorType: 'NoMatchingCondition', NextAction: 'Disconnect' }],
              Conditions: [
                { Condition: { Operator: 'Equals', Operands: ['Complete'] }, NextAction: 'Disconnect' },
                { Condition: { Operator: 'Equals', Operands: ['Escalate'] }, NextAction: 'Disconnect' },
              ],
            },
          },
          {
            Identifier: 'Disconnect',
            Type: 'DisconnectParticipant',
            Parameters: {},
            Transitions: {},
          },
        ],
      }),
      {
        LexBotAliasArn: lexBotAliasArn,
        AssistantArn: assistantArn.valueAsString,
        PushSessionDataFnArn: pushSessionDataFnArn.valueAsString,
      },
    );

    const contactFlow = new connect.CfnContactFlow(this, 'RestaurantOrderingFlow', {
      instanceArn: connectInstanceArn.valueAsString,
      name: cdk.Fn.sub('${P}-restaurant-ordering', { P: prefix }),
      type: 'CONTACT_FLOW',
      description: 'Restaurant AI ordering - routes to Connect AI Agent via Agentic Voice Lex bot',
      content: contactFlowContent,
    });

    // ─── Phone Number ─────────────────────────────────────────────────────────
    const phoneNumber = new connect.CfnPhoneNumber(this, 'PhoneNumber', {
      targetArn: connectInstanceArn.valueAsString,
      countryCode: phoneCountryCode.valueAsString,
      type: phoneType.valueAsString,
      description: cdk.Fn.sub('${P} restaurant ordering number', { P: prefix }),
    });
    phoneNumber.node.addDependency(contactFlow);

    // ─── Phone Number → Contact Flow Association ──────────────────────────────
    const instanceId = cdk.Fn.select(
      1,
      cdk.Fn.split('instance/', connectInstanceArn.valueAsString),
    );

    const phoneFlowAssociation = new cr.AwsCustomResource(this, 'PhoneFlowAssociation', {
      onCreate: {
        service: 'Connect',
        action: 'associatePhoneNumberContactFlow',
        parameters: {
          InstanceId: instanceId,
          PhoneNumberId: phoneNumber.attrPhoneNumberArn,
          ContactFlowId: contactFlow.attrContactFlowArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          cdk.Fn.sub('${PH}-flow-assoc', { PH: phoneNumber.attrPhoneNumberArn }),
        ),
      },
      onUpdate: {
        service: 'Connect',
        action: 'associatePhoneNumberContactFlow',
        parameters: {
          InstanceId: instanceId,
          PhoneNumberId: phoneNumber.attrPhoneNumberArn,
          ContactFlowId: contactFlow.attrContactFlowArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          cdk.Fn.sub('${PH}-flow-assoc', { PH: phoneNumber.attrPhoneNumberArn }),
        ),
      },
      onDelete: {
        service: 'Connect',
        action: 'disassociatePhoneNumberContactFlow',
        parameters: {
          InstanceId: instanceId,
          PhoneNumberId: phoneNumber.attrPhoneNumberArn,
        },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    phoneFlowAssociation.node.addDependency(phoneNumber);
    phoneFlowAssociation.node.addDependency(contactFlow);

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'PhoneNumberE164', {
      value: phoneNumber.attrAddress,
      description: 'Phone number in E.164 format — dial this to test end-to-end',
    });

    new cdk.CfnOutput(this, 'ContactFlowArn', {
      value: contactFlow.attrContactFlowArn,
      description: 'Restaurant ordering contact flow ARN',
    });
  }
}
