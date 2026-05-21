'use strict';

// SigV4 QUERY-STRING PRESIGN for Bedrock AgentCore Runtime WebSocket.
//
// Mirrors boto3 `botocore.auth.SigV4QueryAuth` — the exact shape used by
// the reference Python signer (`scripts/sign_agentcore_url.py` from the
// earlier prototype) and by the curl example the human pasted:
//
//   wss://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<arn>/ws
//       ?qualifier=DEFAULT
//       &voice_id=<matthew|tiffany|amy>
//       &X-Amz-Security-Token=<url-encoded STS token>
//       &X-Amz-Algorithm=AWS4-HMAC-SHA256
//       &X-Amz-Credential=<AKID>%2F<YYYYMMDD>%2F<region>%2F<service>%2Faws4_request
//       &X-Amz-Date=<YYYYMMDDTHHMMSSZ>
//       &X-Amz-Expires=<seconds>
//       &X-Amz-SignedHeaders=host
//       &X-Amz-Signature=<hex>
//
// Why presign (not header auth)?  Browser/WS-lib handshakes slip extra
// headers (User-Agent, Origin, Cache-Control, Sec-WebSocket-*) that the
// server's canonical request might include depending on its shape — with
// presign, SignedHeaders=host covers only Host, and every other wire
// header is ignored by the verifier.  Header auth on the same endpoint
// returned 403 when extra headers bled through; presign fixes it.
//
// Notes on encoding:
//   - CANONICAL PATH percent-encodes non-unreserved chars segment-wise
//     with `/` as the segment separator.  The runtime ARN in the path
//     contains colons (`arn:aws:...`) which MUST be percent-encoded in
//     the canonical request even though the wire URL keeps them raw —
//     the server does the same transformation server-side before it
//     verifies, so both sides agree.  encodeURIComponent is RFC3986-
//     compliant for our specific characters (alnum + `-`, `_`, `.`, `~`
//     unreserved; `:` → `%3A`).
//   - CANONICAL QUERY sorts by key then value; each is RFC3986-encoded.
//     We must include the X-Amz-* params (minus signature) in the
//     canonical query because they become part of the signed URL.
//
// Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Encode per RFC3986 — matches Python's `urllib.parse.quote(s, safe='')`
 * for the character set we actually emit (alnum + `-_.~` unreserved,
 * everything else percent-encoded).  encodeURIComponent leaves
 * `!*'()` unencoded which is NOT RFC3986-strict; fix that manually.
 */
function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Canonical URI per SigV4: split the path on `/`, encode each segment,
 * re-join.  This preserves `/` between segments but percent-encodes `:`
 * and other reserved chars inside each segment (matches boto3's
 * `urllib.parse.quote(path, safe='/~')` on non-S3 services).
 */
function canonicalUriFromRaw(rawPath) {
  if (!rawPath) return '/';
  return rawPath.split('/').map(rfc3986Encode).join('/');
}

/**
 * Parse a raw query string (no leading `?`, value encoding already
 * applied) into an ordered [key, value] list with values decoded.
 */
function parseRawQuery(rawQuery) {
  if (!rawQuery) return [];
  const out = [];
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    out.push([decodeURIComponent(k), decodeURIComponent(v)]);
  }
  return out;
}

/**
 * Presign a GET URL with SigV4 QueryAuth.
 *
 * @param {object} opts
 * @param {string} opts.host        e.g. "bedrock-agentcore.us-east-1.amazonaws.com"
 * @param {string} opts.rawPath     e.g. "/runtimes/arn:aws:bedrock-agentcore:.../ws"
 *                                  (raw — colons unencoded).
 * @param {string} [opts.baseQuery] pre-existing query string WITHOUT leading `?`
 *                                  e.g. "qualifier=DEFAULT&voice_id=matthew".
 *                                  Values MUST already be encodeURIComponent'd.
 * @param {string} opts.region
 * @param {string} opts.service     e.g. "bedrock-agentcore"
 * @param {object} opts.credentials { accessKeyId, secretAccessKey, sessionToken? }
 * @param {number} [opts.expires]   Presign lifetime in seconds (default 3600).
 * @param {Date}   [opts.now]       Override for tests.
 * @returns {string}                Full signed URL including scheme, e.g.
 *                                  "wss://host/path?qualifier=...&X-Amz-Signature=..."
 */
function presignUrl({
  host,
  rawPath,
  baseQuery = '',
  region,
  service,
  credentials,
  expires = 3600,
  scheme = 'wss',
  now,
}) {
  if (!host || !rawPath) {
    throw new TypeError('presignUrl: host and rawPath are required');
  }
  const { accessKeyId, secretAccessKey, sessionToken } = credentials || {};
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('presignUrl: missing credentials');
  }

  const amzDate = (now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Build full param list in a stable order.  We preserve the base
  // query's parameters first, then add the X-Amz-* ones; canonicalization
  // re-sorts, so input order doesn't matter for the signature — but it
  // affects the final URL shape (cosmetic).
  const params = [];
  for (const [k, v] of parseRawQuery(baseQuery)) {
    params.push([k, v]);
  }
  if (sessionToken) params.push(['X-Amz-Security-Token', sessionToken]);
  params.push(['X-Amz-Algorithm', ALGORITHM]);
  params.push(['X-Amz-Credential', `${accessKeyId}/${credentialScope}`]);
  params.push(['X-Amz-Date', amzDate]);
  params.push(['X-Amz-Expires', String(expires)]);
  params.push(['X-Amz-SignedHeaders', 'host']);

  // Canonical query: sort by key then value, encode both per RFC3986.
  const canonicalPairs = params
    .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = canonicalPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalUri = canonicalUriFromRaw(rawPath);

  // Presign uses empty-body sha256 as payload hash (non-S3 services).
  const payloadHash = sha256Hex('');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  // Final URL: preserve the raw path on the wire (not the canonical
  // encoded form) — the server will canonicalize its incoming URL the
  // same way we canonicalized before signing, so they match.
  const finalQuery = canonicalQuery + '&X-Amz-Signature=' + signature;
  return `${scheme}://${host}${rawPath}?${finalQuery}`;
}

module.exports = {
  presignUrl,
  // Exported for tests.
  canonicalUriFromRaw,
  rfc3986Encode,
};


/**
 * Sign a POST request with SigV4 header auth.
 *
 * Used for control-plane / data-plane API calls that don't fit the
 * presigned-URL pattern (e.g. PutMetricData, StopRuntimeSession). The
 * caller passes a parsed URL object, the body string, and credentials;
 * we return a headers object including Authorization that the caller
 * threads into `fetch(url, { method: 'POST', headers, body })`.
 *
 * Mirrors the previous in-line implementation that lived in
 * `cloudwatch-metrics.js`. Hoisted here so AgentCore Runtime control
 * plane calls (`stopRuntimeSession`) can reuse the same helper without
 * duplicating ~60 lines.
 *
 * @param {object} opts
 * @param {URL} opts.url            Full request URL (parsed via `new URL(...)`).
 * @param {string} opts.region
 * @param {string} opts.service     e.g. "monitoring", "bedrock-agentcore".
 * @param {object} opts.credentials { accessKeyId, secretAccessKey, sessionToken? }.
 * @param {string} opts.body        Request body as a string (use '' for empty).
 * @returns {object}                Headers map ready to pass into fetch().
 */
function signPostHeaders({ url, region, service, credentials, body }) {
  if (!url || typeof url !== 'object' || !url.host) {
    throw new TypeError('signPostHeaders: url must be a parsed URL with a host');
  }
  if (!region || !service) {
    throw new TypeError('signPostHeaders: region and service are required');
  }
  const { accessKeyId, secretAccessKey, sessionToken } = credentials || {};
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('signPostHeaders: missing credentials');
  }

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body || '');

  // Determine the content type — caller may set this explicitly later
  // by mutating the returned headers, but for SigV4 canonicalization
  // we need to know it now. Default matches what most AWS POST APIs
  // accept (form-encoded for monitoring, application/json works for
  // bedrock-agentcore data plane).
  const contentType =
    service === 'monitoring'
      ? 'application/x-www-form-urlencoded; charset=utf-8'
      : 'application/json';

  const signedHeadersList = [
    'content-type',
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
  ];
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

  // Canonical URI: percent-encode each path segment per RFC 3986. The
  // existing canonicalUriFromRaw helper does exactly this.
  const canonicalUri = canonicalUriFromRaw(url.pathname);

  // Canonical query string: sort by key then value, encode each side.
  const canonicalQuery = (() => {
    const params = [];
    for (const [k, v] of url.searchParams) params.push([k, v]);
    return params
      .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)])
      .sort((a, b) =>
        a[0] < b[0]
          ? -1
          : a[0] > b[0]
            ? 1
            : a[1] < b[1]
              ? -1
              : a[1] > b[1]
                ? 1
                : 0,
      )
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  })();

  const canonicalRequest = [
    'POST',
    canonicalUri,
    canonicalQuery,
    canonicalHeaderString,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  const authorization =
    `${ALGORITHM} ` +
    `Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const headers = {
    'Content-Type': contentType,
    Host: url.host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: authorization,
  };
  if (sessionToken) {
    headers['X-Amz-Security-Token'] = sessionToken;
  }
  return headers;
}

module.exports.signPostHeaders = signPostHeaders;
