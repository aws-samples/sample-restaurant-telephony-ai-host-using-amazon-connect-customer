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
  constructor({
    localPort,
    bindAddress,
    callId,
    onInboundPcm,
    initialRemoteHost,
    initialRemotePort,
    onOutboundDropQueueFull,
    onOutboundUnderflow,
  }) {
    this.localPort = localPort;
    this.bindAddress = bindAddress || '0.0.0.0';
    this.callId = callId;
    this.onInboundPcm = onInboundPcm;
    // Optional metric callbacks. Called once per drop / underflow so the
    // call-handler can publish CloudWatch counters without coupling the
    // bridge to the metrics module. Both default to no-op.
    this.onOutboundDropQueueFull = onOutboundDropQueueFull || null;
    this.onOutboundUnderflow = onOutboundUnderflow || null;
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
    // Sizing rationale (POST tactical fix, May 2026):
    //
    //   The previous 1500-frame (30 s) cap was a workaround for an
    //   un-paced producer: Nova Sonic decodes faster than realtime, so
    //   the agent's WebSocket write loop could dump tens of seconds of
    //   audio into the queue in a few hundred ms. Diagnostics on a
    //   3-min call showed `dropped_queue_full=1822` (≈25% of inbound
    //   frames dropped silently) and 1243-frame mid-call queue flushes
    //   on barge-in.
    //
    //   The fix is to pace at the producer (telephony_agent.py
    //   `_write_loop`, env var `OUTPUT_PACER_ENABLED=true`) so the WS
    //   stream itself emits at 1x realtime. With a paced producer,
    //   this queue only needs to absorb network jitter on the WS path
    //   between AgentCore and this container.
    //
    //   - `outboundQueueMax = 100` (2 s) gives 10x the typical RTP
    //     jitter buffer headroom (~60-200 ms per RFC 3550 §6.3.1)
    //     while staying well inside the ITU-T G.114 mouth-to-ear
    //     budget of 150 ms one-way once the producer is paced.
    //   - `initialBufferFrames = 5` (100 ms) is a small cushion that
    //     hides single-packet jitter spikes without adding perceivable
    //     greeting-start latency. With a paced producer the full
    //     cushion is reachable in 100 ms (vs the old 400 ms) since
    //     audio arrives at ~realtime instead of in bursts.
    //   - 100 × 320 bytes = 32 KB of memory per call. Trivial.
    //
    //   These can be tuned at runtime without a redeploy via env vars
    //   `OUTBOUND_QUEUE_MAX_FRAMES` and `INITIAL_BUFFER_FRAMES`. The
    //   defaults are the production-safe values.
    //
    // Drop semantics: when the queue is full we drop the OLDEST frame
    // (`shift()`) so the listener hears the most-recent audio with a
    // brief glitch, rather than a long delay before the audio resumes.
    // Each drop fires `onOutboundDropQueueFull()` so the call-handler
    // can publish a CloudWatch metric — non-zero in production is a
    // signal that producer pacing has regressed.
    //
    // Initial-buffering state machine (ported from the Nova Sonic
    // browser AudioPlayerProcessor.worklet.js pattern):
    //   - `isInitialBuffering = true` means the drain is paused until
    //     the queue accumulates `initialBufferFrames` frames.
    //   - Set to true at startup AND whenever the queue goes dry
    //     (underflow). Flipped to false once the cushion fills.
    //   - Why: even with a paced producer, single-packet WS jitter can
    //     cause a momentary dry-out. The cushion lets the drain ride
    //     across small gaps without re-buffering.
    const queueMaxEnv = parseInt(process.env.OUTBOUND_QUEUE_MAX_FRAMES || '', 10);
    const cushionEnv = parseInt(process.env.INITIAL_BUFFER_FRAMES || '', 10);
    this.outboundQueue = [];
    this.outboundQueueMax = Number.isFinite(queueMaxEnv) && queueMaxEnv > 0 ? queueMaxEnv : 100; // 2 s at 20 ms cadence
    this.outboundTimer = null;
    this.outboundDroppedFull = 0;
    this.outboundDroppedNoPeer = 0;
    this.isInitialBuffering = true;
    this.initialBufferFrames = Number.isFinite(cushionEnv) && cushionEnv > 0 ? cushionEnv : 5; // 100 ms cushion (5 × 20 ms)
    this.outboundUnderflows = 0;
    this.outboundUnderflowFrames = 0;

    // ───── Diagnostic instrumentation (Issue 1A — beep at greeting start) ─────
    //
    // Walltime anchors so every diagnostic log carries a millisecond
    // offset from `start()`. Helps correlate the order of:
    //   - bridge listening
    //   - first inbound RTP from caller
    //   - first outbound frame queued (Nova Sonic primed)
    //   - initial-buffering cushion filled
    //   - first outbound RTP frame on the wire
    //   - any clearOutbound (barge-in) within the first few seconds
    //   - any underflow within the first few seconds
    //
    // Diagnostic flag to toggle off once we've root-caused the issue:
    //   ENABLE_BRIDGE_DIAGNOSTICS=true (default) -> verbose start logs
    this.bridgeStartedAtMs = 0;
    this.firstInboundLogged = false;
    this.firstOutboundQueuedLogged = false;
    this.firstOutboundSentLogged = false;
    this.cushionFilledLogged = false;
    this.diagFrameSampleCount = 50; // log first N outbound frames
    this.diagFramesLogged = 0;
    this.diagEnabled = process.env.ENABLE_BRIDGE_DIAGNOSTICS !== 'false';
  }

  /** Returns ms elapsed since `start()` returned, or 0 if not started. */
  _msSinceStart() {
    if (!this.bridgeStartedAtMs) return 0;
    return Date.now() - this.bridgeStartedAtMs;
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
        this.bridgeStartedAtMs = Date.now();
        this.log.info('rtp bridge listening', {
          bind: `${this.bindAddress}:${this.localPort}`,
          initial_remote: this.remoteHost
            ? `${this.remoteHost}:${this.remotePort}`
            : 'none',
          ms_since_start: 0,
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

    if (this.diagEnabled && !this.firstInboundLogged) {
      this.firstInboundLogged = true;
      this.log.info('diag: first inbound rtp packet', {
        ms_since_start: this._msSinceStart(),
        payload_type: pkt.payloadType,
        seq: pkt.seq,
        marker: pkt.marker,
        from: `${rinfo.address}:${rinfo.port}`,
      });
    }

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
    // Always log clearOutbound during the early call window — that's
    // exactly where the "beep at greeting start" is suspected to come
    // from. After the diagnostic period, only log if we actually
    // flushed something so steady-state quiet calls stay quiet.
    const ms = this._msSinceStart();
    const inEarlyWindow = this.diagEnabled && ms < 5000;
    if (flushed > 0 || inEarlyWindow) {
      this.log.info('rtp outbound queue cleared (barge-in)', {
        flushed_frames: flushed,
        ms_since_start: ms,
        packets_out_before_clear: this.packetsOut,
        in_early_window: inEarlyWindow,
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

    if (this.diagEnabled && !this.firstOutboundQueuedLogged) {
      this.firstOutboundQueuedLogged = true;
      this.log.info('diag: first outbound frame queued', {
        ms_since_start: this._msSinceStart(),
        frame_samples: pcm16.length,
      });
    }

    if (this.outboundQueue.length >= this.outboundQueueMax) {
      // Drop oldest — keeps latency bounded if we ever fall behind.
      this.outboundQueue.shift();
      this.outboundDroppedFull += 1;
      // Surface every drop the first time it happens in a call window
      // so the operator can see WHEN the producer outpaced the drain
      // (matches the diagnostic instrumentation pattern). Subsequent
      // drops are aggregated into the per-call summary on stop().
      if (this.outboundDroppedFull <= 5 || this.outboundDroppedFull % 50 === 0) {
        this.log.warn('rtp outbound queue full — dropped oldest frame', {
          ms_since_start: this._msSinceStart(),
          dropped_total: this.outboundDroppedFull,
          queue_max: this.outboundQueueMax,
        });
      }
      if (this.onOutboundDropQueueFull) {
        try {
          this.onOutboundDropQueueFull();
        } catch (err) {
          this.log.warn('onOutboundDropQueueFull callback threw', {
            err: err.message,
          });
        }
      }
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
      if (this.diagEnabled && !this.cushionFilledLogged) {
        this.cushionFilledLogged = true;
        this.log.info('diag: initial buffering cushion filled', {
          ms_since_start: this._msSinceStart(),
          cushion_frames: this.outboundQueue.length,
          target_frames: this.initialBufferFrames,
        });
      }
    }

    // Steady state. If nothing is queued, treat as an underflow:
    // re-enter buffering until the next burst fills the cushion.
    if (this.outboundQueue.length === 0) {
      this.outboundUnderflows += 1;
      this.outboundUnderflowFrames += 1;
      this.isInitialBuffering = true;
      // Surface every underflow inside the diagnostic early-call window
      // (first 5 s) so we can see whether the queue dries out during
      // the greeting and forces a re-buffer + audio glitch.
      if (this.diagEnabled && this._msSinceStart() < 5000) {
        this.log.warn('diag: outbound underflow during early-call window', {
          ms_since_start: this._msSinceStart(),
          packets_out_so_far: this.packetsOut,
          underflow_count: this.outboundUnderflows,
        });
      }
      if (this.onOutboundUnderflow) {
        try {
          this.onOutboundUnderflow();
        } catch (err) {
          this.log.warn('onOutboundUnderflow callback threw', {
            err: err.message,
          });
        }
      }
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

    if (this.diagEnabled && !this.firstOutboundSentLogged) {
      this.firstOutboundSentLogged = true;
      this.log.info('diag: first outbound rtp frame on the wire', {
        ms_since_start: this._msSinceStart(),
        payload_type: this.outboundPt,
        seq: pkt.readUInt16BE(2),
        ts: pkt.readUInt32BE(4),
        ssrc: this.ssrc,
      });
    }

    // Per-frame trace for the first N outbound packets — gives us a
    // millisecond timeline of the greeting playback so we can see if
    // any specific frame is missing or delayed. Logged at info level
    // (capped at N frames) so we don't need to bump the container's
    // LOG_LEVEL env var to capture the trace.
    if (this.diagEnabled && this.diagFramesLogged < this.diagFrameSampleCount) {
      this.diagFramesLogged += 1;
      this.log.info('diag: outbound frame', {
        ms_since_start: this._msSinceStart(),
        index: this.diagFramesLogged,
        seq: pkt.readUInt16BE(2),
        queue_depth_after: this.outboundQueue.length,
      });
    }

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
