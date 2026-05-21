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

async function handleNewInboundCall(event: ChimeEvent): Promise<ChimeResponse> {
  const txId = extractTransactionId(event);
  const aLegCallId = findLegCallId(event, 'LEG-A');
  const from = findCallerFrom(event);
  const sipApplicationId = event.CallDetails?.SipApplicationId ?? '';

  logInfo('new_inbound_call', {
    transactionId: txId,
    fromLast4: lastFour(from),
    sipApplicationId,
    deploymentPrefix: DEPLOYMENT_PREFIX,
  });

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

  // ───── Pre-warm AgentCore microVM ─────
  //
  // Compute the deterministic session id from the caller's E.164 +
  // server-side pepper, then issue a SigV4-signed POST to the
  // AgentCore Runtime /invocations endpoint with that session id in
  // the X-Amzn-Bedrock-AgentCore-Runtime-Session-Id header. AgentCore
  // pins the microVM to that session id ("microVM stickiness"); when
  // the bridge later opens its wss connection with the same id it
  // attaches to the same warm container.
  //
  // Awaited so the phone keeps ringing while the agent finishes its
  // per-call setup (prompt render + Nova Sonic stream open + MCP tool
  // discovery + BidiAgent.start + prime-with-Hi). Failure here is
  // logged but NOT propagated — the bridge's /ws handler has a cold-
  // start fallback path so the call still completes (anonymous mode).
  let sessionId: string | null = null;
  if (AGENT_RUNTIME_ARN) {
    try {
      const pepper = await getCustomerIdPepper();
      const derived = pstnCustomer.derive(from, pepper);
      sessionId = derived.sessionId;
      if (sessionId) {
        const warmupBody = {
          type: 'warmup',
          raw_from: from,
          anonymous: derived.anonymous,
          from_last4: derived.fromLast4,
          call_id: aLegCallId,
          voice_id: AGENT_VOICE_ID,
        };
        const startedAt = Date.now();
        const result = await agentcoreWarmup.warmup({
          runtimeArn: AGENT_RUNTIME_ARN,
          region: REGION,
          sessionId,
          body: warmupBody,
        });
        const elapsedMs = Date.now() - startedAt;
        if (result.status === 200) {
          logInfo('warmup_ok', {
            transactionId: txId,
            fromLast4: derived.fromLast4,
            customerId: derived.customerId,
            elapsedMs,
          });
        } else {
          logWarn('warmup_non_200', {
            transactionId: txId,
            fromLast4: derived.fromLast4,
            status: result.status,
            elapsedMs,
            // Body intentionally trimmed — may contain stack traces from
            // the agent that include unrelated identifiers.
            bodyHead: (result.body ?? '').slice(0, 200),
          });
        }
      } else {
        // Anonymous caller — sessionId null by design. Fall through to
        // CallAndBridge without warmup; bridge takes the cold-start
        // path and the agent uses anonymous mode.
        logInfo('warmup_skipped_anonymous_caller', { transactionId: txId });
      }
    } catch (err: unknown) {
      // Best-effort warmup. Log + continue. The bridge's /ws cold path
      // handles a missing warm-cache entry by building an anonymous
      // session, so the call completes either way.
      logWarn('warmup_failed', {
        transactionId: txId,
        error: (err as Error)?.message ?? String(err),
      });
      sessionId = null;
    }
  } else {
    // AGENT_RUNTIME_ARN env var not set — pre-pre-warm-deploy state.
    // Leave sessionId null; CallAndBridge proceeds without the SIP
    // header and the bridge falls through to the anonymous path.
    logInfo('warmup_skipped_no_runtime_arn', { transactionId: txId });
  }

  // CallAndBridge to the VC. The Uri is the caller's E.164 — it's the
  // user-part of the SIP Request-URI on the B-leg and shows up in SIP
  // logs as a traceable breadcrumb. The Arn identifies the target VC;
  // its origination routes then forward the INVITE via TCP/5060 to the
  // NLB that fronts our SIP gateway cluster.
  //
  // CallerIdNumber: Chime requires either a number we own or the A-leg
  // `From`. We use the A-leg `From` (the original caller) so outbound
  // Caller Identification presentation matches the originating caller.
  //
  // SipHeaders: when we successfully pre-warmed an AgentCore microVM,
  // we ride the session id forward on the CallAndBridge action so the
  // SIP gateway sees it on the INVITE headers and feeds it to its wss
  // connection. Per
  // https://docs.aws.amazon.com/chime-sdk/latest/dg/call-and-bridge.html
  // SipHeaders is a top-level parameter of the action (sibling of
  // Endpoints), NOT a property of the endpoint object. Earlier
  // attempts placed it inside the endpoint and Chime silently dropped
  // the field. Limits per https://docs.aws.amazon.com/chime-sdk/latest/dg/sip-headers.html:
  // ≤20 entries (analogous to CreateSipMediaApplicationCall API), each
  // value ≤2048 characters, custom names must start with X-, and X-AMZN
  // is reserved.
  const bridgeParams: Record<string, unknown> = {
    CallTimeoutSeconds: CALL_BRIDGE_TIMEOUT_SECONDS,
    CallerIdNumber: from,
    Endpoints: [
      {
        BridgeEndpointType: 'AWS',
        Arn: vcArn,
        Uri: from || 'agent',
      },
    ],
  };
  if (sessionId) {
    bridgeParams.SipHeaders = { 'X-Session-Id': sessionId };
  }
  const bridge: ChimeAction = {
    Type: 'CallAndBridge',
    Parameters: bridgeParams,
  };
  return respond([bridge]);
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
    return handleNewInboundCall(event);
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
