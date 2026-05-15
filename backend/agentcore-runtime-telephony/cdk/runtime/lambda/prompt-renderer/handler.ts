/**
 * Prompt-renderer Lambda for the Telephony Voice Ordering Agent.
 *
 * Contract:
 *   Input event:
 *     {
 *       "phoneNumber":       "+12125550100",   // required, E.164
 *       "customerId":        "pstn-<hash>"     // required
 *     }
 *   Response:
 *     {
 *       "systemPrompt": "<rendered prompt text>",
 *       "profile": { "customerId", "name", "phoneNumber" } | null
 *     }
 *
 * Resolution rules:
 *   1. DynamoDB GetItem on Customers (PK = CUSTOMER#<customerId>, SK = PROFILE).
 *   2. If the row exists AND has a non-empty `name`, render the loyalty
 *      prompt with {{customer_name}} substituted. Return profile = row.
 *   3. Otherwise render the anonymous prompt. Return profile = null.
 *
 * Failure modes the agent must handle:
 *   - DynamoDB throttle or error → returns anonymous prompt + null profile.
 *     Deliberate: a single slow/failed DDB call should never block the
 *     caller's first utterance. Better to greet a loyalty customer
 *     generically this one call than to hang the session.
 *   - SSM GetParameter error → throws. The agent's `fetch_prompt()`
 *     catches this and falls back to the container-baked prompt in
 *     `system_prompt.build(session)`. This is the last-resort path.
 *
 * No @aws-sdk/* is bundled. The Node 24 Lambda managed runtime ships
 * client-ssm, client-dynamodb, lib-dynamodb.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

type Event = {
  phoneNumber?: string;
  customerId?: string;
};

type Profile = {
  customerId: string;
  name: string;
  phoneNumber: string;
};

type Response = {
  systemPrompt: string;
  profile: Profile | null;
};

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CUSTOMERS_TABLE = mustEnv('CUSTOMERS_TABLE_NAME');
const LOYALTY_PROMPT_PARAM = mustEnv('LOYALTY_PROMPT_PARAMETER_NAME');
const ANONYMOUS_PROMPT_PARAM = mustEnv('ANONYMOUS_PROMPT_PARAMETER_NAME');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ssm = new SSMClient({ region: REGION });

// Cache prompt text in the Lambda container so repeated calls within
// one warm instance skip the SSM round-trip (~40 ms savings per call).
// Invalidated when the container recycles (every ~15 min idle).
const promptCache: { loyalty?: string; anonymous?: string } = {};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env var ${name} is required`);
  return v;
}

async function loadPrompt(kind: 'loyalty' | 'anonymous'): Promise<string> {
  if (promptCache[kind]) return promptCache[kind]!;
  const name = kind === 'loyalty' ? LOYALTY_PROMPT_PARAM : ANONYMOUS_PROMPT_PARAM;
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = resp?.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  promptCache[kind] = value;
  return value;
}

async function loadCustomer(customerId: string): Promise<Profile | null> {
  try {
    const resp = await ddb.send(
      new GetCommand({
        TableName: CUSTOMERS_TABLE,
        Key: {
          PK: `CUSTOMER#${customerId}`,
          SK: 'PROFILE',
        },
      }),
    );
    const item = resp?.Item;
    if (!item || !item.name) {
      return null;
    }
    return {
      customerId: String(item.customerId ?? customerId),
      name: String(item.name),
      phoneNumber: String(item.phoneNumber ?? ''),
    };
  } catch (err) {
    // Log and treat as not-found so a single DDB error doesn't block
    // the caller. The agent still gets an anonymous-path prompt.
    console.warn(
      'prompt-renderer: customer lookup failed, falling back to anonymous',
      JSON.stringify({ customerId, err: (err as Error).message }),
    );
    return null;
  }
}

function renderLoyalty(template: string, profile: Profile): string {
  // Plain-text replace. Nothing HTML, nothing regex-weird. We use a
  // single-brace placeholder ({CUSTOMER_NAME}) because SSM Parameter
  // Store rejects double-brace values as "nested parameter references"
  // (see prompt-texts.ts header for the validation error).
  return template.replaceAll('{CUSTOMER_NAME}', profile.name);
}

export async function handler(event: Event): Promise<Response> {
  const phone = (event.phoneNumber ?? '').trim();
  const customerId = (event.customerId ?? '').trim();

  if (!phone || !/^\+[1-9]\d{1,14}$/.test(phone)) {
    throw new Error(`invalid phoneNumber: ${JSON.stringify(phone)}`);
  }
  if (!customerId) {
    throw new Error('customerId is required');
  }

  console.log(
    'prompt-renderer: rendering',
    JSON.stringify({
      customerId,
      phoneLast4: phone.slice(-4),
    }),
  );

  const profile = await loadCustomer(customerId);

  if (profile) {
    const template = await loadPrompt('loyalty');
    const systemPrompt = renderLoyalty(template, profile);
    console.log(
      'prompt-renderer: loyalty',
      JSON.stringify({ customerId, nameLen: profile.name.length }),
    );
    return { systemPrompt, profile };
  }

  const systemPrompt = await loadPrompt('anonymous');
  console.log('prompt-renderer: anonymous', JSON.stringify({ customerId }));
  return { systemPrompt, profile: null };
}
