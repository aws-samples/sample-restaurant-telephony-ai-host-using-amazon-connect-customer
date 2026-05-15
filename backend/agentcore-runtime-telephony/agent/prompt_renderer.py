"""Fetch the per-call system prompt from the prompt-renderer Lambda.

Invocation contract (handshake with
`backend/agentcore-runtime-telephony/cdk/runtime/lambda/prompt-renderer/handler.ts`):

  Request JSON:
    {"phoneNumber": "+12125550100", "customerId": "pstn-abcd1234..."}

  Response JSON:
    {
      "systemPrompt": "<rendered text>",
      "profile": {"customerId": "...", "name": "...", "phoneNumber": "..."}
        | null
    }

The Lambda returns an anonymous prompt when the caller is not in the
Customers table (or when the DDB lookup fails transiently). That is a
SUCCESSFUL path — this helper must not treat it as an error.

Failure paths (this helper raises, caller falls back to
`system_prompt.build(session)` as a last resort):
  * missing env var `PROMPT_RENDERER_FUNCTION_NAME`
  * Lambda ClientError / NoCredentials / service exception
  * response missing/empty `systemPrompt`
  * JSON decode error
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-1")
PROMPT_RENDERER_FUNCTION_NAME_ENV = "PROMPT_RENDERER_FUNCTION_NAME"
RENDERER_TIMEOUT_S = 2.5  # agent-side cap; Lambda itself has a 3s timeout


@dataclass
class RenderedPrompt:
    """Output of a successful renderer call."""

    system_prompt: str
    customer_name: Optional[str]   # present iff profile was returned
    is_loyalty: bool               # True iff profile was returned


def _lambda_client():
    """Lazy boto3 import so unit tests that stub this helper don't
    force boto3 onto the import path."""
    import boto3  # type: ignore

    return boto3.client("lambda", region_name=REGION)


async def fetch(raw_from: str, customer_id: str) -> RenderedPrompt:
    """Invoke the prompt-renderer Lambda and return the rendered prompt.

    Called once per inbound call from telephony_agent.websocket_endpoint,
    in parallel with Nova Sonic + MCP setup under asyncio.gather() so
    the latency cost is hidden behind the Nova Sonic handshake.

    `raw_from` MUST be an E.164 string (caller already validated via
    pstn_customer.derive). `customer_id` is the agent's pseudonymous id.
    """
    function_name = os.environ.get(PROMPT_RENDERER_FUNCTION_NAME_ENV)
    if not function_name:
        raise RuntimeError(
            f"env var {PROMPT_RENDERER_FUNCTION_NAME_ENV} is not set"
        )

    payload = {
        "phoneNumber": raw_from,
        "customerId": customer_id,
    }

    def _invoke_sync() -> dict:
        client = _lambda_client()
        resp = client.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        if resp.get("FunctionError"):
            raise RuntimeError(
                f"prompt-renderer returned FunctionError={resp['FunctionError']}"
            )
        body = resp["Payload"].read()
        return json.loads(body.decode("utf-8"))

    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_invoke_sync),
            timeout=RENDERER_TIMEOUT_S,
        )
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"prompt-renderer timed out after {RENDERER_TIMEOUT_S}s"
        ) from exc

    system_prompt = result.get("systemPrompt")
    if not isinstance(system_prompt, str) or not system_prompt.strip():
        raise RuntimeError(
            "prompt-renderer response missing or empty systemPrompt"
        )

    profile = result.get("profile")
    if profile is None:
        return RenderedPrompt(
            system_prompt=system_prompt,
            customer_name=None,
            is_loyalty=False,
        )

    name = profile.get("name")
    if not isinstance(name, str) or not name.strip():
        # Profile row existed but no name — treat as anonymous for
        # safety (the renderer's own logic should have done this, but
        # we double-check to keep the contract tight).
        logger.warning(
            "prompt-renderer returned profile without name; treating as anonymous",
            extra={"customer_id": customer_id},
        )
        return RenderedPrompt(
            system_prompt=system_prompt,
            customer_name=None,
            is_loyalty=False,
        )

    return RenderedPrompt(
        system_prompt=system_prompt,
        customer_name=name,
        is_loyalty=True,
    )
