/**
 * Connect Customer Enabler — Custom Resource Lambda
 *
 * Enables the "Connect Customer" AI capabilities tier on an Amazon Connect
 * instance by calling connect:UpdateInstanceAttribute with
 * AttributeType=ENHANCED_CONTACT_MONITORING.
 *
 * This cannot be done via CloudFormation directly — no CFN resource exists
 * for this attribute. The custom resource receives the instance UUID
 * (Fn::GetAtt Id from AWS::Connect::Instance) because the Connect API
 * UpdateInstanceAttribute takes the instance ID (UUID), not the ARN.
 *
 * On CREATE/UPDATE: enables the attribute.
 * On DELETE: disables it (best-effort; ignores errors if instance is gone).
 */

import {
  ConnectClient,
  UpdateInstanceAttributeCommand,
  DescribeInstanceAttributeCommand,
  InstanceAttributeType,
} from '@aws-sdk/client-connect';

const client = new ConnectClient({});

interface ResourceProperties {
  // UUID — from Fn::GetAtt Id on AWS::Connect::Instance
  InstanceId: string;
}

export async function handler(event: {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const { InstanceId } = event.ResourceProperties;
  const physicalId = `connect-customer-enabler-${InstanceId}`;

  console.log(JSON.stringify({ requestType: event.RequestType, instanceId: InstanceId }));

  if (event.RequestType === 'Delete') {
    try {
      await client.send(new UpdateInstanceAttributeCommand({
        InstanceId,
        AttributeType: InstanceAttributeType.ENHANCED_CONTACT_MONITORING,
        Value: 'false',
      }));
      console.log('Connect Customer disabled on teardown');
    } catch (err) {
      console.warn('Could not disable Connect Customer on teardown (may already be deleting):', err);
    }
    return { PhysicalResourceId: physicalId };
  }

  // CREATE or UPDATE: enable Connect Customer and Bot Management.
  // ENHANCED_CONTACT_MONITORING: enables Q in Connect AI capabilities
  // BOT_MANAGEMENT: required for Lex generative engine (Nova Sonic S2S)
  try {
    const describe = await client.send(new DescribeInstanceAttributeCommand({
      InstanceId,
      AttributeType: InstanceAttributeType.ENHANCED_CONTACT_MONITORING,
    }));
    if (describe.Attribute?.Value === 'true') {
      console.log('Connect Customer already enabled — checking Bot Management');
    }
  } catch (err) {
    console.warn('Could not describe instance attribute — proceeding with enable:', err);
  }

  await client.send(new UpdateInstanceAttributeCommand({
    InstanceId,
    AttributeType: InstanceAttributeType.ENHANCED_CONTACT_MONITORING,
    Value: 'true',
  }));
  console.log('Connect Customer (ENHANCED_CONTACT_MONITORING) enabled');

  await client.send(new UpdateInstanceAttributeCommand({
    InstanceId,
    AttributeType: 'BOT_MANAGEMENT' as InstanceAttributeType,
    Value: 'true',
  }));
  console.log('Bot Management (BOT_MANAGEMENT) enabled — required for Nova Sonic generative engine');

  return { PhysicalResourceId: physicalId, Data: { Status: 'enabled', InstanceId } };
}
