/**
 * {prefix}-sma-handler — Chime SIP Media Application (SMA) Lambda.
 *
 * r6 contract (tracks design.md r6 + tasks.md Task 10.7):
 *
 * The SMA Lambda's job narrows dramatically in r6. Its sole purpose is to
 * bridge the inbound A-leg to our Chime Voice Connector (VC). The VC's
 * origination route (configured in IngressStack) then forwards the call
 * via Session Initiation Protocol (SIP) / TCP-5060 to the internal
 * Network Load Balancer (NLB) provisioned by SipGatewayStack, and the
 * SIP gateway picks up from there. The SIP gateway is the one that
 * talks to the AgentCore Runtime — not this Lambda.
 *
 * Event flow:
 *
 *   1. `NEW_INBOUND_CALL` →
 *        Return a single `CallAndBridge` action targeting the VC
 *        (`BridgeEndpointType:"AWS"`, `Arn:<VC ARN from SSM>`,
 *        `Uri:<caller E.164>`). Chime's control plane then originates a
 *        B-leg from the VC, which consults its origination routes and
 *        forwards the SIP INVITE to the NLB → SIP gateway.
 *
 *   2. `ACTION_SUCCESSFUL` on `CallAndBridge` →
 *        Return empty Actions. The audio path is entirely handled by the
 *        SIP gateway from this point — no need to invoke the agent, no
 *        need to resolve a Kinesis Video Streams (KVS) ARN. The r5
 *        InvokeAgentRuntime + KVS-resolution path has been REMOVED
 *        entirely.
 *
 *   3. `HANGUP` →
 *        Return empty Actions. The SIP gateway sees the BYE propagate
 *        through the NLB and cleans up its own session; the agent
 *        WebSocket closes naturally. No more `pstn_end` invoke on the
 *        agent.
 *
 *   4. `ACTION_FAILED` / `INVALID_LAMBDA_RESPONSE` →
 *        Log the error and return `[{Type:"Hangup"}]` so we tear the
 *        call down cleanly instead of looping on another malformed
 *        response.
 *
 *   5. Other informational events (`ACTION_INTERRUPTED`, `RINGING`,
 *      `CALL_ANSWERED`, `CALL_UPDATE_REQUESTED`, `DIGITS_RECEIVED`, …) →
 *        Return empty Actions.
 *
 * Environment contract (set by ingress-stack.ts — r6 trimmed):
 *   - DEPLOYMENT_PREFIX         — project prefix (for log tagging).
 *   - VOICE_CONNECTOR_ARN_PARAM — Systems Manager (SSM) parameter NAME
 *       that stores the VC ARN. Read at warm-up. Decoupling the ARN
 *       from the Lambda environment lets us replace the VC without
 *       redeploying the Lambda.
 *   - LOG_LEVEL                 — DEBUG | INFO (default) | WARN | ERROR.
 *
 * r5 env vars REMOVED in r6: `AGENT_RUNTIME_ARN`, `PLAYBACK_BUCKET`.
 *
 * Personally Identifiable Information (PII) posture (R19, NFR9):
 *   - `from` is logged only via a 4-char suffix (`fromLast4`) at INFO+.
 *     The full raw value never appears at INFO or above.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
// Plain-JS helpers — kept as .js so the deployed Lambda's index.js stays
// human-readable for hot-edits in the AWS Lambda console (CDK bundling
// inlines these by reference). Both pure-Node, no third-party deps.
//
// `pstn-customer.js` mirrors the agent's Python `pstn_customer.derive`
// byte-for-byte so the SMA Lambda and the agent compute identical
// `customerId` values for the same caller.
//
// `agentcore-warmup.js` issues the SigV4-signed POST to the AgentCore
// Runtime `/invocations` endpoint with the session-id header set, so a
// microVM is allocated to the session BEFORE the SIP INVITE reaches the
// bridge.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pstnCustomer = require('./pstn-customer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentcoreWarmup = require('./agentcore-warmup');

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const DEPLOYMENT_PREFIX = process.env.DEPLOYMENT_PREFIX ?? '';
const VC_ARN_PARAM = process.env.VOICE_CONNECTOR_ARN_PARAM ?? '';
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();

// AgentCore Runtime warmup config (added in the pre-warm refactor).
// Threaded in by IngressStack from cdk-outputs/tel-agent-runtime.json.
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN ?? '';
const CUSTOMER_ID_PEPPER_PARAM = process.env.CUSTOMER_ID_PEPPER_PARAMETER_NAME ?? '';
const AGENT_VOICE_ID = process.env.AGENT_VOICE_ID ?? 'tiffany';

/**
 * CallAndBridge call timeout — max time Chime will wait for the B-leg
 * to answer before treating it as a failure. Docs allow 1-120 s. We
 * pick 20 s: long enough for the VC to forward the INVITE through its
 * origination routes to the NLB and get the SIP gateway to answer on a
 * cold path, short enough that a misrouted bridge does not leave the
 * caller listening to silence.
 */
const CALL_BRIDGE_TIMEOUT_SECONDS = 20;

/**
 * Ring-and-poll tuning (cold-start masking).
 *
 * AgentCore Runtime scale-from-zero can take ~20-25s (host provisioning +
 * image pull), far longer than a single call-setup window. Rather than
 * bridge into a not-yet-booted microVM (whose /ws upgrade fails with 424),
 * we keep the caller ringing and re-probe the agent's idempotent warmup
 * endpoint until it reports READY, then bridge.
 *
 * Chime hangs up a call if a single Lambda invocation doesn't respond within
 * 20s, so each probe must return fast — we cap the probe abort well under
 * that and drive the wait as a loop of short Pause actions (Chime allows up
 * to 1,000 invocations per call).
 */
const RING_POLL_BUDGET_MS = 28_000; // max time to keep the caller ringing while warming
const RING_POLL_PAUSE_MS = 2_000; // ring dwell between readiness probes (one invocation per dwell)
const WARMUP_PROBE_TIMEOUT_MS = 3_500; // per-probe abort; keeps each invocation under Chime's 5s/20s limits

// Reuse the SSM client across warm Lambda invocations.
const ssm = new SSMClient({ region: REGION });

// Cache the VC ARN across warm invocations. Resolved on first use.
let cachedVoiceConnectorArn: string | null = null;

async function getVoiceConnectorArn(): Promise<string> {
  if (cachedVoiceConnectorArn) return cachedVoiceConnectorArn;
  if (!VC_ARN_PARAM) {
    throw new Error(
      'VOICE_CONNECTOR_ARN_PARAM env var is missing; IngressStack did not wire it.',
    );
  }
  const resp = await ssm.send(new GetParameterCommand({ Name: VC_ARN_PARAM }));
  const value = resp.Parameter?.Value ?? '';
  if (!value) {
    throw new Error(`SSM parameter ${VC_ARN_PARAM} is empty`);
  }
  cachedVoiceConnectorArn = value;
  return value;
}

// Cache the customer-id pepper across warm invocations. Loaded lazily on
// first use because we want the cold-start path to fail closed (warmup
// returns anonymous fallback) rather than block the Lambda init.
let cachedPepper: Buffer | null = null;

async function getCustomerIdPepper(): Promise<Buffer> {
  if (cachedPepper !== null) return cachedPepper;
  if (!CUSTOMER_ID_PEPPER_PARAM) {
    // Empty pepper is safe — pstn-customer.derive accepts Buffer.alloc(0).
    // The agent's Python helper logs a warning and uses b"" in this case
    // too, so the JS port stays in sync.
    logWarn('pepper_param_missing_using_empty', {});
    cachedPepper = Buffer.alloc(0);
    return cachedPepper;
  }
  const resp = await ssm.send(
    new GetParameterCommand({ Name: CUSTOMER_ID_PEPPER_PARAM, WithDecryption: true }),
  );
  const value = resp.Parameter?.Value ?? '';
  cachedPepper = Buffer.from(value, 'utf8');
  // Log only the fact + length, never the value (R18).
  logInfo('pepper_loaded', { pepperLen: cachedPepper.length });
  return cachedPepper;
}

type ChimeParticipant = {
  CallId?: string;
  From?: string;
  To?: string;
  Direction?: string;
  ParticipantTag?: string;
  Status?: string;
  StartTimeInMilliseconds?: string;
};

type ChimeCallDetails = {
  TransactionId?: string;
  AwsAccountId?: string;
  AwsRegion?: string;
  SipRuleId?: string;
  SipApplicationId?: string;
  Participants?: ChimeParticipant[];
};

type ChimeActionData = {
  Type?: string;
  Parameters?: Record<string, unknown>;
  ErrorType?: string;
  ErrorMessage?: string;
};

type ChimeEvent = {
  SchemaVersion?: string;
  Sequence?: number;
  InvocationEventType: string;
  CallDetails?: ChimeCallDetails;
  ActionData?: ChimeActionData;
};

type ChimeAction = { Type: string } & Record<string, unknown>;

/**
 * Chime SMA response envelope. Per the Chime SDK documentation, the
 * Lambda response MUST be an object of shape
 *   `{ "SchemaVersion": "1.0", "Actions": [...] }`
 * Returning a bare array or `null` results in
 * `INVALID_LAMBDA_RESPONSE` and the call is torn down by Chime.
 */
type ChimeResponse = {
  SchemaVersion: '1.0';
  Actions: ChimeAction[];
};

function respond(actions: ChimeAction[]): ChimeResponse {
  return { SchemaVersion: '1.0', Actions: actions };
}

function extractTransactionId(event: ChimeEvent): string {
  return event.CallDetails?.TransactionId ?? '';
}

function findLegCallId(event: ChimeEvent, legTag: 'LEG-A' | 'LEG-B'): string {
  const p = (event.CallDetails?.Participants ?? []).find(
    (x) => x.ParticipantTag === legTag,
  );
  return p?.CallId ?? '';
}

function findCallerFrom(event: ChimeEvent): string {
  // Caller's E.164 lives on LEG-A (the inbound A-leg) participant.
  const p = (event.CallDetails?.Participants ?? []).find(
    (x) => x.ParticipantTag === 'LEG-A',
  );
  return p?.From ?? event.CallDetails?.Participants?.[0]?.From ?? '';
}

function lastFour(value: string): string {
  if (!value) return '';
  const digits = value.replace(/\D+/g, '');
  return digits.slice(-4);
}

function logInfo(message: string, extra: Record<string, unknown>): void {
  if (
    LOG_LEVEL === 'DEBUG' ||
    LOG_LEVEL === 'INFO' ||
    LOG_LEVEL === 'WARN' ||
    LOG_LEVEL === 'ERROR'
  ) {
    console.log(JSON.stringify({ level: 'INFO', message, ...extra }));
  }
}

function logWarn(message: string, extra: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: 'WARN', message, ...extra }));
}

function logError(message: string, extra: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'ERROR', message, ...extra }));
}

/** Chime Pause action — delays the SMA WITHOUT answering the leg, so the
 * caller keeps hearing normal carrier ringback while the agent warms. */
function pauseAction(ms: number): ChimeAction {
  return { Type: 'Pause', Parameters: { DurationInMilliseconds: String(ms) } };
}

/**
 * Build the CallAndBridge action to the Voice Connector, optionally riding
 * the deterministic session id forward on a SipHeaders.X-Session-Id header.
 *
 * SipHeaders is a top-level CallAndBridge parameter (sibling of Endpoints),
 * NOT a property of the endpoint object — Chime silently drops it if nested.
 * Custom names must start with X-. The SIP gateway reads X-Session-Id off the
 * INVITE and feeds it to its AgentCore wss connection so the bridge attaches
 * to the same warm microVM. Limits: ≤20 entries, value ≤2048 chars.
 */
function buildBridgeAction(vcArn: string, from: string, sessionId: string | null): ChimeAction {
  const bridgeParams: Record<string, unknown> = {
    CallTimeoutSeconds: CALL_BRIDGE_TIMEOUT_SECONDS,
    CallerIdNumber: from,
    Endpoints: [{ BridgeEndpointType: 'AWS', Arn: vcArn, Uri: from || 'agent' }],
  };
  if (sessionId) {
    bridgeParams.SipHeaders = { 'X-Session-Id': sessionId };
  }
  return { Type: 'CallAndBridge', Parameters: bridgeParams };
}

/** Milliseconds the caller has been on the call so far (drives the ring budget). */
function callElapsedMs(event: ChimeEvent): number {
  const parts = event.CallDetails?.Participants ?? [];
  const legA = parts.find((p) => p.ParticipantTag === 'LEG-A') ?? parts[0];
  const start = Number(legA?.StartTimeInMilliseconds);
  if (!Number.isFinite(start) || start <= 0) return 0;
  return Math.max(0, Date.now() - start);
}

type WarmState = 'ready' | 'warming';

/**
 * Probe the agent's idempotent warmup endpoint. On the first tick this POST
 * also boots the microVM (it's what allocates the session). Returns 'ready'
 * ONLY on HTTP 200; every other outcome — 202 (build in flight), 424 (session
 * not yet routable), or a client-side timeout while the microVM is still
 * cold-booting — is 'warming', so the caller keeps ringing and we retry.
 */
async function probeWarmup(
  sessionId: string,
  from: string,
  derived: { anonymous: boolean; fromLast4: string; customerId: string },
  aLegCallId: string,
  txId: string,
): Promise<WarmState> {
  const warmupBody = {
    type: 'warmup',
    raw_from: from,
    anonymous: derived.anonymous,
    from_last4: derived.fromLast4,
    call_id: aLegCallId,
    voice_id: AGENT_VOICE_ID,
  };
  const startedAt = Date.now();
  try {
    const result = await agentcoreWarmup.warmup({
      runtimeArn: AGENT_RUNTIME_ARN,
      region: REGION,
      sessionId,
      body: warmupBody,
      timeoutMs: WARMUP_PROBE_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.status === 200) {
      logInfo('warmup_ready', {
        transactionId: txId,
        fromLast4: derived.fromLast4,
        customerId: derived.customerId,
        elapsedMs,
      });
      return 'ready';
    }
    logInfo('warmup_warming', {
      transactionId: txId,
      fromLast4: derived.fromLast4,
      status: result.status,
      elapsedMs,
    });
    return 'warming';
  } catch (err: unknown) {
    // Timeout/abort while the microVM is still cold-booting, or transport
    // error. Treated as 'warming' so the caller keeps ringing and we retry
    // on the next tick.
    logInfo('warmup_probe_pending', {
      transactionId: txId,
      fromLast4: derived.fromLast4,
      elapsedMs: Date.now() - startedAt,
      error: (err as Error)?.message ?? String(err),
    });
    return 'warming';
  }
}

/**
 * Ring-and-poll inbound handler.
 *
 * Runs on NEW_INBOUND_CALL and on each ACTION_SUCCESSFUL after a Pause. While
 * the caller rings, we probe the AgentCore warmup endpoint (idempotent, and
 * doubling as a readiness signal) and only issue CallAndBridge once the agent
 * reports the warm session is READY. This keeps the caller in the normal
 * ringing state during the AgentCore cold-start instead of bridging into a
 * not-yet-booted microVM (whose /ws upgrade fails with 424 and drops the call).
 *
 * A hard ring budget bounds how long we ring; once exceeded we bridge anyway
 * (best-effort) so we never ring forever. Anonymous callers (no deterministic
 * session id) and the no-runtime-arn state bridge immediately, as before.
 */
async function handleInboundRingPoll(event: ChimeEvent): Promise<ChimeResponse> {
  const txId = extractTransactionId(event);
  const aLegCallId = findLegCallId(event, 'LEG-A');
  const from = findCallerFrom(event);
  const eventType = event.InvocationEventType ?? '';

  let vcArn: string;
  try {
    vcArn = await getVoiceConnectorArn();
  } catch (err: unknown) {
    logError('voice_connector_arn_resolve_failed', {
      transactionId: txId,
      error: (err as Error)?.message ?? String(err),
    });
    return respond([{ Type: 'Hangup' }]);
  }

  // Derive the deterministic session id (HMAC of E.164 + pepper). Anonymous
  // callers and the no-runtime-arn state have no warm session to wait for.
  let sessionId: string | null = null;
  let derived: {
    customerId: string;
    anonymous: boolean;
    fromLast4: string;
    sessionId: string | null;
  } | null = null;
  if (AGENT_RUNTIME_ARN) {
    try {
      const pepper = await getCustomerIdPepper();
      derived = pstnCustomer.derive(from, pepper);
      sessionId = derived?.sessionId ?? null;
    } catch (err: unknown) {
      logWarn('session_id_derive_failed', {
        transactionId: txId,
        error: (err as Error)?.message ?? String(err),
      });
      sessionId = null;
    }
  }

  if (eventType === 'NEW_INBOUND_CALL') {
    logInfo('new_inbound_call', {
      transactionId: txId,
      fromLast4: lastFour(from),
      sipApplicationId: event.CallDetails?.SipApplicationId ?? '',
      hasSessionId: Boolean(sessionId),
      deploymentPrefix: DEPLOYMENT_PREFIX,
    });
  }

  // Anonymous caller or pre-warm not configured -> bridge immediately on the
  // cold-anonymous path (no session header). Nothing to wait for.
  if (!sessionId || !derived) {
    logInfo('ring_poll_bridge_anonymous', { transactionId: txId });
    return respond([buildBridgeAction(vcArn, from, null)]);
  }

  // Probe the idempotent warmup (also boots the microVM on the first tick).
  const elapsedMs = callElapsedMs(event);
  const state = await probeWarmup(sessionId, from, derived, aLegCallId, txId);

  if (state === 'ready') {
    logInfo('warm_ready_bridging', {
      transactionId: txId,
      fromLast4: derived.fromLast4,
      customerId: derived.customerId,
      elapsedMs,
    });
    return respond([buildBridgeAction(vcArn, from, sessionId)]);
  }

  if (elapsedMs >= RING_POLL_BUDGET_MS) {
    // Cold start is taking longer than the ring budget. Bridge anyway with the
    // session id so the bridge's own ws attempt can still catch the microVM as
    // it finishes booting — better than ringing past the caller's patience.
    logWarn('ring_budget_exhausted_bridging', {
      transactionId: txId,
      fromLast4: derived.fromLast4,
      elapsedMs,
    });
    return respond([buildBridgeAction(vcArn, from, sessionId)]);
  }

  // Still warming and budget remains -> keep the caller ringing, re-probe next tick.
  logInfo('ring_poll_waiting', {
    transactionId: txId,
    fromLast4: derived.fromLast4,
    elapsedMs,
  });
  return respond([pauseAction(RING_POLL_PAUSE_MS)]);
}

export const handler = async (event: ChimeEvent): Promise<ChimeResponse> => {
  const eventType = event.InvocationEventType ?? '';
  const actionType = event.ActionData?.Type ?? '';

  // ───── Diagnostic: log the entire event payload verbatim ─────
  //
  // We need to inspect the SIP headers and parameters Chime forwards
  // on each INVITE to identify any field that carries a store /
  // location / customer routing identifier (e.g. a Diversion header,
  // Referred-By, custom X-headers, or a SIP URI parameter on the
  // `To` line). The full event is the only reliable way to see what
  // Chime exposes — `aws chime-sdk-voice` docs are not exhaustive on
  // this surface and the shape can change between Chime releases.
  //
  // PII posture: this is a deliberately verbose log gated by an env
  // flag. Production deploys should leave LOG_RAW_EVENT=false. The
  // raw event includes the full caller `From` E.164, so do NOT enable
  // this in shared / production environments without explicit
  // approval.
  if (process.env.LOG_RAW_EVENT === 'true') {
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'sma_event_raw',
        invocationEventType: eventType,
        actionType,
        deploymentPrefix: DEPLOYMENT_PREFIX,
        rawEvent: event,
      }),
    );
  }

  if (eventType === 'NEW_INBOUND_CALL') {
    return handleInboundRingPoll(event);
  }

  if (eventType === 'ACTION_SUCCESSFUL' && actionType === 'Pause') {
    // Ring-and-poll loop tick: the caller is still ringing after our Pause.
    // Re-probe warmup and either bridge (ready) or ring again (still warming).
    return handleInboundRingPoll(event);
  }

  if (eventType === 'ACTION_SUCCESSFUL' && actionType === 'CallAndBridge') {
    // The bridge completed — the call is now anchored on the SIP gateway
    // via the VC. Our job here is done; return empty Actions. r5 used to
    // resolve a KVS stream and call InvokeAgentRuntime at this point;
    // both are no-ops in r6.
    logInfo('call_and_bridge_successful', {
      aLegCallId: findLegCallId(event, 'LEG-A'),
      bLegCallId: findLegCallId(event, 'LEG-B'),
      fromLast4: lastFour(findCallerFrom(event)),
    });
    return respond([]);
  }

  if (eventType === 'HANGUP') {
    // BYE propagates through the VC → NLB → SIP gateway naturally; the
    // SIP gateway closes its WebSocket to the agent; nothing for us to
    // do here. r5 used to call `pstn_end` on the agent; that's gone.
    logInfo('hangup', {
      aLegCallId: findLegCallId(event, 'LEG-A') || extractTransactionId(event),
      deploymentPrefix: DEPLOYMENT_PREFIX,
    });
    return respond([]);
  }

  if (eventType === 'ACTION_FAILED' || eventType === 'INVALID_LAMBDA_RESPONSE') {
    logWarn('sma_event_error', {
      invocationEventType: eventType,
      aLegCallId: findLegCallId(event, 'LEG-A'),
      actionType,
      errorType: event.ActionData?.ErrorType,
      errorMessage: event.ActionData?.ErrorMessage,
    });
    return respond([{ Type: 'Hangup' }]);
  }

  // ACTION_SUCCESSFUL for other action types, ACTION_INTERRUPTED,
  // RINGING, CALL_ANSWERED, DIGITS_RECEIVED, CALL_UPDATE_REQUESTED —
  // purely informational. Empty Actions are valid on these event types.
  logInfo('sma_event_passthrough', {
    invocationEventType: eventType,
    actionType,
    aLegCallId: findLegCallId(event, 'LEG-A'),
  });
  return respond([]);
};
