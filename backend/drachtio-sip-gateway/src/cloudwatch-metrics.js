'use strict';

/**
 * Lightweight CloudWatch metrics publisher that runs in-process.
 * Replaces the Python sidecar from the earlier FreeSWITCH-based prototype
 * — no separate process, no ESL, just a counter the call handler bumps
 * on INVITE/BYE and a setInterval loop that flushes every 60 s.
 *
 * Metric: `${prefix}/SipGateway/ActiveCalls` (Average).
 * The ECS service's target-tracking autoscaling policy reads this
 * metric to decide when to scale out/in.
 *
 * No external deps — uses Node 22's built-in fetch to call
 * `monitoring.<region>.amazonaws.com`'s PutMetricData API directly
 * with SigV4 POST. That keeps the Docker image slim.
 */

const crypto = require('node:crypto');
const { getCredentials } = require('./aws-credentials');
const logger = require('./logger');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'monitoring';

let activeCallCount = 0;
let flushInterval = null;

function incrementActiveCalls() {
  activeCallCount += 1;
}

function decrementActiveCalls() {
  if (activeCallCount > 0) activeCallCount -= 1;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function signPost({ url, region, service, credentials, body }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const signedHeadersList = [
    'content-type',
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
  ];
  const canonicalHeaders = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) {
    signedHeadersList.push('x-amz-security-token');
    canonicalHeaders['x-amz-security-token'] = credentials.sessionToken;
  }
  signedHeadersList.sort();
  const canonicalHeaderString = signedHeadersList
    .map((h) => `${h}:${canonicalHeaders[h]}\n`)
    .join('');
  const signedHeaders = signedHeadersList.join(';');

  const canonicalRequest = [
    'POST',
    url.pathname,
    '',
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

  const kDate = hmac('AWS4' + credentials.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  const authorization =
    `${ALGORITHM} ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    Host: url.host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    Authorization: authorization,
  };
  if (credentials.sessionToken) {
    headers['X-Amz-Security-Token'] = credentials.sessionToken;
  }
  return headers;
}

async function flushOnce({ region, namespace }) {
  const url = new URL(`https://monitoring.${region}.amazonaws.com/`);
  const now = new Date().toISOString();
  const bodyParams = new URLSearchParams({
    Action: 'PutMetricData',
    Version: '2010-08-01',
    Namespace: namespace,
    'MetricData.member.1.MetricName': 'ActiveCalls',
    'MetricData.member.1.Timestamp': now,
    'MetricData.member.1.Value': String(activeCallCount),
    'MetricData.member.1.Unit': 'Count',
  });
  const body = bodyParams.toString();

  const credentials = await getCredentials();
  const headers = signPost({
    url,
    region,
    service: SERVICE,
    credentials,
    body,
  });

  const resp = await fetch(url.href, { method: 'POST', headers, body });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`PutMetricData ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

function start({ region, namespace, intervalMs = 60_000 }) {
  if (flushInterval) return;
  flushInterval = setInterval(() => {
    flushOnce({ region, namespace }).catch((err) => {
      logger.warn('cloudwatch flush failed', { err: err.message });
    });
  }, intervalMs);
  // Don't block exit on this timer.
  flushInterval.unref?.();
  logger.info('cloudwatch metrics publisher started', {
    namespace,
    interval_ms: intervalMs,
  });
}

function stop() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

module.exports = {
  incrementActiveCalls,
  decrementActiveCalls,
  start,
  stop,
};
