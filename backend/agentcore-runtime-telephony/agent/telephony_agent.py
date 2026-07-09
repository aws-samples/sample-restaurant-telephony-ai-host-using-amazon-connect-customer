"""Telephony Voice Ordering Agent — Bedrock AgentCore Runtime (r7.1).

WebSocket server that bridges the drachtio SIP gateway's Node.js Real-time
Transport Protocol bridge to Strands' BidiAgent + Nova 2 Sonic for
real-time voice ordering over the PSTN (Public Switched Telephone
Network).

## Protocol (Node.js bridge ↔ telephony_agent)

Inbound (bridge → agent):
  Frame 1 (text, required):
      UTF-8 JSON `{type:"auth", caller_from, call_id, deployment_prefix}`
      — sent by the bridge once the SIP INVITE is accepted, so the
      agent can derive the pseudonymous customer id and load the right
      system prompt before any audio arrives.
  Frames 2..N (binary):
      Raw L16 little-endian PCM, 16 kHz mono — one 20 ms chunk per
      frame produced by the bridge after upsampling caller audio from
      G.711 mu-law 8 kHz.

Outbound (agent → bridge):
  Text frame with JSON:
      {"type":"streamAudio","data":{"audioDataType":"raw","sampleRate":16000,"audioData":"<b64-L16>"}}
  The bridge base64-decodes the payload, paces it back to the caller
  in 20 ms RTP frames, and downsamples 16 kHz to 8 kHz mu-law on the
  way out. We buffer Nova Sonic's smaller (~20 ms) chunks into larger
  ~60 ms envelopes so the bridge has 3 RTP frames of work per envelope
  while the 20 ms RTP cadence remains driven by the bridge's own
  paced sender.

The JSON envelope shape is the same one [drachtio's mod_audio_stream
companion](https://github.com/drachtio/drachtio-freeswitch-modules)
uses (the project originally targeted that protocol in the r6 design
phase). r7 replaced the FreeSWITCH-based client with a hand-rolled
Node.js bridge co-located with drachtio-server in the same Fargate
task; the protocol shape was kept so the agent code did not have to
change.

## Architecture

- One FastAPI `/ws` WebSocket endpoint per live call.
- First text frame is parsed as auth metadata; `pstn_customer.derive`
  produces the pseudonymous `customer_id` (R8 / P3 / P4 / P11).
- `BidiAgent` is created with MCP tools pulled from the AgentCore
  Gateway (via `mcp_tools.for_customer`) + a per-call system prompt.
- Three concurrent coroutines bridge the WebSocket to the agent:
    - `_read_loop`  — receives WS frames, translates binary audio into
      `BidiAudioInputEvent`s and feeds them into the agent via
      `agent.send()`.
    - `_write_loop` — iterates `agent.receive()`, aggregates
      `BidiAudioStreamEvent`s into ~60 ms envelopes and sends them as
      `streamAudio` JSON text frames.
    - `_keepalive_loop` — sends a 20 ms silence frame every 20 s to
      keep Nova Sonic's bidi stream alive across long tool calls
      (R33).
- A small "Hi" `BidiTextInputEvent` is sent at startup so Nova Sonic
  speaks first (same trick as the reference qsr_agent.py).

## What's NOT here (by design)

- No Cognito / JWT auth — the WebSocket URL is SigV4-presigned by the
  drachtio SIP gateway task role (see sigv4.js in the bridge module).
  AgentCore Runtime validates the SigV4 before the connection reaches us.
- No `get_customer_location` tool — the telephony agent asks for ZIP or
  city name in conversation rather than pulling browser geolocation.
- No S3 playback fallback — if the WebSocket drops mid-call, the SIP
  gateway closes the SIP dialog and hangs up the caller.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiErrorEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
)
from strands.types._events import ToolUseStreamEvent  # noqa: E402
from strands.tools.mcp.mcp_client import MCPClient

import mcp_tools
import prompt_renderer
import pstn_customer
import system_prompt
from protocol import (
    BidiAudioAggregator,
    MODEL_CHANNELS,
    MODEL_INPUT_SAMPLE_RATE,
    MODEL_OUTPUT_SAMPLE_RATE,
    build_stream_audio_envelope,
)
from session import Session

# Silence third-party deprecation noise so call logs are readable.
warnings.filterwarnings("ignore", category=DeprecationWarning, module="websockets")
warnings.filterwarnings("ignore", category=DeprecationWarning, module="uvicorn")

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    force=True,
)
logger = logging.getLogger(__name__)

# Loud boot marker so we can confirm the container actually started
# and is reaching our code.  Uses print() rather than logger.info() to
# bypass any logging-subsystem misconfiguration; goes straight to
# stdout where uvicorn's awslogs driver will pick it up.
print("[telephony_agent] MODULE LOADED", flush=True)


# ───────────── MCP tool discovery ─────────────


def _discover_tools(customer_id: str) -> tuple[MCPClient, List[Any]]:
    """Open an MCPClient against AgentCore Gateway and return wrapped tools.

    Caller is responsible for context-managing the returned client. Tools
    have:
      (a) the basePath workaround applied (AgentCore Gateway OpenAPI bug
          — see mcp_tools.apply_basepath_workaround),
      (b) the customerId field STRIPPED from every input schema so the
          model cannot include it in a tool_use payload
          (see mcp_tools.strip_customer_id_from_schemas).

    customerId is then re-injected at invoke time by the hook returned
    from `mcp_tools.customer_id_hook(customer_id)` — the caller MUST
    register that hook on the BidiAgent or tool calls will land at the
    Lambda with no customerId at all.
    """
    factory = mcp_tools.for_customer(customer_id)
    client = MCPClient(factory)
    client.__enter__()  # keep it open across the call — closed in `finally`
    raw = client.list_tools_sync()
    # Print tool names so we can see exactly what Nova Sonic has available.
    # Uses print() to bypass logger-extras dropping (and shows up in awslogs).
    names = []
    for t in raw:
        mcp_tool = getattr(t, "mcp_tool", None)
        if mcp_tool is not None and hasattr(mcp_tool, "name"):
            names.append(mcp_tool.name)
    print(
        f"[telephony_agent] mcp tools discovered count={len(raw)} "
        f"names={names}",
        flush=True,
    )
    logger.info("mcp tools discovered", extra={"count": len(raw), "names": names})
    mcp_tools.apply_basepath_workaround(raw)
    tools = mcp_tools.strip_customer_id_from_schemas(raw)
    print(
        f"[telephony_agent] tools ready for BidiAgent count={len(tools)}",
        flush=True,
    )
    return client, tools


# ───────────── Warm-session cache (Option A pre-warm pattern) ─────────────
#
# When the SMA Lambda receives a NEW_INBOUND_CALL event from Chime, it
# fires a `POST /invocations` to the AgentCore Runtime with body
# `{"type":"warmup", ...customer fields...}` and a deterministic
# `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header. AgentCore
# Runtime allocates a microVM, binds the session ID to it ("microVM
# stickiness"), and routes our `/invocations` POST to the container.
# We use that 1-2 second window to do all the expensive work: prompt
# render, Nova Sonic stream open, MCP discovery, and BidiAgent.start().
#
# When the bridge later opens its `wss://...?X-Amzn-...-Session-Id=<id>`
# connection, AgentCore routes it to the SAME microVM. The /ws handler
# pulls the pre-built `WarmSession` out of `_warm_sessions[session_id]`
# and starts streaming audio immediately — no auth message, no cold
# start. Source: https://repost.aws/articles/ARCJIn3t7aRC2FxiRTV1SuCA
#
# Cache lifetime: per-microVM in-memory dict. Entries are popped on
# /ws connect (single-use). If the microVM is recycled (idle timeout,
# StopRuntimeSession from the bridge on hangup, or maxLifetime) the
# whole cache vanishes with it — the bridge's next call gets a fresh
# session ID via the SMA Lambda, so this is a non-issue.
@dataclass
class WarmSession:
    """Cached call context populated by the /invocations warmup path.

    Holds the live MCPClient and BidiAgent so the websocket handler
    can attach to them directly. The MCP client must be context-
    managed by the consumer (the websocket handler will close it in
    `finally`).
    """

    session: Session
    voice_id: str
    resolved_prompt: str
    mcp_client: MCPClient
    agent: BidiAgent
    # time.monotonic() at build completion. Used to expire stale warm
    # sessions whose Nova Sonic stream has idle-timed-out (see _WARM_TTL_S).
    created_at: float = 0.0


_warm_sessions: Dict[str, WarmSession] = {}

# Sessions whose warm build is currently running, keyed by session id.
# Lets the idempotent /invocations warmup (the SMA ring-and-poll loop)
# tell "still building" (202) apart from "not started yet" without ever
# kicking off a second concurrent build for the same session — a repeat
# build would open a second Nova Sonic stream and orphan the first.
_warm_building: Dict[str, "asyncio.Task[None]"] = {}

# A warm session primes Nova Sonic at build time, which starts the
# server-side ~55s idle timeout. If no /ws attaches within that window
# the bidi stream is torn down server-side and the cached "ready"
# session is a corpse — attaching to it yields a 532 "timed out waiting
# for audio" and the bridge drops the call. So we treat any warm session
# older than _WARM_TTL_S as stale: /invocations rebuilds it instead of
# reporting ready, and /ws rebuilds (preserving caller identity) rather
# than attaching. Kept safely under the 55s server limit.
_WARM_TTL_S = 40.0


def _warm_is_fresh(warm: "WarmSession") -> bool:
    """True while the warm session's Nova Sonic stream should still be alive."""
    return (time.monotonic() - warm.created_at) < _WARM_TTL_S


async def _close_warm_quietly(warm: "WarmSession") -> None:
    """Best-effort teardown of a discarded (stale) warm session.

    Mirrors the /ws finally cleanup (agent.stop -> mcp_client.__exit__) so
    a rebuilt-over stale session doesn't leak its MCP client / model stream.
    """
    try:
        await warm.agent.stop()
    except Exception:
        pass
    try:
        warm.mcp_client.__exit__(None, None, None)
    except Exception:
        pass


async def _build_call_context(session: Session, voice_id: str) -> WarmSession:
    """Run the expensive per-call setup once.

    Resolves the system prompt (via prompt-renderer Lambda or local
    fallback), builds the BidiNovaSonicModel + BidiAgent, opens the
    MCPClient, discovers tools, and starts the agent. Returns a
    WarmSession the caller can stash in `_warm_sessions` (warmup path)
    or attach to immediately (cold-fallback path).

    Caller owns the MCPClient and is responsible for closing it.
    """
    # Resolve the per-call system prompt. Concurrent with model + MCP
    # setup so the ~50-200 ms renderer call hides behind the heavier
    # tasks; fall back to the container-baked template on any
    # renderer failure.
    renderer_task = asyncio.create_task(
        prompt_renderer.fetch(session.raw_from, session.customer_id),
        name=f"renderer-{session.call_id or session.customer_id}",
    )

    # Strands AudioConfig accepts `input_rate` / `output_rate` keys,
    # NOT `input_sample_rate` / `output_sample_rate`. The wrong keys
    # are silently ignored by the SDK; the correct ones plus the
    # voice_id thread through to Nova Sonic.
    #
    # turn_detection.endpointingSensitivity is a Nova 2-only knob;
    # MEDIUM is the documented default for conversational use.
    model = BidiNovaSonicModel(
        model_id=os.environ.get("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        provider_config={
            "audio": {
                "input_rate": MODEL_INPUT_SAMPLE_RATE,
                "output_rate": MODEL_OUTPUT_SAMPLE_RATE,
                "channels": MODEL_CHANNELS,
                "voice": voice_id,
            },
            "turn_detection": {
                "endpointingSensitivity": "MEDIUM",
            },
        },
    )

    mcp_client, tools = _discover_tools(session.customer_id)

    try:
        rendered = await renderer_task
        resolved_prompt = rendered.system_prompt
        session.customer_name = rendered.customer_name
        session.is_loyalty = rendered.is_loyalty
        logger.info(
            "prompt resolved from renderer",
            extra={
                "call_id": session.call_id,
                "is_loyalty": rendered.is_loyalty,
                "has_name": rendered.customer_name is not None,
                "prompt_len": len(resolved_prompt),
            },
        )
    except Exception as exc:
        logger.warning(
            "prompt-renderer call failed; falling back to local template",
            extra={"call_id": session.call_id, "err": str(exc)},
        )
        resolved_prompt = system_prompt.build(session)

    agent = BidiAgent(
        model=model,
        tools=tools,
        system_prompt=resolved_prompt,
        hooks=[mcp_tools.customer_id_hook(session.customer_id)],
    )

    await agent.start()
    logger.info("bidi agent started", extra={"call_id": session.call_id})
    print(
        f"[telephony_agent] bidi agent started call_id={session.call_id}",
        flush=True,
    )

    # Prime Nova Sonic so the model is ready to speak the moment the
    # /ws connection arrives. agent.send(str) injects user text into
    # the live bidi session; Nova Sonic responds as if the user said
    # "Hi", which triggers the greeting from the system prompt.
    await agent.send("Hi")
    print(
        f"[telephony_agent] primed call_id={session.call_id}",
        flush=True,
    )

    return WarmSession(
        session=session,
        voice_id=voice_id,
        resolved_prompt=resolved_prompt,
        mcp_client=mcp_client,
        agent=agent,
        created_at=time.monotonic(),
    )


async def _warm_build_and_store(session_id: str, session: Session, voice_id: str) -> None:
    """Background task: build the call context and stash it warm.

    Runs the expensive `_build_call_context` OFF the request path so the
    warmup POST returns immediately (202) while the caller keeps ringing.
    Populates `_warm_sessions` on success; always clears the in-flight
    marker in `_warm_building` when done (success or failure) so a later
    poll can retry a failed build.
    """
    try:
        warm = await _build_call_context(session, voice_id)
        _warm_sessions[session_id] = warm
        logger.info(
            "warm session ready",
            extra={
                "session_id": session_id,
                "call_id": session.call_id,
                "warm_cache_size": len(_warm_sessions),
            },
        )
    except Exception:
        logger.exception(
            "warmup build failed",
            extra={"session_id": session_id, "call_id": session.call_id},
        )
    finally:
        _warm_building.pop(session_id, None)


# ───────────── FastAPI app ─────────────

app = FastAPI(title="Telephony Voice Ordering Agent (r6)")


@app.get("/ping")
async def ping() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "healthy"})


# Header that AgentCore Runtime uses to pin a request to a specific
# microVM ("microVM stickiness"). Source:
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html
SESSION_ID_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"

# AgentCore consumes the official session-id query param at its edge for
# microVM routing and does NOT forward it to the container as an HTTP
# header. To let the container see the session id, the bridge also
# passes it under the documented `X-Amzn-Bedrock-AgentCore-Runtime-
# Custom-*` prefix — AgentCore forwards anything with that prefix to
# the container as a lowercased HTTP header. Source:
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html#websocket-custom-headers
SESSION_ID_CUSTOM_HEADER_LOWER = "x-amzn-bedrock-agentcore-runtime-custom-session-id"


@app.post("/invocations")
async def invocations(request: Request) -> JSONResponse:
    """AgentCore Runtime InvokeAgentRuntime entrypoint.

    Today this handler only services the SMA Lambda's pre-warm call —
    body shape `{"type":"warmup", "raw_from":..., "anonymous":...,
    "from_last4":..., "call_id":...}`. The session ID arrives in the
    `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header and pins this
    request to a specific microVM. The expensive call setup (prompt
    render, Nova Sonic stream open, MCP tool discovery, BidiAgent.start,
    prime with "Hi") runs in a BACKGROUND task; this handler returns
    immediately so the SMA's ring-and-poll loop is never blocked. The
    result is stashed in `_warm_sessions[session_id]` so the bridge's
    later `/ws` connection on the same session ID attaches in O(ms).

    The handler is idempotent and doubles as the SMA's readiness probe:
    it returns 200 {"status":"ready"} once the warm session exists, and
    202 {"status":"warming"} while the background build is still running
    (or has just been started). It never launches a second build for a
    session id that is already warm or in flight.

    Future: any non-warmup invocation type returns 400. We deliberately
    do not implement a generic POST agent here — the WebSocket is the
    only data plane this agent supports.
    """
    session_id = request.headers.get(SESSION_ID_HEADER)
    if not session_id:
        return JSONResponse(
            {"error": f"missing {SESSION_ID_HEADER} header"}, status_code=400
        )

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse({"error": "request body is not valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "request body must be a JSON object"}, status_code=400)
    if body.get("type") != "warmup":
        return JSONResponse(
            {"error": "only type=warmup is supported on /invocations"},
            status_code=400,
        )

    raw_from = str(body.get("raw_from") or "")
    anonymous = bool(body.get("anonymous", True))
    from_last4 = str(body.get("from_last4") or "")
    call_id = str(body.get("call_id") or "")
    voice_id = str(body.get("voice_id") or "tiffany")

    # Re-derive customer_id locally so the agent never has to trust a
    # value it didn't compute itself. The SMA Lambda uses the same
    # pepper + same algorithm, so the result is deterministic across
    # both processes.
    try:
        customer_id, derived_anonymous, derived_last4 = (
            pstn_customer.derive_for_session(raw_from)
        )
    except Exception as exc:
        logger.warning(
            "pstn_customer.derive_for_session failed in /invocations; using empty pepper",
            extra={"err": str(exc), "session_id_present": bool(session_id)},
        )
        customer_id, derived_anonymous, derived_last4 = pstn_customer.derive(
            raw_from, b""
        )

    # Trust the locally-derived values over the SMA-supplied ones in
    # case of any drift. SMA values are useful as cross-checks only.
    session = Session(
        call_id=call_id,
        raw_from=raw_from,
        from_last4=derived_last4 or from_last4,
        anonymous=derived_anonymous if raw_from else anonymous,
        customer_id=customer_id,
    )

    logger.info(
        "warmup received",
        extra={
            "call_id": call_id,
            "from_last4": session.from_last4,
            "anonymous": session.anonymous,
            "customer_id": session.customer_id,
            "session_id": session_id,
        },
    )

    # Idempotent, non-blocking warmup for the SMA ring-and-poll loop.
    # The SMA polls this endpoint repeatedly while the caller rings, so we
    # must (a) never build the same session twice and (b) return fast with
    # a readiness signal instead of blocking for the whole cold build.
    # Contract the SMA relies on:
    #   200 {"status":"ready"}   -> warm session built; SMA issues CallAndBridge.
    #   202 {"status":"warming"} -> build in flight; SMA keeps the caller ringing.
    cached = _warm_sessions.get(session_id)
    if cached is not None:
        if _warm_is_fresh(cached):
            return JSONResponse({"status": "ready", "call_id": call_id})
        # Stale — the Nova Sonic stream has (or is about to) idle-time-out
        # with no /ws attached. Discard it and rebuild below so we never
        # report a dead session as ready.
        _warm_sessions.pop(session_id, None)
        logger.info(
            "discarding stale warm session",
            extra={"session_id": session_id, "call_id": call_id},
        )
        asyncio.create_task(
            _close_warm_quietly(cached),
            name=f"close-stale-{call_id or session_id[:12]}",
        )

    existing = _warm_building.get(session_id)
    if existing is not None and not existing.done():
        return JSONResponse({"status": "warming", "call_id": call_id}, status_code=202)

    # Nothing in flight (never started, or a previous build finished/failed
    # without populating the cache) -> kick off a fresh background build and
    # return immediately so the caller keeps ringing.
    task = asyncio.create_task(
        _warm_build_and_store(session_id, session, voice_id),
        name=f"warmbuild-{call_id or session.customer_id}",
    )
    _warm_building[session_id] = task
    return JSONResponse({"status": "warming", "call_id": call_id}, status_code=202)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """One WebSocket = one voice call.

    Flow:
      1. Accept WS; read `X-Amzn-...-Session-Id` from query params.
      2. Look up `_warm_sessions[session_id]` for the pre-built call
         context populated by the SMA Lambda's POST /invocations
         warmup. Cache hit = O(ms) attach. Cache miss = anonymous
         cold-start (calls still work, just no loyalty).
      3. Run `_read_loop` + `_paced_writer` + `_keepalive` concurrently
         until the WebSocket closes or Nova Sonic errors.

    The legacy `auth` text-frame protocol is gone — the session ID is
    the only identity carrier. The bridge can no longer send arbitrary
    JSON on the wire; only binary PCM frames in, and the agent's
    `streamAudio` envelopes out.
    """
    print("[telephony_agent] /ws endpoint hit", flush=True)
    await websocket.accept()
    print("[telephony_agent] websocket accepted", flush=True)
    logger.info("websocket accepted", extra={"client": str(websocket.client)})

    voice_id = websocket.query_params.get("voice_id", "tiffany")
    # Read the session id from the custom-header pass-through that
    # AgentCore Runtime forwards from the URL query string. Falls back
    # to the official query-param name (and HTTP header) for local-
    # dev / non-AgentCore paths where the custom-header rewrite is not
    # in effect.
    session_id = (
        websocket.headers.get(SESSION_ID_CUSTOM_HEADER_LOWER)
        or websocket.headers.get(SESSION_ID_HEADER)
        or websocket.query_params.get(SESSION_ID_HEADER)
    )
    print(
        f"[telephony_agent] /ws session_id={session_id!r} voice_id={voice_id!r}",
        flush=True,
    )

    mcp_client: Optional[MCPClient] = None
    agent: Optional[BidiAgent] = None
    session: Optional[Session] = None
    warm: Optional[WarmSession] = None

    try:
        # ───── Pre-warm cache lookup ─────
        if session_id:
            warm = _warm_sessions.pop(session_id, None)
            if warm is not None and not _warm_is_fresh(warm):
                # Popped a STALE warm session — its Nova Sonic stream has
                # idle-timed-out (built long ago, no /ws until now). Attaching
                # would 532 and drop the call. Rebuild fresh, PRESERVING the
                # caller identity + voice so we don't demote a loyalty caller
                # to anonymous.
                logger.warning(
                    "ws popped stale warm session; rebuilding fresh",
                    extra={
                        "session_id": session_id,
                        "call_id": warm.session.call_id,
                        "customer_id": warm.session.customer_id,
                    },
                )
                stale_session = warm.session
                stale_voice = warm.voice_id
                await _close_warm_quietly(warm)
                warm = await _build_call_context(stale_session, stale_voice)
                session = warm.session
                agent = warm.agent
                mcp_client = warm.mcp_client
            elif warm is not None:
                logger.info(
                    "ws attached to warm session",
                    extra={
                        "session_id": session_id,
                        "call_id": warm.session.call_id,
                        "customer_id": warm.session.customer_id,
                        "warm_cache_size": len(_warm_sessions),
                    },
                )
                print(
                    f"[telephony_agent] ws warm-hit call_id={warm.session.call_id}",
                    flush=True,
                )
                session = warm.session
                agent = warm.agent
                mcp_client = warm.mcp_client
            else:
                logger.warning(
                    "ws session_id miss; falling back to anonymous cold-start",
                    extra={"session_id": session_id},
                )

        # ───── Cold-start fallback ─────
        if warm is None:
            # Either the bridge didn't pass a session_id (pre-step-3
            # deploy state), or the warmup never happened, or the
            # microVM was recycled between warmup and /ws connect.
            # Build an anonymous session so the call still works.
            try:
                customer_id, anonymous, from_last4 = (
                    pstn_customer.derive_for_session("")
                )
            except Exception:
                customer_id, anonymous, from_last4 = pstn_customer.derive("", b"")
            session = Session(
                call_id="",
                raw_from="",
                from_last4=from_last4,
                anonymous=anonymous,
                customer_id=customer_id,
            )
            print(
                f"[telephony_agent] ws cold-fallback customer_id={session.customer_id}",
                flush=True,
            )
            warm = await _build_call_context(session, voice_id)
            agent = warm.agent
            mcp_client = warm.mcp_client

        # Note: `_build_call_context` already called `agent.start()` and
        # primed Nova Sonic with "Hi" so the model is ready to greet
        # the caller the moment audio frames start arriving. No second
        # prime needed here.

        # Two concurrent loops:
        #   - _read_loop: pulls PCM binary frames off the WS, forwards
        #     to the agent as audio input via agent.send(audio_bytes).
        #   - _write_loop: iterates agent.receive(), batches outgoing
        #     audio into 500 ms envelopes, sends each as a streamAudio
        #     JSON text frame.
        #   - _keepalive_loop: sends one 20 ms silence frame every 20 s
        #     to keep Nova Sonic's bidi stream alive. Nova Sonic closes
        #     the stream server-side with error 532 ("Timed out waiting
        #     for audio bytes or interactive content") if no audio or
        #     interactive content arrives for >55 s. That happens
        #     during long tool calls or mid-conversation pauses when
        #     Chime is not sending us RTP (either caller is muted or
        #     Chime is suppressing silence despite our a=silenceSupp:off
        #     offer). This keepalive guarantees the server sees at least
        #     one input frame in every 55 s window.
        aggregator = BidiAudioAggregator()

        # 20 ms @ 16 kHz mono L16 = 320 samples = 640 bytes of zeros.
        # Nova Sonic treats zeroed PCM as silence, indistinguishable from
        # a caller who is not speaking.
        _silence_frame_b64 = base64.b64encode(b"\x00" * 640).decode("ascii")

        async def _read_loop_inline():
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("type") == "websocket.disconnect":
                        print(
                            f"[telephony_agent] read loop disconnect call_id={session.call_id}",
                            flush=True,
                        )
                        return
                    if "bytes" in msg and msg["bytes"] is not None:
                        audio_bytes = msg["bytes"]
                        if not audio_bytes:
                            continue
                        # Strands' agent.send() rejects raw bytes — it
                        # requires a BidiAudioInputEvent (or a str / dict).
                        # The caller sends us little-endian L16 PCM at 16kHz
                        # mono; wrap as the documented input event and
                        # feed it through.
                        await agent.send(
                            BidiAudioInputEvent(
                                audio=base64.b64encode(audio_bytes).decode("ascii"),
                                format="pcm",
                                sample_rate=MODEL_INPUT_SAMPLE_RATE,
                                channels=MODEL_CHANNELS,
                            )
                        )
                    elif "text" in msg and msg["text"] is not None:
                        logger.debug(
                            "unexpected text frame",
                            extra={"len": len(msg["text"])},
                        )
            except WebSocketDisconnect:
                raise

        # Outbound audio queue + interrupt flag for the paced writer
        # task. The dispatcher (`_write_loop_inline`) NEVER blocks on
        # send pacing — it pushes envelopes onto this queue and moves
        # on to the next agent event. The paced writer task
        # (`_paced_writer_inline`) drains the queue, applies the 1x
        # realtime sleep, then writes to the WebSocket.
        #
        # Why decouple: a previous version of this loop called
        # `_send_audio_paced` directly from the dispatcher. Each
        # `await asyncio.sleep(60ms)` pinned the dispatcher for one
        # frame, so a 1.8 s burst from Nova Sonic took 1.8 s of
        # serialised dispatcher time before the next event could
        # surface. `BidiInterruptionEvent` (the barge-in signal) sat
        # behind the audio chunks in the dispatcher's read queue and
        # only fired AFTER the burst drained — meaning the agent did
        # not react to the caller talking until ~2 s after they
        # started. Phones experienced as "agent ignores barge-in".
        #
        # The fix: dispatcher pushes onto an `asyncio.Queue`,
        # interrupts toggle a flag the writer checks before each send.
        # The writer is the only place that sleeps; the dispatcher
        # stays responsive.
        outbound_queue: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue()
        # `interrupt_seq` increments every time the dispatcher fires
        # a barge-in. Writer captures the current value when it pops
        # an envelope and checks again before sending — if changed,
        # it drops the envelope. Using a counter (not a bool) avoids
        # races where two interrupts arrive while the writer is mid-send.
        interrupt_seq = 0
        # Sentinel pushed onto the queue to signal "shutdown gracefully".
        WRITER_STOP = b""

        async def _write_loop_inline():
            nonlocal aggregator, interrupt_seq
            event_count = 0
            try:
                async for event in agent.receive():
                    event_count += 1
                    if event_count <= 5 or event_count % 50 == 0:
                        print(
                            f"[telephony_agent] event#{event_count} type={type(event).__name__} "
                            f"call_id={session.call_id}",
                            flush=True,
                        )
                    if isinstance(event, BidiAudioStreamEvent):
                        pcm = aggregator.feed(event.audio)
                        if pcm is not None:
                            outbound_queue.put_nowait(pcm)
                    elif isinstance(event, (BidiResponseCompleteEvent, BidiInterruptionEvent)):
                        pcm = aggregator.flush()
                        if pcm is not None:
                            outbound_queue.put_nowait(pcm)
                        if isinstance(event, BidiInterruptionEvent):
                            # Bump the interrupt counter so any
                            # in-flight or queued audio is dropped by
                            # the writer. Then drain whatever is
                            # already buffered in the queue
                            # synchronously (cheap — no awaits) so
                            # the writer doesn't waste a paced sleep
                            # on an envelope it would discard anyway.
                            interrupt_seq += 1
                            drained = 0
                            while not outbound_queue.empty():
                                try:
                                    outbound_queue.get_nowait()
                                    outbound_queue.task_done()
                                    drained += 1
                                except asyncio.QueueEmpty:
                                    break
                            # Tell the bridge to wipe ITS queue too.
                            try:
                                await websocket.send_json({"type": "bargeIn"})
                            except Exception:
                                pass
                            logger.info(
                                "agent interrupted",
                                extra={
                                    "call_id": session.call_id,
                                    "reason": event.reason,
                                    "drained_envelopes": drained,
                                },
                            )
                    elif isinstance(event, BidiTranscriptStreamEvent):
                        if event.is_final:
                            role = event.role
                            text = event.text
                            # Print transcripts so we can see the conversation
                            # in the CloudWatch log (logger extras don't render).
                            print(
                                f"[telephony_agent] transcript role={role} "
                                f"call_id={session.call_id} text={text[:200]!r}",
                                flush=True,
                            )
                            logger.info(
                                "transcript",
                                extra={
                                    "call_id": session.call_id,
                                    "role": role,
                                    "text": text,
                                },
                            )
                    elif isinstance(event, ToolUseStreamEvent):
                        # Diagnostic: Nova Sonic requested a tool. Log the
                        # tool name + arguments so we can confirm the model
                        # is actually attempting tool calls (and what args
                        # it is passing). Previously we silently dropped
                        # these events; seeing zero of them in the log was
                        # the clue that tools were not reaching the model.
                        tu = event.get("current_tool_use", {}) or {}
                        print(
                            f"[telephony_agent] tool_use name={tu.get('name')!r} "
                            f"id={tu.get('toolUseId')!r} input={tu.get('input')!r} "
                            f"call_id={session.call_id}",
                            flush=True,
                        )
                    elif isinstance(event, BidiErrorEvent):
                        logger.error(
                            "agent error event",
                            extra={
                                "call_id": session.call_id,
                                "code": event.code,
                                "message": event.message,
                            },
                        )
                    elif isinstance(event, BidiConnectionCloseEvent):
                        logger.info(
                            "agent connection closed",
                            extra={"call_id": session.call_id, "reason": event.reason},
                        )
                        return
            finally:
                # Signal the writer to drain and exit.
                outbound_queue.put_nowait(WRITER_STOP)

        async def _paced_writer_inline():
            """Drain `outbound_queue` and write each envelope to the
            WebSocket at 1x realtime, with idle-gap re-anchoring.

            This is the ONLY coroutine that calls `await asyncio.sleep`
            for pacing — the dispatcher stays unblocked so it can react
            to interrupts within microseconds.

            Pacer behaviour:
              - Re-anchor on every idle gap > IDLE_REANCHOR_GAP_S so
                tool gaps, response gaps, and turn gaps don't burst.
              - Re-anchor on every interrupt so the next utterance
                starts at "now" with no debt.
              - Drop any envelope older than the current `interrupt_seq`
                snapshot taken at dequeue.

            Toggle: env var OUTPUT_PACER_ENABLED=false sends each
            envelope as soon as it's dequeued (no pacing — emergency
            rollback path).
            """
            nonlocal interrupt_seq
            pacer_enabled = (
                os.getenv("OUTPUT_PACER_ENABLED", "true").lower() != "false"
            )
            pacer_anchor: Optional[float] = None
            pacer_audio_seconds: float = 0.0
            pacer_last_send_at: Optional[float] = None
            # Re-anchor if more than this much wall time elapsed
            # without a send. 0.5 s is well above the 60 ms aggregator
            # cadence (so consecutive envelopes inside a single
            # utterance never trigger) but well below typical tool
            # round-trips (1-30 s).
            IDLE_REANCHOR_GAP_S = 0.5
            # 16 kHz mono * 2 bytes = 32 000 B/s of L16.
            bytes_per_second = (
                MODEL_OUTPUT_SAMPLE_RATE * MODEL_CHANNELS * 2
            )
            envelopes_skipped_due_to_interrupt = 0

            try:
                while True:
                    pcm = await outbound_queue.get()
                    try:
                        # Sentinel — graceful shutdown.
                        if pcm is WRITER_STOP:
                            return
                        # Snapshot the interrupt seq AT DEQUEUE.
                        # If the dispatcher fires barge-in after we
                        # popped but before we send, the seq differs
                        # and we drop. The dispatcher also drains the
                        # queue synchronously on barge-in so most
                        # envelopes never reach this point.
                        seq_at_dequeue = interrupt_seq
                        envelope = build_stream_audio_envelope(pcm)
                        envelope_seconds = len(pcm) / bytes_per_second
                        loop = asyncio.get_running_loop()
                        now = loop.time()
                        # Re-anchor on idle gap or fresh-after-interrupt.
                        # `pacer_last_send_at` is None right after a
                        # _reset_pacer, which we trigger on init AND
                        # on interrupt-skip below.
                        if not pacer_enabled:
                            await websocket.send_json(envelope)
                            pacer_last_send_at = loop.time()
                            continue
                        if (
                            pacer_anchor is None
                            or pacer_last_send_at is None
                            or (now - pacer_last_send_at) > IDLE_REANCHOR_GAP_S
                        ):
                            if pacer_anchor is not None:
                                gap_s = now - (pacer_last_send_at or now)
                                logger.info(
                                    "pacer re-anchored on idle gap",
                                    extra={
                                        "call_id": session.call_id,
                                        "gap_seconds": round(gap_s, 3),
                                    },
                                )
                            pacer_anchor = now
                            pacer_audio_seconds = 0.0
                            delay = 0.0
                        else:
                            target = pacer_anchor + pacer_audio_seconds
                            delay = max(0.0, target - now)
                        if delay > 0:
                            # 1 s cap as a safety belt; also wakes
                            # frequently enough that an interrupt
                            # arriving mid-sleep is honoured by the
                            # next iteration's seq check.
                            await asyncio.sleep(min(delay, 1.0))
                        # CRITICAL: after the (possibly long) sleep,
                        # re-check the interrupt seq. If barge-in
                        # arrived while we slept, drop this envelope.
                        if interrupt_seq != seq_at_dequeue:
                            envelopes_skipped_due_to_interrupt += 1
                            # Reset pacer state so the next envelope
                            # re-anchors on a clean slate.
                            pacer_anchor = None
                            pacer_audio_seconds = 0.0
                            pacer_last_send_at = None
                            continue
                        pacer_audio_seconds += envelope_seconds
                        pacer_last_send_at = loop.time()
                        await websocket.send_json(envelope)
                    finally:
                        outbound_queue.task_done()
            except WebSocketDisconnect:
                raise
            except Exception:
                logger.exception(
                    "paced writer error",
                    extra={
                        "call_id": session.call_id,
                        "envelopes_skipped_due_to_interrupt":
                            envelopes_skipped_due_to_interrupt,
                    },
                )
                raise

        read_task = asyncio.create_task(_read_loop_inline(), name=f"read-{session.call_id}")
        write_task = asyncio.create_task(_write_loop_inline(), name=f"write-{session.call_id}")
        paced_writer_task = asyncio.create_task(
            _paced_writer_inline(), name=f"paced-writer-{session.call_id}"
        )

        async def _keepalive_loop_inline():
            """Send one silence frame every 20 s to avoid Nova Sonic's
            55 s server-side idle timeout (error 532). Runs until
            cancelled by the asyncio.wait below.
            """
            # 20 s interval gives us a 2.75x safety margin under the 55 s
            # server limit, so a tool call that takes up to ~35 s of the
            # interval still leaves room for one keepalive frame to land.
            interval_s = 20.0
            while True:
                try:
                    await asyncio.sleep(interval_s)
                    await agent.send(
                        BidiAudioInputEvent(
                            audio=_silence_frame_b64,
                            format="pcm",
                            sample_rate=MODEL_INPUT_SAMPLE_RATE,
                            channels=MODEL_CHANNELS,
                        )
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # Transient errors (agent temporarily unable to
                    # receive) are not fatal — we'll try again on the
                    # next tick. If the agent is permanently dead, the
                    # read or write loop will exit and cancel us.
                    logger.debug(
                        "keepalive send failed",
                        extra={"call_id": session.call_id, "err": str(exc)},
                    )

        keepalive_task = asyncio.create_task(
            _keepalive_loop_inline(), name=f"keepalive-{session.call_id}"
        )

        done, pending = await asyncio.wait(
            {read_task, write_task, paced_writer_task, keepalive_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, (asyncio.CancelledError, WebSocketDisconnect)):
                logger.error(
                    "io loop raised",
                    extra={"task": t.get_name(), "err": str(exc)},
                    exc_info=exc,
                )
        await asyncio.gather(*pending, return_exceptions=True)

    except WebSocketDisconnect:
        logger.info("websocket disconnected")
    except Exception as exc:
        logger.exception("websocket handler error", extra={"err": str(exc)})
    finally:
        # Best-effort teardown order: agent → mcp_client → websocket.
        if agent is not None:
            try:
                await agent.stop()
            except Exception:
                logger.exception("agent.stop failed")
        if mcp_client is not None:
            try:
                mcp_client.__exit__(None, None, None)
            except Exception:
                logger.exception("mcp_client.__exit__ failed")
        try:
            # starlette's WebSocketState enum: CONNECTING=0, CONNECTED=1, DISCONNECTED=2.
            # Both application_state AND client_state must be non-DISCONNECTED
            # before we try close() — otherwise ASGI raises
            # "Unexpected ASGI message 'websocket.close', after sending
            # 'websocket.close' or response already completed."
            cs = getattr(websocket, "client_state", None)
            aps = getattr(websocket, "application_state", None)
            cs_val = getattr(cs, "value", None)
            aps_val = getattr(aps, "value", None)
            if cs_val != 2 and aps_val != 2:
                await websocket.close()
        except RuntimeError:
            # ASGI already completed / double-close — benign.
            pass
        except Exception:
            logger.debug("websocket.close in finally raised", exc_info=True)
        logger.info("call teardown complete")


# ───────────── I/O loops ─────────────


async def _read_loop(
    websocket: WebSocket, agent: BidiAgent, session: Session
) -> None:
    """Pump WebSocket frames into the agent.

    - Binary frames = raw L16 16 kHz mono audio → BidiAudioInputEvent.
    - Text frames = diagnostic only (the bridge does not send in-session
      text frames; we log and ignore).
    """
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                print(f"[telephony_agent] read loop disconnect call_id={session.call_id}", flush=True)
                return
            if "bytes" in msg and msg["bytes"] is not None:
                audio_bytes: bytes = msg["bytes"]
                if not audio_bytes:
                    continue
                await agent.send(
                    BidiAudioInputEvent(
                        audio=base64.b64encode(audio_bytes).decode("ascii"),
                        format="pcm",
                        sample_rate=MODEL_INPUT_SAMPLE_RATE,
                        channels=MODEL_CHANNELS,
                    )
                )
            elif "text" in msg and msg["text"] is not None:
                # The bridge does not send in-session text frames; the
                # protocol reserves the text channel for the initial
                # auth metadata and (in the upstream mod_audio_stream
                # protocol) for an explicit `send_text` API. Log and
                # ignore anything we receive here.
                logger.debug(
                    "unexpected text frame", extra={"len": len(msg["text"])}
                )
    except WebSocketDisconnect:
        raise
    except Exception:
        logger.exception("read loop error", extra={"call_id": session.call_id})
        raise


async def _write_loop(
    websocket: WebSocket, agent: BidiAgent, session: Session
) -> None:
    """DEPRECATED — DEAD CODE. The live write path is `_write_loop_inline`
    inside `websocket_endpoint`. This module-level function is kept
    only for the unit-test harness and SHOULD be removed in a follow-up
    cleanup; do not edit it expecting changes to take effect on a real
    call. Apply changes to `_write_loop_inline` (search for that name).

    Pump agent events into the WebSocket.

    Aggregates `BidiAudioStreamEvent`s into ~OUTPUT_FRAME_BUFFER_MS
    envelopes before sending (see `BidiAudioAggregator` rationale).

    Producer-side 1x realtime pacer
    -------------------------------
    Nova Sonic decodes audio faster than realtime — a 30 s response can
    arrive in a few hundred ms of wall clock. Without pacing, this
    write loop hands the entire response to the bridge in one burst,
    overflowing the bridge's outbound RTP queue and causing silent
    audio drops on the caller side (root cause for May 2026 choppiness
    reports: `dropped_queue_full=1822` on a 3-min call, ≈25%).

    The pacer enforces no-faster-than-realtime emission per envelope:

      target_send_time = pacer_anchor + cumulative_audio_ms_so_far
      sleep until max(now, target_send_time)

    Each envelope is `OUTPUT_FRAME_BUFFER_MS` (60 ms by default) of
    audio, so on a paced send we sleep ≈60 ms between envelopes once
    we've caught up. The anchor is reset on every utterance boundary
    (BidiResponseCompleteEvent / BidiInterruptionEvent) so an idle
    period doesn't compound — the next utterance starts at "now",
    not at "now + accumulated debt".

    Reference: matches the pacing pattern in the AgentCore WebRTC
    sample (`OutputTrack.recv()` in
    awslabs/agentcore-samples/06-bi-directional-streaming-webrtc).

    Toggle: set env var `OUTPUT_PACER_ENABLED=false` to bypass the
    pacer (emergency rollback). Defaults to enabled in production.

    Transcripts + interruptions are logged for observability but NOT
    forwarded to the bridge — the bridge only understands the
    `streamAudio` JSON envelope on its receive path.
    """
    aggregator = BidiAudioAggregator()
    print(f"[telephony_agent] write loop start call_id={session.call_id}", flush=True)
    event_count = 0

    pacer_enabled = os.getenv("OUTPUT_PACER_ENABLED", "true").lower() != "false"
    # Loop monotonic anchor (seconds). Set to None whenever no
    # utterance is in flight; (re)initialised on the first audio
    # envelope of a new utterance.
    pacer_anchor: Optional[float] = None
    pacer_audio_seconds: float = 0.0
    # Bytes per second of L16 audio at the model's output rate. 16 kHz
    # mono * 2 bytes = 32_000 B/s. Pre-computed so the per-envelope
    # path only does a divide.
    bytes_per_second = MODEL_OUTPUT_SAMPLE_RATE * MODEL_CHANNELS * 2

    async def _send_audio_paced(pcm: bytes) -> None:
        nonlocal pacer_anchor, pacer_audio_seconds
        envelope = build_stream_audio_envelope(pcm)
        if not pacer_enabled:
            await websocket.send_json(envelope)
            return

        envelope_seconds = len(pcm) / bytes_per_second
        loop = asyncio.get_running_loop()
        now = loop.time()
        if pacer_anchor is None:
            # First envelope of an utterance — anchor on now and emit
            # immediately. The next envelope will be paced relative to
            # this anchor.
            pacer_anchor = now
            pacer_audio_seconds = 0.0
        else:
            target = pacer_anchor + pacer_audio_seconds
            delay = target - now
            if delay > 0:
                # Cap any single sleep at 1 s as a safety belt — if the
                # math ever overshoots (clock skew, very long utterance
                # in steady state), we still keep the loop responsive
                # enough to react to BidiInterruptionEvent.
                await asyncio.sleep(min(delay, 1.0))
        pacer_audio_seconds += envelope_seconds
        await websocket.send_json(envelope)

    def _reset_pacer() -> None:
        nonlocal pacer_anchor, pacer_audio_seconds
        pacer_anchor = None
        pacer_audio_seconds = 0.0

    try:
        async for event in agent.receive():
            event_count += 1
            if event_count <= 5 or event_count % 20 == 0:
                print(
                    f"[telephony_agent] write loop event#{event_count} "
                    f"type={type(event).__name__} call_id={session.call_id}",
                    flush=True,
                )
            if isinstance(event, BidiAudioStreamEvent):
                pcm = aggregator.feed(event.audio)
                if pcm is not None:
                    await _send_audio_paced(pcm)
            elif isinstance(event, (BidiResponseCompleteEvent, BidiInterruptionEvent)):
                # Flush any partial audio buffer so the caller hears the
                # tail of the last utterance immediately.
                pcm = aggregator.flush()
                if pcm is not None:
                    await _send_audio_paced(pcm)
                # Utterance boundary — reset the pacer so the next
                # utterance starts at "now", not at "now + idle debt".
                _reset_pacer()
                if isinstance(event, BidiInterruptionEvent):
                    # Tell the Node bridge to wipe its outbound queue so
                    # stale audio stops immediately.
                    try:
                        await websocket.send_json({"type": "bargeIn"})
                    except Exception:
                        pass
                    logger.info(
                        "agent interrupted",
                        extra={"call_id": session.call_id, "reason": event.reason},
                    )
                else:
                    logger.info(
                        "agent response complete",
                        extra={
                            "call_id": session.call_id,
                            "stop_reason": event.stop_reason,
                            "response_id": event.response_id,
                        },
                    )
            elif isinstance(event, BidiTranscriptStreamEvent):
                if event.is_final:
                    logger.info(
                        "transcript",
                        extra={
                            "call_id": session.call_id,
                            "role": event.role,
                            "text": event.text,
                        },
                    )
            elif isinstance(event, BidiErrorEvent):
                logger.error(
                    "agent error event",
                    extra={
                        "call_id": session.call_id,
                        "code": event.code,
                        "message": event.message,
                    },
                )
            elif isinstance(event, BidiConnectionCloseEvent):
                logger.info(
                    "agent connection closed",
                    extra={"call_id": session.call_id, "reason": event.reason},
                )
                return
    except WebSocketDisconnect:
        raise
    except Exception:
        logger.exception("write loop error", extra={"call_id": session.call_id})
        raise


# ───────────── entrypoint ─────────────

if __name__ == "__main__":
    # Bandit B104: binding to all interfaces is required here. Amazon
    # Bedrock AgentCore Runtime invokes the container behind a managed
    # ingress that targets the container port directly; binding to
    # 127.0.0.1 makes the runtime unreachable. The container itself runs
    # in a single-tenant microVM with no other listeners, so "all
    # interfaces" inside the microVM is effectively one interface.
    host = os.getenv("HOST", "0.0.0.0")  # nosec B104
    port = int(os.getenv("PORT", "8080"))
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["loggers"]["uvicorn.access"]["level"] = "WARNING"
    uvicorn.run(app, host=host, port=port, log_config=log_config)
