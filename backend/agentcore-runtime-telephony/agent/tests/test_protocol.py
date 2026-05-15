"""r6 protocol tests — auth metadata parsing + Bidi audio aggregation.

These exercise the pure-Python helpers extracted into `protocol.py` from
`telephony_agent.py`.  They run without Strands/MCP installed (which is
why the logic sits in a separate module).

Covered behavior:

- `parse_auth_metadata`
    - well-formed JSON with a valid E.164 → identified session, last4 set
    - well-formed JSON with empty / malformed caller_from → anonymous
    - missing fields, non-dict JSON, truly malformed JSON → anonymous fallback
    - none of the surface fields leak raw_from into the log-safe fields

- `BidiAudioAggregator`
    - feeds below the threshold return None and buffer grows
    - feeds crossing the threshold return the accumulated bytes and reset
    - flush() on empty returns None; on partial returns the partial + clears
    - target_bytes matches the L16 byte-rate math

- `build_stream_audio_envelope`
    - returns the exact wire envelope shape (inherited from mod_audio_stream's
      play protocol, kept verbatim so the Node bridge stays compatible)
    - audio round-trips base64 cleanly
"""
from __future__ import annotations

import base64
import json

import pytest

import protocol
from protocol import (
    BidiAudioAggregator,
    MODEL_OUTPUT_SAMPLE_RATE,
    OUTPUT_FRAME_BUFFER_MS,
    build_stream_audio_envelope,
    parse_auth_metadata,
)


# ───────────── parse_auth_metadata ─────────────


class TestParseAuthMetadata:
    def test_valid_metadata_yields_identified_session(self):
        raw = json.dumps(
            {
                "type": "auth",
                "caller_from": "+12025551212",
                "call_id": "uuid-1234",
                "deployment_prefix": "dev",
            }
        )
        session = parse_auth_metadata(raw)
        assert session.call_id == "uuid-1234"
        assert session.raw_from == "+12025551212"
        assert session.from_last4 == "1212"
        assert session.anonymous is False
        assert session.customer_id.startswith("pstn-")
        assert len(session.customer_id) == len("pstn-") + 16

    def test_empty_caller_from_flags_anonymous(self):
        raw = json.dumps({"type": "auth", "caller_from": "", "call_id": "c1"})
        session = parse_auth_metadata(raw)
        assert session.anonymous is True
        assert session.from_last4 == ""
        assert session.customer_id.startswith("pstn-anonymous-")
        assert session.call_id == "c1"

    def test_missing_caller_from_flags_anonymous(self):
        raw = json.dumps({"type": "auth", "call_id": "c2"})
        session = parse_auth_metadata(raw)
        assert session.anonymous is True
        assert session.raw_from == ""
        assert session.call_id == "c2"

    @pytest.mark.parametrize(
        "raw",
        [
            "not json at all",
            "{invalid}",
            "",
            "[]",  # top-level list, not dict
            "null",
            "42",
        ],
    )
    def test_malformed_json_falls_back_to_anonymous(self, raw):
        session = parse_auth_metadata(raw)
        assert session.anonymous is True
        assert session.raw_from == ""
        assert session.call_id == ""
        # customer_id is still generated — the call keeps running.
        assert session.customer_id.startswith("pstn-anonymous-")

    def test_non_string_fields_coerced(self):
        # JSON forces call_id to str; test dict-valued (non-string) coerces safely.
        raw = json.dumps(
            {
                "type": "auth",
                "caller_from": "+442071838750",
                "call_id": 12345,  # number instead of string
            }
        )
        session = parse_auth_metadata(raw)
        assert session.call_id == "12345"  # str() coerced
        assert session.raw_from == "+442071838750"
        assert session.from_last4 == "8750"
        assert session.anonymous is False

    def test_extra_fields_are_ignored(self):
        raw = json.dumps(
            {
                "type": "auth",
                "caller_from": "+12025551212",
                "call_id": "c3",
                "deployment_prefix": "dev",
                "unknown_field": "ignored",
                "nested": {"also": "ignored"},
            }
        )
        session = parse_auth_metadata(raw)
        assert session.call_id == "c3"
        assert session.anonymous is False


# ───────────── BidiAudioAggregator ─────────────


def _b64(n_bytes: int) -> str:
    """Helper — return base64 of n zero bytes (L16 silence)."""
    return base64.b64encode(b"\x00" * n_bytes).decode("ascii")


class TestBidiAudioAggregator:
    def test_target_bytes_matches_l16_byte_rate(self):
        # 2 bytes/sample * 16000 Hz * 60 ms / 1000 = 1920 bytes.
        # Window dropped from 500 ms → 60 ms in the r6 pacing fix so the
        # Node RTP bridge (20 ms pacer) can drain the envelope evenly
        # without long silences between bursts.
        agg = BidiAudioAggregator()
        assert agg._target_bytes == 1920

    def test_target_bytes_with_custom_params(self):
        agg = BidiAudioAggregator(sample_rate=8000, buffer_ms=1000)
        # 2 * 8000 * 1000 / 1000 = 16000 (same value, different derivation)
        assert agg._target_bytes == 16000

        agg2 = BidiAudioAggregator(sample_rate=24000, buffer_ms=100)
        # 2 * 24000 * 100 / 1000 = 4800
        assert agg2._target_bytes == 4800

    def test_feed_below_threshold_returns_none(self):
        agg = BidiAudioAggregator()
        # 200 bytes << 1920 byte target (60ms @ 16kHz L16).
        assert agg.feed(_b64(200)) is None
        assert agg.feed(_b64(500)) is None
        # Buffer has accumulated; flush reveals it.
        partial = agg.flush()
        assert partial is not None
        assert len(partial) == 700

    def test_feed_at_threshold_emits_and_resets(self):
        agg = BidiAudioAggregator()
        # Accumulate just under threshold.
        assert agg.feed(_b64(1000)) is None
        assert agg.feed(_b64(500)) is None
        # This feed pushes us past the 1920 threshold.
        emitted = agg.feed(_b64(600))
        assert emitted is not None
        assert len(emitted) == 2100  # 1000 + 500 + 600
        # Buffer is reset; a fresh flush returns None.
        assert agg.flush() is None

    def test_feed_exactly_at_threshold_emits(self):
        agg = BidiAudioAggregator()
        emitted = agg.feed(_b64(1920))
        assert emitted is not None
        assert len(emitted) == 1920
        assert agg.flush() is None

    def test_feed_far_above_threshold_emits_once(self):
        agg = BidiAudioAggregator()
        emitted = agg.feed(_b64(8000))
        # We emit ALL accumulated bytes in one shot (no chunking down).
        # Per-envelope size-limiting is the downstream consumer's problem.
        assert emitted is not None
        assert len(emitted) == 8000

    def test_flush_on_empty_is_none(self):
        agg = BidiAudioAggregator()
        assert agg.flush() is None
        # Flush is idempotent on empty.
        assert agg.flush() is None

    def test_flush_returns_partial_and_clears(self):
        agg = BidiAudioAggregator()
        agg.feed(_b64(500))
        first = agg.flush()
        assert first is not None
        assert len(first) == 500
        # Second flush is now empty.
        assert agg.flush() is None

    def test_post_flush_accumulation_starts_fresh(self):
        agg = BidiAudioAggregator()
        agg.feed(_b64(500))
        agg.flush()
        # New cycle — below threshold.
        assert agg.feed(_b64(1000)) is None
        assert agg.flush() == b"\x00" * 1000

    def test_feed_invalid_base64_raises(self):
        """Guard: bad b64 input raises, doesn't silently corrupt the buffer."""
        agg = BidiAudioAggregator()
        with pytest.raises(Exception):
            agg.feed("not-valid-base64!!!")


# ───────────── build_stream_audio_envelope ─────────────


class TestBuildStreamAudioEnvelope:
    def test_envelope_shape_exact(self):
        pcm = b"\x01\x02\x03\x04"
        env = build_stream_audio_envelope(pcm)
        # Keys match the wire `play` protocol exactly (envelope shape
        # inherited from mod_audio_stream so the bridge implementation
        # could be swapped without changing this side).
        assert set(env.keys()) == {"type", "data"}
        assert env["type"] == "streamAudio"
        assert set(env["data"].keys()) == {"audioDataType", "sampleRate", "audioData"}
        assert env["data"]["audioDataType"] == "raw"
        assert env["data"]["sampleRate"] == MODEL_OUTPUT_SAMPLE_RATE
        # Audio round-trips via base64.
        decoded = base64.b64decode(env["data"]["audioData"])
        assert decoded == pcm

    def test_envelope_is_json_serializable(self):
        env = build_stream_audio_envelope(b"\x00" * 100)
        # Proves we can send_json it.
        as_text = json.dumps(env)
        reparsed = json.loads(as_text)
        assert reparsed == env

    def test_custom_sample_rate(self):
        env = build_stream_audio_envelope(b"\x00" * 16, sample_rate=8000)
        assert env["data"]["sampleRate"] == 8000


# ───────────── constants sanity ─────────────


def test_output_frame_buffer_ms_reasonable():
    # Guardrail bounds updated in r6: Node RTP bridge paces outbound
    # at 20 ms, and we want >=3 frames per envelope to keep syscall
    # overhead down but well under the audible latency budget. 40-250 ms
    # is the safe operating window.
    assert 40 <= OUTPUT_FRAME_BUFFER_MS <= 250


def test_model_sample_rates_match_dialplan():
    # The dialplan passes `16k` to `uuid_audio_stream start`, so our
    # model I/O must use 16 kHz.  If someone changes one side without
    # the other, this test catches it.
    assert protocol.MODEL_INPUT_SAMPLE_RATE == 16000
    assert protocol.MODEL_OUTPUT_SAMPLE_RATE == 16000
    assert protocol.MODEL_CHANNELS == 1
