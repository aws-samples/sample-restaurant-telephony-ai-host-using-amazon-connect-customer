"""P3 / P11 — PlaceOrder body shape + pstn_customer.derive determinism.

Fuzz `mcp_tools.build_place_order_body` with valid E.164s, `"anonymous"`,
`""`, malformed strings, extra whitespace. Assert:
- channel == "telephony"
- anonymousCaller == session.anonymous
- fromPhoneNumber == raw_from iff not anonymous else ""
- customerId == session.customer_id
- no other body key equals raw_from

Also test `pstn_customer.derive` determinism: same input → same output;
different peppers → different customer_ids.
"""
from __future__ import annotations

import hypothesis.strategies as st
import pytest
from hypothesis import given, settings

import mcp_tools
import pstn_customer
from session import Session


def _session_for(raw_from: str) -> Session:
    customer_id, anonymous, from_last4 = pstn_customer.derive(raw_from, b"test-pepper")
    return Session(
        call_id="call-xyz",
        raw_from=raw_from,
        from_last4=from_last4,
        anonymous=anonymous,
        customer_id=customer_id,
    )


@pytest.mark.parametrize(
    "raw_from,expected_anonymous",
    [
        ("+12025551212", False),
        ("+442071838750", False),
        ("+81312345678", False),
        ("", True),
        ("anonymous", True),
        ("not-a-number", True),
        ("+1-202-555-1212", True),  # has dashes — invalid per E.164 strict
        ("  +12025551212  ", False),  # whitespace gets stripped
        ("+0123456789", True),  # leading 0 after + is invalid
        ("+ABC", True),  # uppercase letters
    ],
)
def test_place_order_body_shape(raw_from, expected_anonymous):
    session = _session_for(raw_from)
    body = mcp_tools.build_place_order_body(session)

    assert body["channel"] == "telephony"
    assert body["anonymousCaller"] is expected_anonymous
    if expected_anonymous:
        assert body["fromPhoneNumber"] == ""
    else:
        assert body["fromPhoneNumber"] == session.raw_from
    assert body["customerId"] == session.customer_id

    # No other body field equals raw_from — only fromPhoneNumber may match
    # (and only when identified).
    for key, value in body.items():
        if key == "fromPhoneNumber":
            continue
        assert value != raw_from, f"field {key} accidentally leaks raw_from"


@given(
    raw_from=st.one_of(
        st.text(max_size=30),
        # Well-formed E.164 shape.
        st.from_regex(r"\+[1-9][0-9]{7,14}", fullmatch=True),
        st.just(""),
        st.just("anonymous"),
    )
)
@settings(max_examples=100, deadline=None)
@pytest.mark.property
def test_place_order_body_shape_property(raw_from):
    session = _session_for(raw_from)
    body = mcp_tools.build_place_order_body(session)

    # Always exactly these four keys.
    assert set(body.keys()) == {"channel", "anonymousCaller", "fromPhoneNumber", "customerId"}
    assert body["channel"] == "telephony"
    assert isinstance(body["anonymousCaller"], bool)
    assert body["anonymousCaller"] is session.anonymous
    if session.anonymous:
        assert body["fromPhoneNumber"] == ""
    else:
        assert body["fromPhoneNumber"] == session.raw_from


def test_derive_is_deterministic_for_same_input():
    pepper = b"pepper-1"
    a1, anon1, last4a = pstn_customer.derive("+12025551212", pepper)
    a2, anon2, last4b = pstn_customer.derive("+12025551212", pepper)
    assert a1 == a2
    assert anon1 == anon2 is False
    assert last4a == last4b == "1212"


def test_derive_differs_across_peppers():
    a, _, _ = pstn_customer.derive("+12025551212", b"pepper-1")
    b, _, _ = pstn_customer.derive("+12025551212", b"pepper-2")
    assert a != b


def test_derive_anonymous_has_stable_prefix_but_random_suffix():
    a, anon_a, _ = pstn_customer.derive("anonymous", b"pepper")
    b, anon_b, _ = pstn_customer.derive("anonymous", b"pepper")
    assert anon_a is anon_b is True
    assert a.startswith("pstn-anonymous-")
    assert b.startswith("pstn-anonymous-")
    # Two anonymous calls get different IDs (non-deterministic by design).
    assert a != b


@pytest.mark.parametrize("raw_from", ["", " ", "anonymous", "+", "+0", "++1555", "no"])
def test_derive_flags_anonymous_for_bad_input(raw_from):
    _, anonymous, _ = pstn_customer.derive(raw_from, b"pepper")
    assert anonymous is True


@pytest.mark.parametrize(
    "raw_from,expected_last4",
    [
        ("+12025551212", "1212"),
        ("+442071838750", "8750"),
        ("+123", ""),  # only 3 digits
        ("", ""),
    ],
)
def test_from_last4(raw_from, expected_last4):
    _, _, last4 = pstn_customer.derive(raw_from, b"pepper")
    assert last4 == expected_last4


def test_customer_id_format_identified():
    cid, _, _ = pstn_customer.derive("+12025551212", b"pepper")
    assert cid.startswith("pstn-")
    assert len(cid) == len("pstn-") + 16
    # Hex chars only after the prefix.
    assert all(c in "0123456789abcdef" for c in cid[5:])
