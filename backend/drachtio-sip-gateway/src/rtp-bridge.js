'use strict';

const dgram = require('node:dgram');
const { alaw, mulaw } = require('alawmulaw');
const logger = require('./logger');

/**
 * Per-call bidirectional RTP <-> PCM pipe.
 *
 * Inbound direction (caller -> AgentCore):
 *   rtpengine B-side UDP --> this.socket --> parse RTP --> mu-law decode -->
 *   upsample 8kHz->16kHz --> this.onInboundPcm(Int16Array)
 *
 * Outbound direction (AgentCore -> caller):
 *   this.writeOutboundPcm(Int16Array @ 16kHz) --> downsample 16kHz->8kHz -->
 *   mu-law encode --> pack RTP header (seq++, ts+=160) --> socket.send(rtpeB)
 *
 * Codec is negotiated between Chime VC and rtpengine; in our SDP
 * synthesis we offer PCMU and PCMA. Chime defaults to PCMU on North
 * American Public Switched Telephone Network (PSTN). We handle both
 * by reading the RTP payload-type (0 = PCMU, 8 = PCMA) off each
 * inbound packet.
 */

const RTP_HEADER_BYTES = 12;

// One RTP packet per 20ms of audio at 8kHz = 160 samples = 160 bytes
// (G.711 is 1 byte per sample).
const PCM_SAMPLE_RATE = 8000;
const PCM_FRAME_SAMPLES = 160;
const PCM_FRAME_INTERVAL_MS = 20;

const PT_PCMU = 0;
const PT_PCMA = 8;

function parseRtp(buf) {
  if (buf.length < RTP_HEADER_BYTES) return null;
  // First byte: version (2 bits), padding (1), extension (1), CC (4).
  // We don't support extension headers or CSRCs. CC must be 0.
  const cc = buf[0] & 0x0f;
  const headerLen = RTP_HEADER_BYTES + cc * 4;
  if (buf.length < headerLen) return null;
  return {
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    seq: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(headerLen),
  };
}

function buildRtp({ payloadType, seq, timestamp, ssrc, payload, marker = false }) {
  const hdr = Buffer.alloc(RTP_HEADER_BYTES);
  hdr[0] = 0x80; // V=2, P=0, X=0, CC=0
  hdr[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  hdr.writeUInt16BE(seq & 0xffff, 2);
  hdr.writeUInt32BE(timestamp >>> 0, 4);
  hdr.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}

// --- Simple integer-ratio resampling (8 kHz <-> 16 kHz) -------------
//
// Telephony audio is narrowband (4 kHz effective). At 2x integer
// ratios the image frequencies are well outside the passband so the
// quality penalty of skipping proper anti-aliasing filters is
// imperceptible for voice. If this ever needs to support wideband
// codecs, swap these out for polyphase FIR filters.

/** Upsample 8 kHz PCM -> 16 kHz by linear interpolation. */
function upsample8to16(in8) {
  const out16 = new Int16Array(in8.length * 2);
  for (let i = 0; i < in8.length; i++) {
    const cur = in8[i];
    const next = i + 1 < in8.length ? in8[i + 1] : cur;
    out16[i * 2] = cur;
    out16[i * 2 + 1] = (cur + next) >> 1;
  }
  return out16;
}

/** Downsample 16 kHz PCM -> 8 kHz by pairwise averaging. */
function downsample16to8(in16) {
  const len = in16.length >> 1;
  const out8 = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    out8[i] = (in16[i * 2] + in16[i * 2 + 1]) >> 1;
  }
  return out8;
}

class RtpBridge {
  /**
   * @param {object} opts
   * @param {number} opts.localPort      Loopback UDP port to bind (our B-side).
   * @param {string} opts.callId         SIP Call-ID, used in logs.
   * @param {(pcm16: Int16Array) => void} opts.onInboundPcm
   *        Called once per 20ms frame (320 samples @ 16kHz) for caller audio.
   */
  constructor({ localPort, bindAddress, callId, onInboundPcm, initialRemoteHost, initialRemotePort }) {
    this.localPort = localPort;
    this.bindAddress = bindAddress || '0.0.0.0';
    this.callId = callId;
    this.onInboundPcm = onInboundPcm;
    this.log = logger.child({ call_id: callId, local_port: localPort });

    this.socket = null;
    // The remote address we send outbound RTP to. May be pre-latched
    // from the caller's SDP (see call-handler.parseSdpMediaEndpoint)
    // OR learned dynamically on the first inbound packet. When speaking
    // directly to Chime (no rtpengine), we pre-latch from Chime's SDP
    // so Nova Sonic's greeting starts flowing immediately.
    this.remoteHost = initialRemoteHost || null;
    this.remotePort = initialRemotePort || null;

    // Outbound RTP state.
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
    this.seq = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    // Payload type we send back. Defaults to PCMU; flips to PCMA the
    // first time we see PCMA on the wire.
    this.outboundPt = PT_PCMU;

    this.packetsIn = 0;
    this.packetsOut = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.stopped = false;

    // Paced-output queue: `writeOutboundPcm()` enqueues 20 ms frames;
    // a 20 ms `setInterval` timer pops one frame per tick and sends it
    // over RTP. Without this, Nova Sonic's bursty output (we receive
    // ~60-500 ms of audio per WebSocket frame, all in the same tick)
    // would produce a burst of 3-25 RTP packets on the wire every few
    // hundred ms, while Chime's caller-side jitter buffer expects a
    // steady 20 ms cadence. The resulting underruns between bursts
    // show up as choppy playback.
    //
    // Queue shape: each entry is a 20 ms Int16Array @ 16 kHz mono
    // (320 samples). We cap the queue to prevent runaway memory if
    // Nova Sonic ever outpaces the pacer.
    //
    // Cap raised to 1500 frames (30 s) to absorb the burst that Nova
    // Sonic emits after a long MCP tool call. Pattern observed:
    //   1. Model calls GetMenu -- tool takes ~1 s round-trip.
    //   2. During the await, Nova Sonic generates its entire
    //      "here's the menu..." reply internally.
    //   3. As soon as the tool result is injected, Nova Sonic emits
    //      the full reply as BidiAudioStreamEvents back to back.
    //   4. Python's 60 ms aggregator flushes envelopes on every
    //      threshold hit, so ~10 s of pre-buffered audio arrives in
    //      a few hundred ms of real time.
    //   5. At the old 200-frame cap (4 s), 6+ seconds of audio got
    //      dropped with `dropped_queue_full` -- caller heard a
    //      fragmented, clipped version of the reply ("throws all
    //      phrases in a fraction of a second").
    // 1500 × 320 bytes = 480 KB of memory per call, well under the
    // Fargate task's memory budget. The 20 ms pacer still drives the
    // actual wire cadence; we're just tolerating larger internal
    // buffering.
    //
    // Initial-buffering state machine (ported from the Nova Sonic
    // browser AudioPlayerProcessor.worklet.js pattern):
    //   - `isInitialBuffering = true` means the drain is paused until
    //     the queue accumulates `initialBufferFrames` frames.
    //   - Set to true at startup AND whenever the queue goes dry
    //     (underflow). Flipped to false once the cushion fills.
    //   - Why: the model emits audio in bursts (especially after an
    //     MCP tool call). Without a cushion, the first few frames of
    //     the burst go out immediately, then the drain races ahead of
    //     the arriving frames and the queue underflows between bursts.
    //     Chime's jitter buffer (~100-200 ms on the caller side) can
    //     absorb small jitter, but not the kind of mid-burst dry-out
    //     we get with tool-call gaps. Holding playback until we have
    //     400 ms queued lets the drain ride across the dry patches.
    //   - 400 ms is a deliberate trade-off: enough cushion to ride
    //     out the typical MCP tool-call burst pattern, small enough
    //     that the added round-trip latency stays sub-second for the
    //     caller. Adjust via `initialBufferFrames` if call traces
    //     show different bursts.
    this.outboundQueue = [];
    this.outboundQueueMax = 1500; // 30 s at 20 ms cadence
    this.outboundTimer = null;
    this.outboundDroppedFull = 0;
    this.outboundDroppedNoPeer = 0;
    this.isInitialBuffering = true;
    this.initialBufferFrames = 20; // 400 ms cushion (20 × 20 ms)
    this.outboundUnderflows = 0;
    this.outboundUnderflowFrames = 0;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.once('error', (err) => {
        this.log.error('bridge socket error', { err: err.message });
        reject(err);
      });
      this.socket.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
      this.socket.bind(this.localPort, this.bindAddress, () => {
        this.log.info('rtp bridge listening', {
          bind: `${this.bindAddress}:${this.localPort}`,
          initial_remote: this.remoteHost
            ? `${this.remoteHost}:${this.remotePort}`
            : 'none',
        });
        // Start the paced outbound sender.
        this.outboundTimer = setInterval(
          () => this._drainOutboundQueue(),
          PCM_FRAME_INTERVAL_MS,
        );
        resolve();
      });
    });
  }

  _onPacket(buf, rinfo) {
    if (this.stopped) return;

    // Latch onto whichever source rtpengine uses (its egress port).
    if (this.remoteHost == null) {
      this.remoteHost = rinfo.address;
      this.remotePort = rinfo.port;
      this.log.info('rtp remote latched', {
        remote_host: this.remoteHost,
        remote_port: this.remotePort,
      });
    }

    const pkt = parseRtp(buf);
    if (!pkt) return;

    this.packetsIn += 1;
    this.bytesIn += buf.length;

    // Remember what payload type the caller is using so we send back the
    // same one on the return path.
    if (pkt.payloadType === PT_PCMU || pkt.payloadType === PT_PCMA) {
      this.outboundPt = pkt.payloadType;
    } else {
      // Unexpected payload type (DTMF rfc2833 event, CN, etc.) — skip.
      return;
    }

    const pcm8 =
      pkt.payloadType === PT_PCMA
        ? alaw.decode(pkt.payload)
        : mulaw.decode(pkt.payload);
    const pcm16 = upsample8to16(pcm8);

    try {
      this.onInboundPcm(pcm16);
    } catch (err) {
      this.log.error('onInboundPcm handler threw', { err: err.message });
    }
  }

  /**
   * Drop any queued outbound frames and re-enter the initial-buffering
   * state. Called on caller barge-in so stale Nova Sonic audio stops
   * playing immediately. Equivalent to the browser worklet's
   * `clearBuffer` message.
   */
  clearOutbound() {
    const flushed = this.outboundQueue.length;
    this.outboundQueue.length = 0;
    this.isInitialBuffering = true;
    if (flushed > 0) {
      this.log.info('rtp outbound queue cleared (barge-in)', {
        flushed_frames: flushed,
      });
    }
  }

  /**
   * Enqueue one 20 ms frame of 16 kHz linear PCM for paced transmission.
   * The paced sender (`_drainOutboundQueue`, a 20 ms interval) pops
   * one frame per tick and actually writes it to the RTP socket.
   *
   * @param {Int16Array} pcm16  Expected length 320 (= 16000 * 0.02).
   */
  writeOutboundPcm(pcm16) {
    if (this.stopped) return;
    if (!pcm16 || pcm16.length === 0) return;
    if (this.outboundQueue.length >= this.outboundQueueMax) {
      // Drop oldest — keeps latency bounded if we ever fall behind.
      this.outboundQueue.shift();
      this.outboundDroppedFull += 1;
    }
    this.outboundQueue.push(pcm16);
  }

  /**
   * Paced-sender tick: called every PCM_FRAME_INTERVAL_MS (20 ms).
   *
   * Two states:
   *   - `isInitialBuffering`: hold playback until the queue has at
   *     least `initialBufferFrames` frames in it. This is the cushion
   *     that lets us ride over Nova Sonic's bursty output pattern.
   *   - Steady state: pop one queued frame per tick and send it. If
   *     the queue drops to empty during steady state (underflow),
   *     flip back to `isInitialBuffering` so the next burst can build
   *     a fresh cushion before playback resumes.
   *
   * Pattern adapted from the Nova Sonic browser reference player
   * (AudioPlayerProcessor.worklet.js, ExpandableBuffer).
   */
  _drainOutboundQueue() {
    if (this.stopped) return;
    if (this.remoteHost == null) {
      // Haven't latched yet — drop any stale frames rather than block
      // the queue from filling.
      if (this.outboundQueue.length > 0) {
        this.outboundQueue.shift();
        this.outboundDroppedNoPeer += 1;
      }
      return;
    }
    if (!this.socket) return;

    // If we're still building the initial cushion, keep waiting until
    // we have enough queued.
    if (this.isInitialBuffering) {
      if (this.outboundQueue.length < this.initialBufferFrames) {
        return;
      }
      // Cushion is ready; flip to steady state.
      this.isInitialBuffering = false;
    }

    // Steady state. If nothing is queued, treat as an underflow:
    // re-enter buffering until the next burst fills the cushion.
    if (this.outboundQueue.length === 0) {
      this.outboundUnderflows += 1;
      this.outboundUnderflowFrames += 1;
      this.isInitialBuffering = true;
      return;
    }

    const pcm16 = this.outboundQueue.shift();
    this._sendRtpFrame(pcm16);
  }

  /**
   * Encode + wrap + send one 20 ms frame of 16 kHz PCM as one RTP
   * packet. Increments sequence/timestamp. Called only from the
   * paced sender.
   */
  _sendRtpFrame(pcm16) {
    const pcm8 = downsample16to8(pcm16);
    const payload =
      this.outboundPt === PT_PCMA
        ? Buffer.from(alaw.encode(pcm8))
        : Buffer.from(mulaw.encode(pcm8));

    const pkt = buildRtp({
      payloadType: this.outboundPt,
      seq: this.seq++,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      payload,
    });
    this.timestamp = (this.timestamp + PCM_FRAME_SAMPLES) >>> 0;

    this.socket.send(pkt, this.remotePort, this.remoteHost, (err) => {
      if (err) {
        this.log.warn('rtp send failed', { err: err.message });
        return;
      }
      this.packetsOut += 1;
      this.bytesOut += pkt.length;
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.outboundTimer) {
      clearInterval(this.outboundTimer);
      this.outboundTimer = null;
    }
    this.outboundQueue.length = 0;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.log.info('rtp bridge stopped', {
      packets_in: this.packetsIn,
      packets_out: this.packetsOut,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      dropped_queue_full: this.outboundDroppedFull,
      dropped_no_peer: this.outboundDroppedNoPeer,
      underflow_events: this.outboundUnderflows,
      underflow_frames: this.outboundUnderflowFrames,
    });
  }
}

module.exports = {
  RtpBridge,
  parseRtp,
  buildRtp,
  upsample8to16,
  downsample16to8,
  PCM_SAMPLE_RATE,
  PCM_FRAME_SAMPLES,
  PCM_FRAME_INTERVAL_MS,
  PT_PCMU,
  PT_PCMA,
};
