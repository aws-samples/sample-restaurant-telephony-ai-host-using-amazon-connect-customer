"""Deterministic customerId derivation from a caller's E.164.

Contract (design §8.5, R8, P3/P4/P11):
- Identified: `customer_id = "pstn-" + sha256(E164 || pepper)[:16]` — pure
  function of (E.164, pepper).
- Anonymous: `customer_id = "pstn-anonymous-" + secrets.token_hex(8)` —
  non-deterministic fallback.
- `from_last4` — last 4 digits of normalized E.164, or `""` if <4 digits.

Normalization (closes design gap #3):
- strip() whitespace
- must match `^\\+[1-9]\\d{1,14}$` (standard E.164)
- digits-only body after the leading `+` — uppercase letters disqualify
- literal "" / "anonymous" / anything non-matching → anonymous

Pepper: loaded lazily at first call from SSM SecureString at
`os.environ["CUSTOMER_ID_PEPPER_PARAMETER_NAME"]`. Cached module-level.
Never logged. Never put into env var or CfnOutput (R18).
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

_E164_REGEX = re.compile(r"^\+[1-9]\d{1,14}$")
_CUSTOMER_ID_HEX_LEN = 16  # 8 bytes of sha256, hex-encoded

# Module-level pepper cache. None = not yet loaded; bytes = loaded value.
_pepper: Optional[bytes] = None


def _load_pepper() -> bytes:
    """Load the pepper from SSM (SecureString) once per process and cache it.

    Returns the raw bytes value. Never logs the value.
    """
    global _pepper
    if _pepper is not None:
        return _pepper

    param_name = os.environ.get("CUSTOMER_ID_PEPPER_PARAMETER_NAME")
    if not param_name:
        # Deliberate fallback for unit tests / local smoke: empty pepper.
        # The real runtime always sets this env var (CDK runtime stack task 5.5).
        logger.warning("CUSTOMER_ID_PEPPER_PARAMETER_NAME not set; using empty pepper")
        _pepper = b""
        return _pepper

    # Lazy boto3 import so modules that don't touch customer derivation
    # don't pay the import cost (and so unit tests that stub this helper
    # never need boto3 installed).
    import boto3

    ssm = boto3.client("ssm", region_name="us-east-1")
    resp = ssm.get_parameter(Name=param_name, WithDecryption=True)
    _pepper = resp["Parameter"]["Value"].encode("utf-8")
    # Log only the fact of load + length — never the value.
    logger.info("customer_id pepper loaded", extra={"pepper_len": len(_pepper)})
    return _pepper


def _normalize_e164(raw_from: str) -> Optional[str]:
    """Return the normalized E.164 string, or None if `raw_from` is not valid."""
    if not isinstance(raw_from, str):
        return None
    candidate = raw_from.strip()
    if not _E164_REGEX.match(candidate):
        return None
    # _E164_REGEX already rejects uppercase letters (digits only after `+`).
    return candidate


def _last4(e164: str) -> str:
    """Return the last 4 digits of `e164`, or '' if fewer than 4 digits."""
    digits = [c for c in e164 if c.isdigit()]
    if len(digits) < 4:
        return ""
    return "".join(digits[-4:])


def derive(raw_from: str, pepper: bytes) -> Tuple[str, bool, str]:
    """Pure derivation.

    Returns `(customer_id, anonymous, from_last4)`.

    Purity: for valid E.164 inputs, `(raw_from, pepper)` → same `customer_id`
    across calls (R8, P11). For anonymous inputs, `customer_id` contains
    random bytes and is NOT stable — callers treat anonymous sessions as
    one-shot.
    """
    e164 = _normalize_e164(raw_from)
    if e164 is None:
        # Anonymous — non-deterministic id, empty last4 if raw had nothing parseable.
        digits_from_raw = "".join(c for c in (raw_from or "") if c.isdigit())
        last4 = digits_from_raw[-4:] if len(digits_from_raw) >= 4 else ""
        return (
            "pstn-anonymous-" + secrets.token_hex(8),
            True,
            last4,
        )

    digest = hashlib.sha256(e164.encode("utf-8") + pepper).hexdigest()
    customer_id = "pstn-" + digest[:_CUSTOMER_ID_HEX_LEN]
    return customer_id, False, _last4(e164)


def derive_for_session(raw_from: str) -> Tuple[str, bool, str]:
    """Convenience wrapper that pulls the pepper from SSM automatically."""
    return derive(raw_from, _load_pepper())


def _reset_pepper_for_tests() -> None:
    """Test helper — clears the module-level pepper cache."""
    global _pepper
    _pepper = None
