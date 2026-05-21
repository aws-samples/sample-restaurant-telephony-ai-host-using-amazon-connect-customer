'use strict';

/**
 * Pure-JS port of `backend/agentcore-runtime-telephony/agent/pstn_customer.py`.
 *
 * The Python helper runs INSIDE the AgentCore agent container and derives a
 * pseudonymous `customer_id` from the caller E.164 plus a server-side pepper
 * (loaded once from SSM SecureString). This Node port runs in the SMA Lambda
 * so it can compute the SAME `customer_id` and an AgentCore Runtime session
 * ID before the call ever reaches the bridge — letting us pre-warm the
 * microVM via POST /invocations.
 *
 * Critical: this module MUST stay byte-identical to the Python reference
 * for any (e164, pepper) input. The agent re-derives `customer_id` server-
 * side from the same inputs, and the customerId-injection hook then uses
 * THAT value on every tool call. If the JS port and the Python reference
 * disagree, the agent falls back to anonymous on the cold path AND
 * subsequent tool calls land at the wrong DynamoDB partition. Tests in
 * `.deploy-tmp/test_sma_handler_step3.js` cross-check known fixtures.
 *
 * Plain ES2022 + node:crypto only — no third-party deps. Bundled by CDK
 * with `minify: false` so the deployed Lambda's index.js stays human-
 * readable for hot-edits in the AWS console.
 */

const crypto = require('node:crypto');

// E.164: leading '+', then 1-15 digits, first digit cannot be 0. Identical
// to the Python pstn_customer._E164_REGEX.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// Customer ID truncation: first 8 bytes of sha256, hex-encoded = 16 chars.
// Identical to pstn_customer._CUSTOMER_ID_HEX_LEN.
const CUSTOMER_ID_HEX_LEN = 16;

/**
 * Strip whitespace and validate as strict E.164. Returns the normalized
 * string or null if the input is not valid.
 */
function normalizeE164(rawFrom) {
  if (typeof rawFrom !== 'string') return null;
  const candidate = rawFrom.trim();
  if (!E164_REGEX.test(candidate)) return null;
  return candidate;
}

/**
 * Last 4 digits of an E.164 string, or '' if fewer than 4 digits.
 * Mirrors pstn_customer._last4.
 */
function last4(e164) {
  const digits = String(e164 || '').match(/\d/g) || [];
  if (digits.length < 4) return '';
  return digits.slice(-4).join('');
}

/**
 * Derive (customer_id, anonymous, from_last4, session_id) from the caller's
 * raw From header value and the pepper bytes.
 *
 * - Identified caller (valid E.164):
 *     customer_id = "pstn-" + sha256(e164 || pepper)[:16]   (16 hex chars)
 *     session_id  = "pstn-" + sha256(e164 || pepper)         (64 hex chars)
 *     anonymous   = false
 *     from_last4  = last 4 digits of e164
 *
 *   Both ids share the same SHA-256 digest so the agent's Python helper
 *   can recover customer_id by truncating the session_id-derived hash.
 *   The 64-char hex session_id satisfies AgentCore Runtime's 33-256 char
 *   length constraint
 *   (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html).
 *
 * - Anonymous caller (anything that doesn't parse as E.164, including
 *   the literal string "anonymous", whitespace, or empty):
 *     customer_id = "pstn-anonymous-" + 16 random hex chars
 *     session_id  = null  (no microVM stickiness for anonymous calls;
 *                          fresh microVM per call, by design)
 *     anonymous   = true
 *     from_last4  = last 4 digits of whatever digits the raw value had
 *                   (or '' if fewer than 4)
 *
 * @param {string} rawFrom Raw From header, e.g. "+12125550100".
 * @param {Buffer} pepper  Server-side pepper bytes (loaded once from SSM).
 * @returns {{customerId: string, anonymous: boolean, fromLast4: string,
 *            sessionId: string|null}}
 */
function derive(rawFrom, pepper) {
  if (!Buffer.isBuffer(pepper)) {
    throw new TypeError('pstn-customer.derive: pepper must be a Buffer');
  }

  const e164 = normalizeE164(rawFrom);
  if (e164 === null) {
    // Anonymous fallback — non-deterministic id, no session pre-warm.
    const digitsFromRaw = String(rawFrom || '').match(/\d/g) || [];
    const fromLast4 =
      digitsFromRaw.length >= 4 ? digitsFromRaw.slice(-4).join('') : '';
    return {
      customerId: 'pstn-anonymous-' + crypto.randomBytes(8).toString('hex'),
      anonymous: true,
      fromLast4,
      sessionId: null,
    };
  }

  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(e164, 'utf8'))
    .update(pepper)
    .digest('hex');

  return {
    customerId: 'pstn-' + digest.slice(0, CUSTOMER_ID_HEX_LEN),
    anonymous: false,
    fromLast4: last4(e164),
    sessionId: 'pstn-' + digest,
  };
}

module.exports = {
  derive,
  // Exported for tests.
  normalizeE164,
  last4,
  E164_REGEX,
  CUSTOMER_ID_HEX_LEN,
};
