"""Per-WebSocket call session record.

In r5 this was a module-level registry (`call_state.py`) tracking multiple
concurrent calls under one HTTP /invocations router.  In r6 each call has
its own WebSocket handler coroutine, so the "registry" collapses into a
single dataclass owned by that coroutine.

Fields mirror the attributes that `mcp_tools.build_place_order_body` and
`system_prompt.build` read — keeping the interface identical so the
surviving helpers work unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class Session:
    """One active voice call.

    Attributes:
        call_id:      Channel UUID, threaded in via the auth-metadata
                      first frame (`{"type":"auth","call_id":...}`) from
                      the Node SIP-gateway bridge.
        raw_from:     Caller's E.164 as delivered by Chime Voice Connector.
                      Never logged; used only to derive customer_id + drive
                      the MCP PlaceOrder body.
        from_last4:   Last 4 digits of raw_from (or "" if unparseable). Safe
                      to log per NFR9.
        anonymous:    True iff raw_from did not parse as a strict E.164
                      (per pstn_customer.derive).
        customer_id:  Pseudonymous stable id: pstn-<16hex> for identified
                      callers, pstn-anonymous-<16hex> for anonymous ones.
        customer_name: Display name resolved by the prompt-renderer Lambda
                       for loyalty callers. None for anonymous callers or
                       when the renderer fell through to the local-
                       template fallback. Safe to log.
        is_loyalty:   True iff prompt_renderer.fetch() returned a profile
                      with a non-empty name. Used for observability only;
                      the system prompt itself already encodes the
                      loyalty vs anonymous branching.
    """

    call_id: str
    raw_from: str
    from_last4: str
    anonymous: bool
    customer_id: str
    customer_name: Optional[str] = None
    is_loyalty: bool = False


# Backwards-compat alias for any code path / test that still imports
# CallSession from call_state (the r5 name).  Can be removed once all
# references have migrated.
CallSession = Session
