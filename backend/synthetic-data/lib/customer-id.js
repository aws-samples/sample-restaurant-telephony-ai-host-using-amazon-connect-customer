/**
 * Derive the deterministic telephony customer_id from an E.164 phone number.
 *
 * Mirrors backend/agentcore-runtime-telephony/agent/pstn_customer.py:
 *
 *   customer_id = "pstn-" + sha256(e164 + pepper).hexdigest()[:16]
 *
 * The pepper is read from the same SSM SecureString parameter the agent
 * reads at call time: `/${prefix}/customer-id-pepper`. That parameter is
 * provisioned by `${prefix}-AgentRuntimeStack` (see
 * backend/agentcore-runtime-telephony/cdk/runtime/lib/runtime-stack.ts).
 *
 * Using the same pepper here guarantees that the Customers row this
 * script writes (PK = `CUSTOMER#<customer_id>`) will be the row the
 * agent reads on the first inbound call from that phone number — so the
 * prompt-renderer Lambda finds the loyalty record and the caller is
 * greeted by name.
 */
const crypto = require('crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const PEPPER_PARAMETER_NAME_DEFAULT = '/qsr-tel/customer-id-pepper';

/**
 * Read the pepper from SSM SecureString.
 *
 * @param {string} parameterName e.g. `/qsr-tel/customer-id-pepper`.
 * @param {string} region AWS region.
 * @returns {Promise<Buffer>} pepper bytes.
 */
async function loadPepper(parameterName, region = 'us-east-1') {
  const client = new SSMClient({ region });
  const resp = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = resp?.Parameter?.Value ?? '';
  return Buffer.from(value, 'utf-8');
}

/**
 * Compute the customer_id for a given E.164 number using the provided pepper.
 *
 * @param {string} e164 caller phone, must match ^\+[1-9]\d{1,14}$
 * @param {Buffer} pepper bytes read from SSM (empty buffer is accepted
 *   for local dev — matches the Python path when the env var is unset).
 * @returns {string} 21-char id like `pstn-a1b2c3d4e5f6a7b8`.
 */
function computeCustomerId(e164, pepper) {
  if (typeof e164 !== 'string' || !/^\+[1-9]\d{1,14}$/.test(e164)) {
    throw new Error(`computeCustomerId: invalid E.164 ${JSON.stringify(e164)}`);
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(e164, 'utf-8'));
  hash.update(pepper || Buffer.alloc(0));
  return 'pstn-' + hash.digest('hex').slice(0, 16);
}

module.exports = {
  loadPepper,
  computeCustomerId,
  PEPPER_PARAMETER_NAME_DEFAULT,
};
