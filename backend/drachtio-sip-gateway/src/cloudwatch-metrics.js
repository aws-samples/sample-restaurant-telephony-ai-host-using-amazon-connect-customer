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

const { getCredentials } = require('./aws-credentials');
const { signPostHeaders } = require('./sigv4');
const logger = require('./logger');

const SERVICE = 'monitoring';

let activeCallCount = 0;
let outboundDropQueueFullSinceFlush = 0;
let outboundUnderflowSinceFlush = 0;
let flushInterval = null;

function incrementActiveCalls() {
  activeCallCount += 1;
}

function decrementActiveCalls() {
  if (activeCallCount > 0) activeCallCount -= 1;
}

/**
 * Increment the OutboundDropQueueFull counter. Flushed every interval
 * as a `Sum` (Count) datum and reset to 0 after the flush so each
 * datapoint represents drops in that window.
 *
 * Production-safe: a non-zero value here is the canonical signal that
 * the producer-side pacer (telephony_agent.py `_write_loop`) has
 * regressed and Nova Sonic audio is outpacing the 20 ms RTP drain.
 * Recommended CloudWatch alarm: Sum > 0 over 5 minutes.
 */
function recordOutboundDropQueueFull() {
  outboundDropQueueFullSinceFlush += 1;
}

/**
 * Increment the OutboundUnderflows counter. Flushed every interval as
 * a `Sum` (Count) and reset.
 *
 * A small steady-state count is normal (single-packet WS jitter); a
 * large or sustained count indicates the producer is too SLOW or the
 * cushion (`initialBufferFrames`) is undersized.
 */
function recordOutboundUnderflow() {
  outboundUnderflowSinceFlush += 1;
}

async function flushOnce({ region, namespace }) {
  const url = new URL(`https://monitoring.${region}.amazonaws.com/`);
  const now = new Date().toISOString();

  // Snapshot + reset the counters BEFORE the network call so calls
  // that fire during the round-trip don't get dropped if the request
  // succeeds. If the request FAILS we deliberately drop these counts
  // (the `catch` branch in the interval) — under-counting is safer
  // than spamming a stuck endpoint.
  const dropsThisWindow = outboundDropQueueFullSinceFlush;
  const underflowsThisWindow = outboundUnderflowSinceFlush;
  outboundDropQueueFullSinceFlush = 0;
  outboundUnderflowSinceFlush = 0;

  const bodyParams = new URLSearchParams({
    Action: 'PutMetricData',
    Version: '2010-08-01',
    Namespace: namespace,
    'MetricData.member.1.MetricName': 'ActiveCalls',
    'MetricData.member.1.Timestamp': now,
    'MetricData.member.1.Value': String(activeCallCount),
    'MetricData.member.1.Unit': 'Count',
    'MetricData.member.2.MetricName': 'OutboundDropQueueFull',
    'MetricData.member.2.Timestamp': now,
    'MetricData.member.2.Value': String(dropsThisWindow),
    'MetricData.member.2.Unit': 'Count',
    'MetricData.member.3.MetricName': 'OutboundUnderflows',
    'MetricData.member.3.Timestamp': now,
    'MetricData.member.3.Value': String(underflowsThisWindow),
    'MetricData.member.3.Unit': 'Count',
  });
  const body = bodyParams.toString();

  const credentials = await getCredentials();
  const headers = signPostHeaders({
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
  recordOutboundDropQueueFull,
  recordOutboundUnderflow,
  start,
  stop,
};
