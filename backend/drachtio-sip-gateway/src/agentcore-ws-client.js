'use strict';

const WebSocket = require('ws');
const { presignUrl } = require('./sigv4');
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
 *
 * Protocol on the wire:
 *   - client -> server: first text frame is JSON auth metadata
 *         { "caller_from": "+1...", "call_id": "..." }
 *   - client -> server: binary frames, raw L16 PCM mono 16 kHz.
 *   - server -> client: JSON frames of the shape
 *         { "type": "streamAudio",
 *           "data": { "audioDataType":"raw", "sampleRate":16000,
 *                     "audioData":"<base64>" } }
 *     representing agent audio to play to the caller.
 *
 * This class wraps a single call's WebSocket. On open, the caller should
 * immediately call `.sendAuthMetadata(...)`. Thereafter:
 *   - binary caller audio from the bridge goes via `.sendAudio(pcm16)`,
 *   - agent audio arriving on the socket fires `.on('audio', pcm16 => ...)`.
 */

class AgentCoreWebSocketClient {
  constructor({ runtimeArn, region, voiceId, qualifier = 'DEFAULT', log }) {
    if (!runtimeArn) throw new Error('AgentCoreWebSocketClient: runtimeArn is required');
    if (!region) throw new Error('AgentCoreWebSocketClient: region is required');
    this.runtimeArn = runtimeArn;
    this.region = region;
    this.voiceId = voiceId || 'matthew';
    this.qualifier = qualifier;
    this.log = log || logger;
    this.ws = null;
    this.listeners = { audio: [], bargeIn: [], open: [], close: [], error: [] };
    this.closed = false;
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
    const baseQuery =
      `qualifier=${encodeURIComponent(this.qualifier)}` +
      `&voice_id=${encodeURIComponent(this.voiceId)}`;

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
    });

    this.ws = new WebSocket(wssUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
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
   * Send the first text frame — auth metadata.
   * The server uses this to derive the pseudonymous customer_id.
   */
  sendAuthMetadata({ callerFrom, callId }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('sendAuthMetadata: ws not open');
    }
    const payload = JSON.stringify({
      caller_from: callerFrom || '',
      call_id: callId || '',
    });
    this.ws.send(payload);
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
}

module.exports = { AgentCoreWebSocketClient };
