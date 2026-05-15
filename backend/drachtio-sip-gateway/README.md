# Drachtio SIP Gateway

Node.js SIP gateway that bridges inbound calls from the Amazon Chime SDK Voice
Connector (Chime VC) to the Amazon Bedrock AgentCore Runtime over a SigV4-signed
WebSocket. Deployed as a Fargate service in public subnets with auto-assigned
public IPs per task (r7).

## Architecture (r7)

Two processes run inside each Fargate task, supervised by the entrypoint's
`wait -n`:

1. **drachtio-server** — C++ Session Initiation Protocol (SIP) proxy built on
   the Sofia-SIP stack. Binds TCP/5060 and exposes a control socket on
   127.0.0.1:9022 so the Node.js app can receive SIP events (INVITE, BYE, etc.)
   and send SIP responses (100, 180, 200, ACK).
2. **node src/index.js** — the app. Talks to drachtio via drachtio-srf; for
   each accepted call it binds a UDP socket on `0.0.0.0:<rtpPort>` and speaks
   RTP directly with Chime VC. Audio is resampled (8 kHz μ-law ↔ 16 kHz L16
   PCM) and forwarded across a SigV4-signed WebSocket to Amazon Bedrock
   AgentCore Runtime.

Note: the `rtpengine` binary is still in the image but is not started by the
entrypoint. It is dead code kept for fast rollback only; remove in a future
cleanup pass.

For every inbound call the sequence is:

```
  Chime VC --INVITE-->  NLB --:5060/tcp-->  drachtio-server
                                            |
                                            +--admin socket--> node app
                                                                 |
                                                                 +-- allocate RTP port P in 16000-16048
                                                                 |
                                                                 +-- bind dgram(0.0.0.0:P) for RTP
                                                                 |
                                                                 +-- answer SDP advertises <task-public-ip>:P
                                                                 |
                                                                 +-- srf.createUAS(callerSdp)  (sends 200 OK back)
                                                                 |
                                                                 +-- open WebSocket to Amazon Bedrock AgentCore Runtime
                                                                      (SigV4-signed wss://...)
```

Under r7 the NLB handles TCP/5060 signaling only. The SDP `c=` line carries
the task's OWN auto-assigned public IP (resolved at startup via ECS metadata +
`ec2:DescribeNetworkInterfaces`), so Chime sends RTP directly to the task that
accepted the INVITE. No load balancer is in the media path.

Audio flows:

```
  caller RTP (8 kHz μ-law)
    -> Chime VC --UDP--> task-public-ip:P
    -> node dgram socket
    -> unpack RTP header
    -> μ-law decode to int16
    -> upsample 8 kHz -> 16 kHz
    -> send to AgentCore WebSocket

  AgentCore WebSocket (16 kHz int16 PCM)
    -> node
    -> downsample 16 kHz -> 8 kHz
    -> μ-law encode
    -> pack RTP header (seq++, ts+=160)
    -> node dgram socket.send(...) -> Chime VC -> caller
```

## Files

| Path                           | What                                                                  |
|--------------------------------|-----------------------------------------------------------------------|
| `Dockerfile`                   | Multi-stage build: drachtio + rtpengine from source, Node.js 22 LTS runtime. rtpengine binary is inert in r7; kept for rollback. |
| `drachtio.conf.xml`            | Admin port 9022 + SIP contact on 5060/tcp. Shared secret via env var. |
| `rtpengine.conf`               | Inert under r7; kept for rollback.                                    |
| `entrypoint.sh`                | Resolves the task's own ENI public IP, substitutes into configs, spawns drachtio + node under `wait -n`. |
| `package.json`                 | drachtio-srf, ws, alawmulaw, aws-sigv4.                               |
| `src/index.js`                 | drachtio connect + INVITE handler.                                    |
| `src/call-handler.js`          | Per-call state: SDP generation, UAS lifecycle, AgentCore WebSocket.   |
| `src/rtp-bridge.js`            | UDP socket <-> RTP codec <-> PCM frame pipe to the WS client.         |
| `src/agentcore-ws-client.js`   | SigV4-signed WebSocket connect to Amazon Bedrock AgentCore Runtime.   |
| `src/port-pool.js`             | RTP port allocator for 49 concurrent calls per task.                  |
| `src/logger.js`                | JSON-line stdout logger for CloudWatch Logs.                          |
| `src/cloudwatch-metrics.js`    | Periodic CloudWatch PutMetricData (active-call count).                |

## Local development

```bash
cd backend/drachtio-sip-gateway
npm install
docker buildx build --platform linux/arm64 -t local/drachtio-sip-gateway .
```

Unit tests: `npm test` (RTP header pack/unpack, μ-law codec, port pool).

## Security maintenance — Chime VC source CIDRs (R31)

The task security group's UDP 16000-16048 ingress is locked to the Chime SDK
Voice Connector source CIDR allowlist, pinned as `readonly` constants in
`telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts`. Under
r7 the task SG is the entire perimeter defense for RTP because tasks have
public IPs — any drift in the allowlist can cause silent call failures (new
Chime edge IP gets dropped) or, worse, open an attack surface (stale CIDR in
the list matches unintended sources).

Allowlist as of 2026-05 (us-east-1):

| Range | Purpose |
|---|---|
| `3.80.16.0/23` | Chime VC signaling (SIP INVITE origin IPs) |
| `52.55.62.128/25` | Chime VC media (RTP source) |
| `52.55.63.0/25` | Chime VC media (RTP source) |
| `34.212.95.128/25` | Chime VC media (RTP source) |
| `34.223.21.0/25` | Chime VC media (RTP source) |

### Source of truth

[Amazon Chime SDK Voice Connector IP address ranges](https://docs.aws.amazon.com/chime-sdk/latest/ag/network-config.html)

### Review cadence

**Quarterly**: open the AWS docs URL above, compare against the constants in
`sip-gateway-stack.ts`. If any CIDR has changed:

1. Update the constant declaration at the top of the stack file.
2. Verify the synth-time assertion test in `test/sip-gateway-stack.test.ts`
   still passes (`cd telephony-interface/telephony-sip-gateway/cdk && npm
   test`).
3. `cdk deploy SipGatewayStack`.
4. Run the programmatic SG audit script (`.deploy-tmp/sg-audit.sh`) against
   the live task SG to confirm the new rules match.
5. Commit.

### Long-term fix

When AWS publishes an AWS-managed prefix list for Chime SDK Voice Connector,
migrate the task SG UDP ingress to reference that prefix list ID instead of
hard-coded CIDRs. Prefix lists auto-update, eliminating the drift risk. Track
the Chime SDK team's announcement channel for this.

### Detection

If users report silent inbound calls:

1. Inspect the SIP gateway logs for `invite received` + `rtp bridge stopped`
   events with `packets_in=0`. If packets aren't arriving, SG is likely the
   culprit.
2. Run `.deploy-tmp/sg-audit.sh` to re-validate the allowlist.
3. Tail `/ecs/dev-sip-gateway` CloudWatch for `NLB health check` failures
   correlated with the problem window.

## Production hardening

For production deploys, flip the ECR repo's removal policy from DESTROY back
to RETAIN so rolling back a bad release doesn't nuke every shipped image. See
`telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts` (the
`imageRepo` construct).
