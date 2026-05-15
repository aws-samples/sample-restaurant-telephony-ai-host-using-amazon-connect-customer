'use strict';

/**
 * Fetches temporary AWS credentials from the ECS container-credentials
 * endpoint (Fargate task role).
 *
 * Fargate injects `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` into the task
 * env; we GET http://169.254.170.2{relative} and parse the JSON. The
 * response includes AccessKeyId, SecretAccessKey, Token, and Expiration.
 * We cache the credentials and refresh when Expiration is within 5 min.
 *
 * Docs: docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
 *
 * Also supports the standard env var fallbacks (`AWS_ACCESS_KEY_ID` etc.)
 * for local-dev runs on a developer laptop where the task role isn't
 * available.
 */

const http = require('node:http');
const logger = require('./logger');

const ECS_METADATA_HOST = '169.254.170.2';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

let cached = null; // { credentials, expiresAtMs }

function fetchFromEcs(relativeUri) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: ECS_METADATA_HOST,
        port: 80,
        path: relativeUri,
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `ECS credentials endpoint returned ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (err) {
            reject(new Error(`ECS credentials response not JSON: ${err.message}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('ECS credentials endpoint timeout'));
    });
    req.on('error', reject);
  });
}

async function fetchCredentials() {
  const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (rel) {
    const json = await fetchFromEcs(rel);
    return {
      credentials: {
        accessKeyId: json.AccessKeyId,
        secretAccessKey: json.SecretAccessKey,
        sessionToken: json.Token,
      },
      expiresAtMs: json.Expiration ? Date.parse(json.Expiration) : Date.now() + 55 * 60 * 1000,
    };
  }
  // Env-var fallback (local dev).
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      },
      // Env vars don't expose an expiration; refresh every hour to be safe.
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    };
  }
  throw new Error(
    'no AWS credentials: expected AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (Fargate) ' +
      'or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars (local dev)',
  );
}

/** Returns fresh credentials, refreshing from the ECS endpoint as needed. */
async function getCredentials() {
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) {
    return cached.credentials;
  }
  try {
    cached = await fetchCredentials();
    logger.debug('aws credentials refreshed', {
      expires_at: new Date(cached.expiresAtMs).toISOString(),
    });
    return cached.credentials;
  } catch (err) {
    logger.error('aws credentials fetch failed', { err: err.message });
    throw err;
  }
}

module.exports = { getCredentials };
