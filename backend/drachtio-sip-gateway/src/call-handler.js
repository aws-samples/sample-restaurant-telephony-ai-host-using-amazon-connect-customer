'use strict';

const { RtpBridge, PCM_FRAME_SAMPLES } = require('./rtp-bridge');
const { AgentCoreWebSocketClient } = require('./agentcore-ws-client');
const cloudwatch = require('./cloudwatch-metrics');
const logger = require('./logger');

/**
 * Handle a single inbound INVITE.
 *
 * Design: this was previously a drachtio + rtpengine + Node bridge
 * three-way setup, but rtpengine's interface / direction / port-latching
 * / NAT-wait semantics produced multiple layers of media-path bugs that
 * were hard to reason about (SDP rewrites landing on the wrong side,
 * endpoint-learning overriding synthetic SDPs, loopback forwarders that
 * never emitted, etc).  The simpler solution is to cut rtpengine out
 * entirely and have the Node bridge speak RTP directly with the
 * Amazon Chime SDK Voice Connector (Chime VC):
 *
 *   INVITE arrives
 *     |
 *     v
 *   allocate an RTP port from the NLB-forwarded range (16000-16048)
 *     |
 *     v
 *   parse caller SDP to get Chime VC's (host, port) where we send RTP back
 *     |
 *     v
 *   bind dgram socket on 0.0.0.0:<rtpPort> (NLB routes inbound UDP
 *   from Chime VC via the per-port UDP target group to this ENI:port)
 *     |
 *     v
 *   build 200 OK SDP advertising <NLB_PUBLIC_IP>:<rtpPort> so Chime VC
 *   knows where to send its RTP
 *     |
 *     v
 *   open agentcore WS, start RTP <-> PCM <-> WS bridging
 *     |
 *     v
 *   bridge audio until BYE arrives or WS closes
 *     |
 *     v
 *   close WS, close RTP socket, release port
 *
 * Why this is simpler/better than rtpengine:
 *  - The RTP target-registrar Lambda already registers each task ENI
 *    as a target on every UDP port 16000-16048 when the task starts
 *    (see SipGatewayStack).  Traffic that Chime VC sends to the NLB on
 *    any of those UDP ports lands on this task's ENI at the same port.
 *  - We advertise the NLB public IP + the NLB-forwarded port in the
 *    SDP, so Chime VC's RTP is routable.
 *  - Return RTP from our Node socket goes out through the default
 *    route (NAT or direct depending on subnet), back to Chime VC's
 *    IP:port that the caller's SDP declared.  Chime VC does endpoint
 *    learning so asymmetric paths work.
 *  - No port latching, no dual-interface config, no NAT-wait deadlocks.
 */
async function handleInvite({ req, res, srf, portPool, agentConfig }) {
  const callId = req.get('Call-ID');
  const fromHeader = req.getParsedHeader('From');
  // Extract just the user portion of the From URI — the AgentCore-side
  // prompt renderer and pstn_customer.derive both expect a clean
  // `^\+[1-9]\d{1,14}$` E.164, not the full `sip:+1...@host:port` form.
  // Examples:
  //   "sip:+12125550100@10.0.175.204:5060" -> "+12125550100"
  //   "sip:anonymous@...:5060"             -> "anonymous"  (anonymous caller)
  //   "+12125550100"                       -> "+12125550100"  (already clean)
  const fromUri = fromHeader?.uri || '';
  const callerFrom =
    (fromUri.match(/^sip[s]?:([^@;]+)/i)?.[1]) || fromUri;
  // X-Session-Id is set by the SMA Lambda on CallAndBridge (Chime
  // forwards X-headers verbatim). Used as the AgentCore Runtime
  // microVM-stickiness key — wired into the wss:// URL and into the
  // StopRuntimeSession call on hangup. Null-safe: when the SMA Lambda
  // hasn't been deployed yet (step-2 transitional state) this is
  // undefined and the agent falls back to anonymous cold-start.
  const sessionId = req.get('X-Session-Id') || null;
  const log = logger.child({ call_id: callId });

  log.info('invite received', {
    caller_from: callerFrom,
    from_uri: fromUri,
    session_id: sessionId,
  });

  // ───── Parse Chime VC's offer SDP to get its RTP endpoint ─────
  const callerPeer = parseSdpMediaEndpoint(req.body);
  if (!callerPeer) {
    log.warn('could not parse caller SDP; rejecting');
    res.send(488); // Not Acceptable Here
    return;
  }
  log.info('caller rtp endpoint', callerPeer);

  // ───── Allocate an RTP port (NLB-forwarded range) ─────
  const rtpPort = portPool.allocate();
  if (rtpPort == null) {
    log.warn('port pool exhausted; rejecting with 486');
    res.send(486); // Busy Here
    return;
  }

  const publicIp = process.env.PUBLIC_IP;
  if (!publicIp) {
    log.error('PUBLIC_IP env var not set');
    portPool.release(rtpPort);
    res.send(500);
    return;
  }

  let uas = null;
  let bridge = null;
  let wsClient = null;
  let cleanedUp = false;
  let activeCountBumped = false;

  const cleanup = async (reason) => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info('cleaning up call', { reason });
    if (activeCountBumped) {
      cloudwatch.decrementActiveCalls();
      activeCountBumped = false;
    }
    // Free the AgentCore microVM slot. Best-effort — never throws.
    if (wsClient) {
      try {
        await wsClient.stopRuntimeSession();
      } catch (err) {
        log.warn('stopRuntimeSession threw', { err: err.message });
      }
    }
    try {
      if (wsClient) wsClient.close();
    } catch (err) {
      log.warn('ws close failed', { err: err.message });
    }
    try {
      if (bridge) bridge.stop();
    } catch (err) {
      log.warn('bridge stop failed', { err: err.message });
    }
    portPool.release(rtpPort);
  };

  try {
    // ───── Build the 200 OK SDP ─────
    // We advertise PCMU only (Chime VC always offers PCMU; keep things
    // simple).  `c=` is the NLB public IP so Chime VC can route to us via
    // the NLB; `m=audio <rtpPort>` is a port in the NLB-forwarded range
    // (16000-16048).  `a=sendrecv` and ptime=20 match Chime VC's offer.
    const localSdp = buildLocalSdp({
      host: publicIp,
      port: rtpPort,
      codec: 'PCMU',
    });

    // ───── Accept the call with 200 OK ─────
    uas = await srf.createUAS(req, res, { localSdp });
    log.info('uas created', { local_rtp_port: rtpPort, advertised_ip: publicIp });
    uas.on('destroy', () => {
      cleanup('uas destroyed').catch(() => {});
    });

    // ───── Start the RTP <-> PCM bridge ─────
    // Bind on 0.0.0.0 so packets arriving on the ENI (forwarded by the
    // NLB UDP target group) are received.  Pre-latch to the caller's
    // SDP-declared (host, port) so Nova Sonic's greeting audio starts
    // flowing before the caller sends the first RTP packet.
    bridge = new RtpBridge({
      localPort: rtpPort,
      bindAddress: '0.0.0.0',
      callId,
      onInboundPcm: (pcm16) => {
        if (wsClient) wsClient.sendAudio(pcm16);
      },
      initialRemoteHost: callerPeer.host,
      initialRemotePort: callerPeer.port,
      onOutboundDropQueueFull: () => cloudwatch.recordOutboundDropQueueFull(),
      onOutboundUnderflow: () => cloudwatch.recordOutboundUnderflow(),
    });
    await bridge.start();

    // ───── Open the AgentCore WebSocket ─────
    wsClient = new AgentCoreWebSocketClient({
      runtimeArn: agentConfig.runtimeArn,
      region: agentConfig.region,
      voiceId: agentConfig.voiceId,
      qualifier: agentConfig.qualifier,
      sessionId,
      log,
    });
    wsClient.on('audio', (pcm16) => {
      // Agent emits larger buffers (aggregated ~500 ms frames). Slice
      // into 20 ms frames before handing to the bridge so RTP packet
      // cadence stays sane. 20 ms @ 16 kHz = 320 samples per frame.
      const frameSamples = PCM_FRAME_SAMPLES * 2; // 160 @ 8k => 320 @ 16k
      for (let offset = 0; offset + frameSamples <= pcm16.length; offset += frameSamples) {
        bridge.writeOutboundPcm(pcm16.subarray(offset, offset + frameSamples));
      }
    });
    wsClient.on('bargeIn', () => {
      // Caller started talking; wipe anything queued so stale Nova
      // Sonic audio stops playing. Matches the pattern used in the
      // Nova Sonic browser reference player (AudioPlayerProcessor
      // worklet's `clearBuffer` message).
      bridge.clearOutbound();
    });
    wsClient.on('close', () => {
      cleanup('agentcore ws closed').catch(() => {});
      if (uas && !uas.destroyed) {
        uas.destroy();
      }
    });

    await wsClient.connect();
    cloudwatch.incrementActiveCalls();
    activeCountBumped = true;
    log.info('agentcore bridge up');
  } catch (err) {
    log.error('invite handling failed', { err: err.message, stack: err.stack });
    try {
      if (!res.finalResponseSent) res.send(500);
    } catch {
      /* already sent */
    }
    await cleanup('invite error');
  }
}

/**
 * Build the 200 OK answer SDP.  Advertises a single audio m-line with
 * PCMU (payload type 0) and `a=sendrecv`.  No ICE, no DTLS, no
 * rtcp-mux (plain RTP/AVP over UDP is what Chime VC uses).
 */
function buildLocalSdp({ host, port, codec = 'PCMU' }) {
  const pt = codec === 'PCMA' ? 8 : 0;
  const sessId = Math.floor(Date.now() / 1000);
  return (
    `v=0\r\n` +
    `o=drachtio-gateway ${sessId} ${sessId} IN IP4 ${host}\r\n` +
    `s=-\r\n` +
    `c=IN IP4 ${host}\r\n` +
    `t=0 0\r\n` +
    `m=audio ${port} RTP/AVP ${pt} 101\r\n` +
    `a=rtpmap:${pt} ${codec}/8000\r\n` +
    `a=rtpmap:101 telephone-event/8000\r\n` +
    `a=fmtp:101 0-15\r\n` +
    `a=sendrecv\r\n` +
    `a=ptime:20\r\n`
  );
}

/**
 * Parse a minimal media endpoint out of an SDP.  Returns {host, port}
 * from the first m=audio line's port plus the closest c= line (either
 * session-level or inside the same m= block).  Returns null on parse
 * failure.  We only consume IPv4 c= lines.
 */
function parseSdpMediaEndpoint(sdp) {
  if (!sdp || typeof sdp !== 'string') return null;
  const lines = sdp.split(/\r?\n/);
  let sessionHost = null;
  let mediaHost = null;
  let mediaPort = null;
  let inAudioMedia = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/);
      if (parts[0] === 'audio') {
        const port = parseInt(parts[1], 10);
        if (!Number.isNaN(port) && port > 0) {
          mediaPort = port;
          inAudioMedia = true;
          mediaHost = null;
        }
      } else {
        inAudioMedia = false;
      }
    } else if (line.startsWith('c=IN IP4 ')) {
      const host = line.slice('c=IN IP4 '.length).trim();
      if (inAudioMedia) {
        mediaHost = host;
      } else if (sessionHost == null) {
        sessionHost = host;
      }
    }
  }
  const host = mediaHost || sessionHost;
  if (!host || !mediaPort) return null;
  return { host, port: mediaPort };
}

module.exports = { handleInvite, buildLocalSdp, parseSdpMediaEndpoint };
