'use strict';

const Srf = require('drachtio-srf');
const { PortPool } = require('./port-pool');
const { handleInvite } = require('./call-handler');
const cloudwatch = require('./cloudwatch-metrics');
const logger = require('./logger');

async function main() {
  const drachtioHost = process.env.DRACHTIO_HOST || '127.0.0.1';
  const drachtioPort = parseInt(process.env.DRACHTIO_ADMIN_PORT || '9022', 10);
  const drachtioSecret = process.env.DRACHTIO_SECRET || '';
  if (!drachtioSecret) {
    logger.error('DRACHTIO_SECRET not set; refusing to start');
    process.exit(1);
  }

  const agentConfig = {
    runtimeArn: process.env.AGENT_RUNTIME_ARN,
    region: process.env.AWS_REGION || 'us-east-1',
    voiceId: process.env.AGENT_VOICE_ID || 'tiffany',
    qualifier: process.env.AGENT_QUALIFIER || 'DEFAULT',
  };
  if (!agentConfig.runtimeArn) {
    logger.error('AGENT_RUNTIME_ARN not set; refusing to start');
    process.exit(1);
  }

  logger.info('starting drachtio sip gateway', {
    drachtio: `${drachtioHost}:${drachtioPort}`,
    agent_runtime_arn: agentConfig.runtimeArn,
    voice_id: agentConfig.voiceId,
    public_ip: process.env.PUBLIC_IP,
    local_ip: process.env.LOCAL_IP,
  });

  // ───── Connect to drachtio with retry ─────
  // Drachtio server takes a second or two to bind its admin socket after
  // startup, and the Node.js process launches concurrently. Retry the
  // initial connect a few times so a cold-start race doesn't kill the
  // whole task.
  const srf = new Srf();
  await connectWithRetry(srf, {
    host: drachtioHost,
    port: drachtioPort,
    secret: drachtioSecret,
  });
  logger.info('drachtio connected');

  // ───── RTP port pool (NLB-forwarded range 16000-16048) ─────
  const portPool = new PortPool({ start: 16000, count: 49 });

  // ───── Start CloudWatch metrics publisher ─────
  if (process.env.ENABLE_CLOUDWATCH_METRICS !== 'false') {
    const metricsNamespace =
      process.env.METRICS_NAMESPACE ||
      `${process.env.DEPLOYMENT_PREFIX || 'dev'}/SipGateway`;
    cloudwatch.start({
      region: agentConfig.region,
      namespace: metricsNamespace,
      intervalMs: 60_000,
    });
  }

  // ───── Register INVITE handler ─────
  srf.invite(async (req, res) => {
    try {
      await handleInvite({
        req,
        res,
        srf,
        portPool,
        agentConfig,
      });
    } catch (err) {
      logger.error('invite handler crashed', { err: err.message });
      try {
        res.send(500);
      } catch {
        /* already sent */
      }
    }
  });

  // ───── Graceful shutdown ─────
  const shutdown = (signal) => {
    logger.info('shutdown received', { signal });
    try {
      srf.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Log unhandled errors but do NOT crash — we want ECS to keep the task
  // alive unless drachtio or rtpengine themselves exit.
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', { err: err?.message || String(err) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err: err?.message || String(err) });
  });
}

async function connectWithRetry(srf, opts, maxAttempts = 20, baseDelayMs = 500) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await srf.connect(opts);
      return;
    } catch (err) {
      lastErr = err;
      const delay = Math.min(baseDelayMs * attempt, 5000);
      logger.warn('drachtio connect failed; retrying', {
        attempt,
        err: err.message,
        retry_in_ms: delay,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    `drachtio connect failed after ${maxAttempts} attempts: ${lastErr?.message}`,
  );
}

main().catch((err) => {
  logger.error('fatal startup error', { err: err?.message || String(err) });
  process.exit(1);
});
