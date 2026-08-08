/**
 * Derive a pseudonymous customer id from an E.164 phone number:
 *
 *   customerId = "pstn-" + sha256(e164 + pepper).hexdigest()[:16]
 *
 * The pepper is read from an SSM SecureString at
 * `/${prefix}/customer-id-pepper`.
 *
 * NOTE: this module is used ONLY by the optional loyalty-seeding path in
 * populate-data.js, which runs when `--user-phone` is supplied. The default
 * deployment does not use it, and no stack in this project provisions the
 * pepper parameter. The deployed AI Agent derives its own customer id
 * directly from the caller's digits (see the system prompt in
 * connect-interface/connect-ai-agent), so the two schemes do not match.
 * Reconcile them before relying on the loyalty path.
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
