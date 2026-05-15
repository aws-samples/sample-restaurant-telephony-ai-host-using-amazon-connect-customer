"""SIP-gateway WebSocket bridge ↔ telephony_agent protocol helpers.

Pure functions with no third-party imports beyond the Python stdlib +
our own `pstn_customer` / `session` modules.  Extracted from
`telephony_agent.py` so they can be unit-tested without needing the
Strands SDK installed.

Responsibilities:
  - Parse the `auth` metadata frame sent by the Node SIP-gateway bridge
    (drachtio + Node bridge — `backend/drachtio-sip-gateway/`) and build
    a `Session`.
  - Buffer Nova-Sonic audio output into larger envelopes before emitting
    so the bridge's 20 ms RTP pacer always has work queued.
  - Wrap aggregated PCM bytes in the `streamAudio` JSON envelope the
    Node bridge consumes on its "play" path.

Protocol shape:

The wire envelope ({"type":"streamAudio","data":{...}}) is historically
derived from the `mod_audio_stream` FreeSWITCH module's play protocol;
we keep that shape verbatim so the bridge could be swapped back to
mod_audio_stream without changing this side. The current client is the
Node SIP-gateway bridge.
"""
from __future__ import annotations

import base64
import json
import logging
import re
from typing import Optional

import pstn_customer
from session import Session

logger = logging.getLogger(__name__)


# SIP URI recogniser — strips the `sip:` / `sips:` prefix, the host/port,
# and any URI parameters to leave just the user portion. The Node SIP
# gateway now pre-strips this on its side, but we keep the Python-side
# fallback so malformed or legacy inputs still work.
_SIP_URI_RE = re.compile(r"^sips?:([^@;>]+)", re.IGNORECASE)


def _strip_sip_uri(raw: str) -> str:
    """Return just the user portion of a SIP URI, or `raw` unchanged."""
    if not isinstance(raw, str):
        return ""
    m = _SIP_URI_RE.match(raw.strip())
    return (m.group(1) if m else raw).strip()


# ───────────── Audio plumbing constants ─────────────

# Nova Sonic emits 24 kHz PCM by default; the Node SIP-gateway bridge
# expects 16 kHz on the playback side (we ask for 16 kHz on both legs of
# the WebSocket and the bridge converts to/from 8 kHz μ-law on the RTP
# side). We configure Nova Sonic to ALSO use 16 kHz on the output side
# so no sample-rate conversion is needed in this process — the base64
# payload we emit is the raw bytes Nova Sonic produced.
MODEL_INPUT_SAMPLE_RATE = 16000
MODEL_OUTPUT_SAMPLE_RATE = 16000
MODEL_CHANNELS = 1

# Aggregate this many milliseconds of Nova-Sonic audio into one outbound
# WebSocket frame. The Node bridge consumes each WS frame directly into
# its paced 20 ms RTP sender. A 60 ms window (3 RTP frames per envelope)
# gives the bridge enough work per tick to stay ahead of the 20 ms
# cadence while keeping end-to-end latency close to the model's own
# output latency.
OUTPUT_FRAME_BUFFER_MS = 60


# ───────────── Auth-metadata parsing ─────────────


def parse_auth_metadata(raw: str) -> Session:
    """Parse the first text frame into a `Session`.

    Falls back to anonymous if the payload is malformed — we never kill a
    live call over metadata parsing (P4).  Safe fields (from_last4,
    call_id, anonymous, customer_id) get logged; raw_from never does.
    """
    try:
        payload = json.loads(raw)
    except Exception:
        logger.warning("auth metadata JSON parse failed")
        payload = {}

    caller_from = ""
    call_id = ""
    if isinstance(payload, dict):
        caller_from = _strip_sip_uri(str(payload.get("caller_from", "")))
        call_id = str(payload.get("call_id", ""))

    try:
        customer_id, anonymous, from_last4 = pstn_customer.derive_for_session(caller_from)
    except Exception as exc:
        logger.warning(
            "pstn_customer.derive_for_session failed; falling back to empty pepper",
            extra={"err": str(exc)},
        )
        customer_id, anonymous, from_last4 = pstn_customer.derive(caller_from, b"")

    session = Session(
        call_id=call_id,
        raw_from=caller_from,
        from_last4=from_last4,
        anonymous=anonymous,
        customer_id=customer_id,
    )

    logger.info(
        "auth metadata parsed",
        extra={
            "call_id": call_id,
            "from_last4": from_last4,
            "anonymous": anonymous,
            "customer_id": customer_id,
        },
    )
    return session


# ───────────── Outbound audio aggregator ─────────────


class BidiAudioAggregator:
    """Buffer Nova-Sonic audio chunks into ~OUTPUT_FRAME_BUFFER_MS envelopes.

    Nova Sonic emits many small `BidiAudioStreamEvent`s as it speaks.  We
    accumulate their base64-decoded bytes until we have enough PCM samples
    to cover `OUTPUT_FRAME_BUFFER_MS`, then re-base64 and return the
    accumulated chunk.  The final (possibly short) chunk is flushed when
    a `BidiResponseCompleteEvent` or `BidiInterruptionEvent` fires.
    """

    def __init__(
        self,
        sample_rate: int = MODEL_OUTPUT_SAMPLE_RATE,
        buffer_ms: int = OUTPUT_FRAME_BUFFER_MS,
    ) -> None:
        self._buf = bytearray()
        # 2 bytes per sample (L16 little-endian) * sample_rate * ms / 1000.
        self._target_bytes = int(2 * sample_rate * buffer_ms / 1000)

    def feed(self, b64_audio: str) -> Optional[bytes]:
        """Append a Nova-Sonic base64 chunk.

        Returns the accumulated PCM bytes if the buffer is now at or over
        the target threshold (and clears the buffer); returns ``None``
        otherwise.
        """
        self._buf.extend(base64.b64decode(b64_audio))
        if len(self._buf) >= self._target_bytes:
            out = bytes(self._buf)
            self._buf.clear()
            return out
        return None

    def flush(self) -> Optional[bytes]:
        """Return any partial buffer and clear it.  ``None`` if empty."""
        if not self._buf:
            return None
        out = bytes(self._buf)
        self._buf.clear()
        return out


def build_stream_audio_envelope(
    pcm_bytes: bytes,
    sample_rate: int = MODEL_OUTPUT_SAMPLE_RATE,
) -> dict:
    """Wrap raw PCM bytes in the bridge's "play" envelope.

    The Node bridge plays audio sent back from the WebSocket server when
    the message is JSON of this exact shape (envelope inherited from
    mod_audio_stream's play protocol so the wire format stays stable):

        {"type":"streamAudio","data":{"audioDataType":"raw","sampleRate":N,"audioData":"<b64>"}}
    """
    return {
        "type": "streamAudio",
        "data": {
            "audioDataType": "raw",
            "sampleRate": sample_rate,
            "audioData": base64.b64encode(pcm_bytes).decode("ascii"),
        },
    }
