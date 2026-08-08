/**
 * push-session-data.mjs
 *
 * Invoked from the contact flow AFTER CreateWisdomSession.
 * Reads the caller's phone number from the contact event and pushes it
 * into the AI Agents session via UpdateSessionData so the AI Agent
 * prompt can reference it as {{$.Custom.callerPhoneNumber}}.
 *
 * Environment variables:
 *   ASSISTANT_ID — Amazon Connect AI Agents assistant UUID
 */

import { QConnectClient, UpdateSessionDataCommand } from '@aws-sdk/client-qconnect';
import { ConnectClient, DescribeContactCommand } from '@aws-sdk/client-connect';

const qconnect = new QConnectClient();
const connect = new ConnectClient();

export const handler = async (event) => {
  console.log('Event:', JSON.stringify(event));

  const contactData = event.Details.ContactData;
  const contactId = contactData.ContactId;
  const instanceArn = contactData.InstanceARN;
  const instanceId = instanceArn.split('/').pop();
  const callerPhone = contactData.CustomerEndpoint?.Address || '';
  const assistantId = process.env.ASSISTANT_ID;

  if (!callerPhone) {
    console.log('No caller phone number available');
    return { statusCode: 200, callerPhoneNumber: '' };
  }

  // Get the session ARN from the contact
  let sessionArn;
  try {
    const describeResp = await connect.send(new DescribeContactCommand({
      InstanceId: instanceId,
      ContactId: contactId,
    }));
    sessionArn = describeResp.Contact?.WisdomInfo?.SessionArn;
  } catch (err) {
    console.error('DescribeContact failed:', err);
    return { statusCode: 500, error: 'Failed to get session ARN' };
  }

  if (!sessionArn) {
    console.log('No WisdomInfo.SessionArn on contact — session may not be created yet');
    return { statusCode: 200, callerPhoneNumber: callerPhone };
  }

  const sessionId = sessionArn.split('/').pop();

  // Push caller phone number into session data
  try {
    await qconnect.send(new UpdateSessionDataCommand({
      assistantId,
      sessionId,
      namespace: 'Custom',
      data: [
        { key: 'callerPhoneNumber', value: { stringValue: callerPhone } },
      ],
    }));
    console.log(`Pushed callerPhoneNumber=${callerPhone} to session ${sessionId}`);
  } catch (err) {
    console.error('UpdateSessionData failed:', err);
    return { statusCode: 500, error: 'Failed to push session data' };
  }

  return { statusCode: 200, callerPhoneNumber: callerPhone };
};
