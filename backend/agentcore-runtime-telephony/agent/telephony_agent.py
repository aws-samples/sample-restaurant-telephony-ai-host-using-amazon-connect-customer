"""Telephony Voice Ordering Agent — Bedrock AgentCore Runtime (r7.1).

WebSocket server that bridges the drachtio SIP gateway's Node.js Real-time
Transport Protocol bridge to Strands' BidiAgent + Nova Sonic 2 for
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
import logging
import os
import warnings
from typing import Any, List, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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
import system_prompt
from protocol import (
    BidiAudioAggregator,
    MODEL_CHANNELS,
    MODEL_INPUT_SAMPLE_RATE,
    MODEL_OUTPUT_SAMPLE_RATE,
    build_stream_audio_envelope,
    parse_auth_metadata,
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

    Caller is responsible for context-managing the returned client.  Tools
    have:
      (a) the basePath workaround applied (AgentCore Gateway OpenAPI bug
          — see mcp_tools.apply_basepath_workaround),
      (b) the customer_id auto-injected into every invocation
          (mcp_tools.wrap_tools_with_customer_id).
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
    tools = mcp_tools.wrap_tools_with_customer_id(raw, customer_id)
    print(
        f"[telephony_agent] tools ready for BidiAgent count={len(tools)}",
        flush=True,
    )
    return client, tools


# ───────────── FastAPI app ─────────────

app = FastAPI(title="Telephony Voice Ordering Agent (r6)")


@app.get("/ping")
async def ping() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "healthy"})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """One WebSocket = one voice call.

    Flow:
      1. Accept WS.
      2. Receive the first (text) frame — auth metadata.
      3. Spin up BidiAgent + MCPClient with a per-call system prompt.
      4. Kick off the agent with a "Hi" text event so Nova Sonic speaks
         first.
      5. Run `_read_loop` + `_write_loop` concurrently until the WebSocket
         closes or Nova Sonic errors.
    """
    # Double-print for visibility — print() bypasses the logging subsystem
    # which the Bedrock AgentCore Runtime platform sometimes tees to
    # CloudWatch through a different path than stdout.
    print("[telephony_agent] /ws endpoint hit", flush=True)
    await websocket.accept()
    print("[telephony_agent] websocket accepted", flush=True)
    logger.info("websocket accepted", extra={"client": str(websocket.client)})

    voice_id = websocket.query_params.get("voice_id", "tiffany")

    mcp_client: Optional[MCPClient] = None
    agent: Optional[BidiAgent] = None

    try:
        # ───── Step 2: auth metadata (first text frame) ─────
        try:
            first_text = await websocket.receive_text()
        except Exception as exc:
            logger.warning("no auth metadata on first frame", extra={"err": str(exc)})
            await websocket.close(code=1008)
            return

        session = parse_auth_metadata(first_text)

        # ───── Scanner-abuse short-circuit ─────
        #
        # The public NLB is reachable by SIP scanners that probe with
        # fake usernames (`sip:sommer:sommer@...`, `sip:voxbox:...`).
        # Legitimate calls routed through Chime Voice Connector always
        # arrive with an E.164 caller ID. If the caller_from didn't
        # normalize to E.164, it's almost certainly a scanner — close
        # immediately rather than burning Nova Sonic / MCP resources
        # on a session that can't order anything anyway.
        if session.anonymous and not session.raw_from:
            # Empty caller_from (withheld Caller ID) is a legitimate
            # anonymous call — keep it running.
            pass
        elif session.anonymous:
            logger.warning(
                "scanner-like caller_from; closing early",
                extra={"call_id": session.call_id, "from_last4": session.from_last4},
            )
            try:
                await websocket.close(code=1008)
            except Exception:
                pass
            return

        # ───── Resolve the per-call system prompt ─────
        #
        # Invoke the prompt-renderer Lambda concurrently with Nova Sonic /
        # MCP discovery so the ~50-200 ms renderer call hides behind
        # those already-running tasks. On any renderer failure we fall
        # back to the container-baked `system_prompt.build(session)` so
        # the call still works — just without the loyalty greeting.
        renderer_task = asyncio.create_task(
            prompt_renderer.fetch(session.raw_from, session.customer_id),
            name=f"renderer-{session.call_id}",
        )

        # ───── Step 3: build the BidiAgent ─────
        model = BidiNovaSonicModel(
            model_id=os.environ.get("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0"),
            region=os.environ.get("AWS_REGION", "us-east-1"),
            provider_config={
                "audio": {
                    "input_sample_rate": MODEL_INPUT_SAMPLE_RATE,
                    "output_sample_rate": MODEL_OUTPUT_SAMPLE_RATE,
                    "voice": voice_id,
                }
            },
        )

        mcp_client, tools = _discover_tools(session.customer_id)

        # Resolve the renderer task — by now Nova Sonic + MCP setup has
        # burned ~1-2 seconds, so the renderer response is almost
        # certainly ready.
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
        )

        # Manual start + send + receive loop — the documented pattern
        # from https://strandsagents.com/docs/user-guide/concepts/
        # bidirectional-streaming/quickstart/ ("Manual Start and Stop").
        # The `inputs=/outputs=` form of agent.run() doesn't match our
        # wire protocol (binary PCM up, streamAudio JSON down), so we
        # drive the agent directly.
        await agent.start()
        logger.info("bidi agent started", extra={"call_id": session.call_id})
        print(f"[telephony_agent] bidi agent started call_id={session.call_id}", flush=True)

        # Prime Nova Sonic — `agent.send(str)` is the documented way to
        # inject user text into a live bidi session.  The model treats
        # it as if the user had said "Hi" and responds accordingly.
        print(f"[telephony_agent] priming with Hi call_id={session.call_id}", flush=True)
        await agent.send("Hi")
        print(f"[telephony_agent] primed call_id={session.call_id}", flush=True)

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

        async def _write_loop_inline():
            nonlocal aggregator
            event_count = 0
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
                        await websocket.send_json(build_stream_audio_envelope(pcm))
                elif isinstance(event, (BidiResponseCompleteEvent, BidiInterruptionEvent)):
                    pcm = aggregator.flush()
                    if pcm is not None:
                        await websocket.send_json(build_stream_audio_envelope(pcm))
                    if isinstance(event, BidiInterruptionEvent):
                        # Tell the Node bridge to wipe its outbound
                        # queue so stale audio stops immediately.
                        try:
                            await websocket.send_json({"type": "bargeIn"})
                        except Exception:
                            pass
                        logger.info(
                            "agent interrupted",
                            extra={"call_id": session.call_id, "reason": event.reason},
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

        read_task = asyncio.create_task(_read_loop_inline(), name=f"read-{session.call_id}")
        write_task = asyncio.create_task(_write_loop_inline(), name=f"write-{session.call_id}")

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
            {read_task, write_task, keepalive_task},
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
    """Pump agent events into the WebSocket.

    Aggregates `BidiAudioStreamEvent`s into ~OUTPUT_FRAME_BUFFER_MS
    envelopes before sending (see `BidiAudioAggregator` rationale).

    Transcripts + interruptions are logged for observability but NOT
    forwarded to the bridge — the bridge only understands the
    `streamAudio` JSON envelope on its receive path.
    """
    aggregator = BidiAudioAggregator()
    print(f"[telephony_agent] write loop start call_id={session.call_id}", flush=True)
    event_count = 0
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
                    await websocket.send_json(build_stream_audio_envelope(pcm))
            elif isinstance(event, (BidiResponseCompleteEvent, BidiInterruptionEvent)):
                # Flush any partial audio buffer so the caller hears the
                # tail of the last utterance immediately.
                pcm = aggregator.flush()
                if pcm is not None:
                    await websocket.send_json(build_stream_audio_envelope(pcm))
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
