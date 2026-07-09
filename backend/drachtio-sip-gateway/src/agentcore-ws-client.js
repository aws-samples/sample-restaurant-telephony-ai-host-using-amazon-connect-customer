'use strict';

const WebSocket = require('ws');
const { presignUrl, signPostHeaders } = require('./sigv4');
const { getCredentials } = require('./aws-credentials');
const logger = require('./logger');

/**
 * Opens a SigV4-signed WebSocket connection to Bedrock AgentCore Runtime.
 *
 * URL shape (matches the reference Python signer used by the earlier
 * prototype, `scripts/sign_agentcore_url.py`, so the server-side agent
 * in backend/agentcore-runtime-telephony/agent/ does not need to change):
 *
 *   wss://bedrock-agentcore.<region>.amazonaws.com
 *        /runtimes/<runtime-arn>/ws
 *        ?qualifier=DEFAULT&voice_id=<matthew|tiffany|amy>
 *        &X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=<id>   (optional)
 *
 * Protocol on the wire:
 *   - client -> server: binary frames, raw L16 PCM mono 16 kHz.
 *   - server -> client: JSON frames of the shape
 *         { "type": "streamAudio",
 *           "data": { "audioDataType":"raw", "sampleRate":16000,
 *                     "audioData":"<base64>" } }
 *     representing agent audio to play to the caller.
 *   - The legacy `auth` text-frame protocol was removed — the session
 *     ID query parameter is now the sole identity carrier (the SMA
 *     Lambda pre-warms the agent via POST /invocations using the same
 *     session ID and the agent stashes the call context in a microVM-
 *     local cache; the /ws handler attaches by session ID lookup).
 *
 * On hangup the caller invokes `.stopRuntimeSession()` so AgentCore
 * frees the per-session microVM slot. If no session ID was supplied
 * to the constructor, that call is a no-op.
 */

class AgentCoreWebSocketClient {
  constructor({ runtimeArn, region, voiceId, qualifier = 'DEFAULT', sessionId, log }) {
    if (!runtimeArn) throw new Error('AgentCoreWebSocketClient: runtimeArn is required');
    if (!region) throw new Error('AgentCoreWebSocketClient: region is required');
    this.runtimeArn = runtimeArn;
    this.region = region;
    this.voiceId = voiceId || 'matthew';
    this.qualifier = qualifier;
    this.sessionId = sessionId || null;
    this.log = log || logger;
    this.ws = null;
    this.listeners = { audio: [], bargeIn: [], open: [], close: [], error: [] };
    this.closed = false;
    this.stopSessionCalled = false;
  }

  on(event, fn) {
    if (!this.listeners[event]) throw new Error(`unknown event: ${event}`);
    this.listeners[event].push(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this.listeners[event] || []) {
      try {
        fn(...args);
      } catch (err) {
        this.log.error('ws listener threw', { event, err: err.message });
      }
    }
  }

  async connect() {
    // SigV4 QUERY-STRING PRESIGN (matches boto3 SigV4QueryAuth and the
    // working URL the human pasted).  The runtime ARN stays raw in the
    // path (colons unencoded) on the wire; the signer percent-encodes
    // them internally for the canonical request.  No custom headers on
    // the WebSocket handshake — SignedHeaders=host means every other
    // header the `ws` library adds (Sec-WebSocket-*, User-Agent, etc.)
    // is ignored by the verifier.
    const host = `bedrock-agentcore.${this.region}.amazonaws.com`;
    const rawPath = `/runtimes/${this.runtimeArn}/ws`;
    let baseQuery =
      `qualifier=${encodeURIComponent(this.qualifier)}` +
      `&voice_id=${encodeURIComponent(this.voiceId)}`;

    // Session ID for microVM stickiness. Must be in the canonical query
    // before signing or the server will reject the signature. AgentCore
    // CONSUMES this query param at its edge for routing — it does NOT
    // forward it to the container as a header.
    //
    // To make the agent container see the session ID we ALSO pass it
    // under the `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` prefix:
    // AgentCore forwards any query param matching that prefix to the
    // container as a lowercased HTTP header. Reference:
    // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html#websocket-custom-headers
    if (this.sessionId) {
      baseQuery +=
        '&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=' +
        encodeURIComponent(this.sessionId) +
        '&X-Amzn-Bedrock-AgentCore-Runtime-Custom-Session-Id=' +
        encodeURIComponent(this.sessionId);
    }

    const credentials = await getCredentials();
    const wssUrl = presignUrl({
      host,
      rawPath,
      baseQuery,
      region: this.region,
      service: 'bedrock-agentcore',
      credentials,
      scheme: 'wss',
      expires: 3600,
    });

    this.log.debug('opening agentcore ws', {
      url_tail: wssUrl.slice(-80),
      session_id: this.sessionId,
    });

    // handshakeTimeout margin: on a fully-cold runtime the SMA warmup's
    // microVM can take ~13-15s to finish booting and accept the /ws
    // upgrade. 10s used to clip that window and surface as
    // "Opening handshake has timed out" on the first call after idle.
    // 18s gives the cold microVM room to come up while staying under
    // Chime's CallAndBridge CallTimeoutSeconds (20s) so we never leave
    // the caller hanging past the bridge-answer budget.
    this.ws = new WebSocket(wssUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 18_000,
    });

    this.ws.on('open', () => {
      this.log.info('agentcore ws open');
      this._emit('open');
    });
    this.ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    this.ws.on('error', (err) => {
      this.log.error('agentcore ws error', { err: err.message });
      this._emit('error', err);
    });
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.log.info('agentcore ws closed', {
        code,
        reason: reason?.toString('utf8'),
      });
      this._emit('close', code, reason);
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        this.ws.off('open', onOpen);
        reject(err);
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
    });
  }

  /**
   * Send a frame of 16 kHz linear PCM mono as a binary WebSocket message.
   * @param {Int16Array} pcm16
   */
  sendAudio(pcm16) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Int16Array -> little-endian byte buffer. Node runs on LE host, so
    // the Int16Array view's underlying ArrayBuffer is already LE.
    const buf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    this.ws.send(buf, { binary: true });
  }

  _onMessage(data, isBinary) {
    if (isBinary) {
      // Server never sends binary in the current protocol, but just in
      // case a future version does we log and drop.
      this.log.warn('unexpected binary frame from agent');
      return;
    }
    let env;
    try {
      env = JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.log.warn('non-JSON text frame from agent', { err: err.message });
      return;
    }
    if (env?.type === 'streamAudio' && env?.data?.audioData) {
      const pcmBytes = Buffer.from(env.data.audioData, 'base64');
      // Buffer -> Int16Array. The agent sends 16-bit little-endian.
      const pcm16 = new Int16Array(
        pcmBytes.buffer,
        pcmBytes.byteOffset,
        pcmBytes.byteLength / 2,
      );
      this._emit('audio', pcm16);
    } else if (env?.type === 'bargeIn') {
      // Python agent tells us the caller interrupted. Wipe the
      // outbound queue so stale Nova Sonic audio stops playing
      // immediately. Matches the AudioPlayerProcessor worklet's
      // `clearBuffer` message (browser player source).
      this._emit('bargeIn');
    } else {
      this.log.debug('non-audio agent frame', { type: env?.type });
    }
  }

  close(code = 1000, reason = 'call ended') {
    if (!this.ws || this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  /**
   * Tell AgentCore Runtime to terminate the per-session microVM and
   * free the slot against the account-level "Active session workloads"
   * quota. Idempotent — safe to call multiple times. Best-effort: any
   * failure is logged at warn and swallowed so call cleanup proceeds.
   *
   * Endpoint shape from the boto3 service model
   * (`bedrock-agentcore.StopRuntimeSession`):
   *   POST https://bedrock-agentcore.<region>.amazonaws.com
   *        /runtimes/<runtimeArn>/stopruntimesession
   *   Header: X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <id>
   *   Body: empty (clientToken optional, omitted)
   *
   * Reference:
   *   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-stop-session.html
   *
   * No-op if no `sessionId` was supplied to the constructor (transitional
   * deploy state where the SMA Lambda is not yet setting the session
   * header on the SIP INVITE).
   */
  async stopRuntimeSession() {
    if (!this.sessionId) {
      this.log.info('stopRuntimeSession skipped (no sessionId)');
      return;
    }
    if (this.stopSessionCalled) return;
    this.stopSessionCalled = true;

    const host = `bedrock-agentcore.${this.region}.amazonaws.com`;
    const path = `/runtimes/${encodeURIComponent(this.runtimeArn)}/stopruntimesession`;
    const url = new URL(`https://${host}${path}`);
    const body = '';

    let credentials;
    try {
      credentials = await getCredentials();
    } catch (err) {
      this.log.warn('stopRuntimeSession: getCredentials failed', { err: err.message });
      return;
    }

    let headers;
    try {
      headers = signPostHeaders({
        url,
        region: this.region,
        service: 'bedrock-agentcore',
        credentials,
        body,
      });
    } catch (err) {
      this.log.warn('stopRuntimeSession: signing failed', { err: err.message });
      return;
    }
    // Service-specific header — must be sent verbatim, NOT signed
    // (signed headers are limited to host/content-type/x-amz-* per
    // signPostHeaders; this header is read by the AgentCore service
    // outside the signature scope).
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = this.sessionId;

    try {
      const resp = await fetch(url.href, { method: 'POST', headers, body });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        this.log.warn('stopRuntimeSession: non-2xx', {
          status: resp.status,
          body: txt.slice(0, 200),
          session_id: this.sessionId,
        });
        return;
      }
      this.log.info('stopRuntimeSession ok', { session_id: this.sessionId });
    } catch (err) {
      this.log.warn('stopRuntimeSession: fetch failed', {
        err: err.message,
        session_id: this.sessionId,
      });
    }
  }
}

module.exports = { AgentCoreWebSocketClient };
