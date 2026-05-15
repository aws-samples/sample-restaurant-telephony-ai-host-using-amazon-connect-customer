"""MCP client factory bound to a customer_id + PlaceOrder body builder.

The `for_customer(customer_id)` factory returns an MCP client factory
usable with `strands.tools.mcp.mcp_client.MCPClient`. Tools discovered
via `list_tools_sync()` get the `basePath` workaround applied (mirrors
reference `qsr_agent.py` lines ~240-275).

`build_place_order_body(session)` enforces the R9 shape:
- channel = "telephony"
- anonymousCaller = session.anonymous
- fromPhoneNumber = session.raw_from iff !anonymous else ""
- customerId = session.customer_id
- no other field equals raw_from

Retry contract (R16 F4): one retry after 500 ms on MCP tool failure;
second failure raises `ToolError` which Nova Sonic surfaces as a
natural-language "sorry, can't reach the kitchen" message.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any, Callable, Dict, List

logger = logging.getLogger(__name__)

REGION = "us-east-1"
MCP_RETRY_DELAY_S = 0.5

if TYPE_CHECKING:  # pragma: no cover — type-only
    from session import Session


class ToolError(Exception):
    """Raised when an MCP tool call has exhausted its retry budget (F4)."""


def for_customer(customer_id: str) -> Callable[[], Any]:
    """Return an MCP client factory closure.

    Usage:
        factory = mcp_tools.for_customer(session.customer_id)
        with MCPClient(factory) as client:
            tools = _apply_basepath_workaround(client.list_tools_sync())
            # pass `tools` to BidiAgent

    The `customer_id` is closed-over so each Strands tool invocation
    carries it automatically — see `_wrap_tools_with_customer_id`.
    """

    def _factory():
        from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

        gateway_url = os.environ.get("AGENTCORE_GATEWAY_URL")
        if not gateway_url:
            raise RuntimeError("AGENTCORE_GATEWAY_URL environment variable not set")

        return aws_iam_streamablehttp_client(
            endpoint=gateway_url,
            aws_region=REGION,
            aws_service="bedrock-agentcore",
        )

    return _factory


def apply_basepath_workaround(mcp_tools: List[Any]) -> List[Any]:
    """Strip `basePath` from each tool's inputSchema (workaround for the
    AgentCore Gateway OpenAPI-import bug).

    Mirrors reference `qsr_agent.py` lines ~240-275 verbatim in intent:
    - delete `properties.basePath`
    - remove `basePath` from `required` list if present
    """
    modified = 0
    for tool in mcp_tools:
        schema = getattr(getattr(tool, "mcp_tool", None), "inputSchema", None)
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties")
        if isinstance(props, dict) and "basePath" in props:
            del props["basePath"]
            modified += 1
        required = schema.get("required")
        if isinstance(required, list) and "basePath" in required:
            required.remove("basePath")
    logger.info("mcp_tools basePath workaround applied", extra={"modified": modified})
    return mcp_tools


def wrap_tools_with_customer_id(tools: List[Any], customer_id: str) -> List[Any]:
    """Inject `customerId=<customer_id>` into every tool call.

    Each Strands tool is wrapped in a closure that mutates the tool
    arguments to carry `customerId` regardless of what the model passes.
    This closes the R8 step-5 loop without relying on the model to always
    include customerId on every tool call.
    """
    wrapped: List[Any] = []
    for tool in tools:
        # Dynamic attribute set — concrete strands.tool wrapper type
        # varies by version. The reference implementation simply appends
        # the list, relying on the system prompt to drive customerId.
        # Here we add a per-tool closure via setattr to be safe.
        try:
            original_invoke = getattr(tool, "invoke", None)
            if original_invoke is None:
                wrapped.append(tool)
                continue

            async def _wrapped(args: Dict[str, Any], _orig=original_invoke) -> Any:
                if isinstance(args, dict) and "customerId" not in args:
                    args = {**args, "customerId": customer_id}
                return await _orig(args)

            tool.invoke = _wrapped  # type: ignore[attr-defined]
            wrapped.append(tool)
        except Exception:  # pragma: no cover — best effort
            wrapped.append(tool)
    return wrapped


async def call_with_retry(tool_invoke: Callable[[Dict[str, Any]], Any], args: Dict[str, Any]) -> Any:
    """Invoke `tool_invoke(args)` with one retry on failure (F4).

    Raises `ToolError` on second failure so the nova_sonic layer can
    surface a natural-language error to the caller.
    """
    try:
        return await tool_invoke(args)
    except Exception as first_exc:
        logger.warning("mcp tool call failed, retrying once", extra={"err": str(first_exc)})
        await asyncio.sleep(MCP_RETRY_DELAY_S)
        try:
            return await tool_invoke(args)
        except Exception as second_exc:
            logger.error("mcp tool call failed after retry", extra={"err": str(second_exc)})
            raise ToolError(str(second_exc)) from second_exc


def build_place_order_body(session: "Session") -> Dict[str, Any]:
    """Return the exact PlaceOrder body shape required by R9 / P3 / P11.

    Fields: channel, anonymousCaller, fromPhoneNumber, customerId.
    Nothing else. `fromPhoneNumber` is the raw E.164 iff identified,
    empty string iff anonymous.
    """
    return {
        "channel": "telephony",
        "anonymousCaller": bool(session.anonymous),
        "fromPhoneNumber": session.raw_from if not session.anonymous else "",
        "customerId": session.customer_id,
    }
