'use strict';

/**
 * Pre-warm an AgentCore Runtime microVM by issuing a SigV4-signed POST
 * to its `/invocations` HTTP entrypoint with the session-id header set.
 *
 * AgentCore Runtime routes a request to a microVM keyed on the session
 * id ("microVM stickiness", see
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html).
 * By firing this warmup BEFORE the SMA Lambda returns the CallAndBridge
 * action to Chime SDK Voice Connector, the microVM is allocated and the
 * agent's per-call setup (prompt render + Nova Sonic stream open + MCP
 * tool discovery + BidiAgent.start + prime-with-Hi) finishes during the
 * SIP setup window. When the bridge later opens its wss connection with
 * the same session id, AgentCore routes it to the SAME microVM and the
 * agent attaches in O(ms) — no cold start.
 *
 * Reference: https://repost.aws/articles/ARCJIn3t7aRC2FxiRTV1SuCA
 *
 * Plain ES2022 + node:crypto + global fetch (Node 22+) only. No third-
 * party deps. Bundled into the SMA Lambda with minify=false for hot-
 * edit visibility in the AWS Lambda console.
 */

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'bedrock-agentcore';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function rfc3986Encode(s) {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function canonicalUriFromRaw(rawPath) {
  if (!rawPath) return '/';
  return rawPath.split('/').map(rfc3986Encode).join('/');
}

/**
 * SigV4 POST header signer for the bedrock-agentcore data plane.
 *
 * Returns a headers object the caller threads into `fetch()`. Body MUST
 * be the same string that gets POSTed (the SigV4 spec hashes the body
 * into the canonical request).
 *
 * Duplicated from `backend/drachtio-sip-gateway/src/sigv4.js` rather than
 * shared because the SMA Lambda is a separate CDK bundle. ~60 lines of
 * code is bounded and the cross-package import path adds bundling
 * complexity that hurts hot-edit usability.
 */
function signPostHeaders({ url, region, service, credentials, body }) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body || '');
  const contentType = 'application/json';

  const signedHeadersList = ['content-type', 'host', 'x-amz-content-sha256', 'x-amz-date'];
  const canonicalHeaders = {
    'content-type': contentType,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (sessionToken) {
    signedHeadersList.push('x-amz-security-token');
    canonicalHeaders['x-amz-security-token'] = sessionToken;
  }
  signedHeadersList.sort();
  const canonicalHeaderString = signedHeadersList
    .map((h) => `${h}:${canonicalHeaders[h]}\n`)
    .join('');
  const signedHeaders = signedHeadersList.join(';');

  const canonicalQuery = (() => {
    const params = [];
    for (const [k, v] of url.searchParams) params.push([k, v]);
    return params
      .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  })();

  const canonicalRequest = [
    'POST',
    canonicalUriFromRaw(url.pathname),
    canonicalQuery,
    canonicalHeaderString,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    'Content-Type': contentType,
    Host: url.host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: authorization,
  };
  if (sessionToken) headers['X-Amz-Security-Token'] = sessionToken;
  return headers;
}

/**
 * Read AWS credentials from the Lambda execution-role environment.
 * Lambda automatically populates AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_SESSION_TOKEN. No SDK call needed.
 */
function lambdaEnvCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('agentcore-warmup: missing AWS credentials in env');
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Pre-warm an AgentCore Runtime microVM by POSTing a JSON body to its
 * /invocations endpoint with the session-id header.
 *
 * Awaits the response. The caller (SMA handler) blocks on this so the
 * microVM is ready by the time it returns CallAndBridge to Chime —
 * the SIP INVITE then arrives at an already-warm agent.
 *
 * @param {object} opts
 * @param {string} opts.runtimeArn   AgentCore Runtime ARN (full).
 * @param {string} opts.region       e.g. "us-east-1".
 * @param {string} opts.sessionId    33-256 char session id; for our app
 *                                   it's `pstn-<sha256-hex>` from
 *                                   pstn-customer.derive.
 * @param {string} [opts.qualifier]  Endpoint alias, default "DEFAULT".
 * @param {object} opts.body         JSON-serializable body. Our agent
 *                                   expects `{type:"warmup", raw_from,
 *                                   anonymous, from_last4, call_id,
 *                                   voice_id}`.
 * @param {number} [opts.timeoutMs]  Per-request abort timeout (default 8000).
 * @returns {Promise<{status: number, body: string|null}>}  Resolves
 *   even on non-2xx so the caller can log + still proceed with
 *   CallAndBridge. Rejects only on transport/credential errors.
 */
async function warmup({
  runtimeArn,
  region,
  sessionId,
  qualifier = 'DEFAULT',
  body,
  timeoutMs = 8000,
}) {
  if (!runtimeArn || !region || !sessionId || !body) {
    throw new TypeError(
      'agentcore-warmup: runtimeArn, region, sessionId, body are required',
    );
  }
  const host = `bedrock-agentcore.${region}.amazonaws.com`;
  const path = `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`;
  const url = new URL(`https://${host}${path}?qualifier=${encodeURIComponent(qualifier)}`);
  const bodyStr = JSON.stringify(body);

  const credentials = lambdaEnvCredentials();
  const headers = signPostHeaders({
    url,
    region,
    service: SERVICE,
    credentials,
    body: bodyStr,
  });
  // Service-specific header — read by AgentCore for microVM stickiness,
  // not in the SigV4 SignedHeaders set so it's free-form.
  headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url.href, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    const respBody = await resp.text().catch(() => null);
    return { status: resp.status, body: respBody };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  warmup,
  // Exported for tests.
  signPostHeaders,
  lambdaEnvCredentials,
};
