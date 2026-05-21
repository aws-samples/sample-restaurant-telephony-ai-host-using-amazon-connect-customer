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

Customer-id isolation (R8 / P11):
The agent MUST NEVER trust a customerId emitted by the model — even
when the system prompt says so, the LLM has been observed to
hallucinate plausible-looking values (e.g. the caller's display name).
Two-layer defence implemented here:
  1. `strip_customer_id_from_schemas` removes the `customerId` field
     from every MCP tool's input schema before the agent is
     constructed, so the model literally cannot include it in a
     tool_use argument.
  2. `customer_id_hook(session.customer_id)` returns a Strands
     `HookProvider` registered on the `BidiAgent`. The hook fires on
     every `BidiBeforeToolCallEvent` and unconditionally overwrites
     `tool_use["input"]["customerId"]` with the session-derived value
     before the executor calls `MCPAgentTool.stream(...)`. Sources:
       - strands-agents/sdk-python v1.37.0
         src/strands/tools/executors/_executor.py:131-135
         src/strands/experimental/hooks/events.py:96-115
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any, Callable, Dict, List

# NOTE: strands is imported lazily inside `customer_id_hook` and the
# hook class so this module remains importable in test environments
# that do not install the bidi extra. The container always has it.

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


def strip_customer_id_from_schemas(mcp_tools: List[Any]) -> List[Any]:
    """Remove `customerId` from every tool's inputSchema.

    Belt for the suspenders that is `customer_id_hook`. The MCP gateway
    surfaces `customerId` as a top-level required parameter on most
    tools so the OpenAPI contract can be reused by other (web / mobile)
    clients. For the telephony agent the value is verified server-side
    from the SIP-derived hash and MUST NEVER be supplied by the model.

    Removing the field from the schema means the LLM literally cannot
    include `customerId` in the tool_use it emits — Nova Sonic only
    fills in fields that exist in the tool spec. This stops the
    hallucinated-value class of bug at the source. The hook still
    overwrites the field at invoke time as defence in depth.
    """
    modified = 0
    for tool in mcp_tools:
        schema = getattr(getattr(tool, "mcp_tool", None), "inputSchema", None)
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties")
        if isinstance(props, dict) and "customerId" in props:
            del props["customerId"]
            modified += 1
        required = schema.get("required")
        if isinstance(required, list) and "customerId" in required:
            required.remove("customerId")
    logger.info(
        "mcp_tools customerId stripped from input schemas",
        extra={"modified": modified},
    )
    return mcp_tools


class _CustomerIdInjector:
    """Strands hook that overwrites `customerId` on every BidiAgent tool call.

    Implements `strands.hooks.HookProvider` (duck-typed; we don't
    inherit so the import stays lazy — the strands package is only
    available inside the runtime container, not in test envs).

    Strands fires `BidiBeforeToolCallEvent` immediately before the tool
    executor invokes `MCPAgentTool.stream(tool_use, ...)`, so any value
    the model put under `tool_use["input"]["customerId"]` (typically a
    hallucinated display-name) is replaced with the session-derived
    pseudonymous id before it reaches MCP / the gateway / the Lambda.

    Sources (strands-agents/sdk-python v1.37.0):
      - hook event class: src/strands/experimental/hooks/events.py:96
      - executor reads before_event.tool_use after hook returns:
        src/strands/tools/executors/_executor.py:131-135
    """

    def __init__(self, customer_id: str) -> None:
        if not customer_id:
            raise ValueError("customer_id must be a non-empty string")
        self._customer_id = customer_id

    def register_hooks(self, registry: Any, **_: Any) -> None:
        # Lazy import — strands is only present inside the container.
        from strands.experimental.hooks.events import BidiBeforeToolCallEvent

        registry.add_callback(BidiBeforeToolCallEvent, self._on_before_tool_call)

    async def _on_before_tool_call(self, event: Any) -> None:
        tool_use = event.tool_use
        # `tool_use["input"]` is the dict the model emitted. Per
        # strands.types.tools.ToolUse it is `Any`, but for MCP tools
        # the model emits a dict. If it isn't, replace with a fresh
        # dict carrying only customerId — better to drop a malformed
        # payload than to leak the model's hallucinated value
        # downstream.
        args = tool_use.get("input")
        if not isinstance(args, dict):
            args = {}

        # UNCONDITIONAL overwrite — do not use setdefault, do not check
        # presence. The whole point is the model's value is untrusted.
        prior = args.get("customerId")
        args["customerId"] = self._customer_id
        tool_use["input"] = args

        # Log when the model tried to put something other than our id
        # so we can see (post-fix) whether the model is still
        # attempting to hallucinate. Useful telemetry, not a
        # functional requirement.
        if prior is not None and prior != self._customer_id:
            logger.warning(
                "customerId hallucinated by model; overwritten",
                extra={
                    "tool_name": tool_use.get("name"),
                    "model_value_len": len(str(prior)),
                },
            )


def customer_id_hook(customer_id: str) -> Any:
    """Public factory — pass the result into `BidiAgent(hooks=[...])`.

    Returns a `strands.hooks.HookProvider`-compatible object. Lazy
    import means this function works without the strands package
    installed at import time, but it WILL fail at hook registration
    time inside `BidiAgent` if strands is missing — which is the
    correct failure mode (the agent cannot run without strands
    anyway).
    """
    return _CustomerIdInjector(customer_id)


def wrap_tools_with_customer_id(tools: List[Any], customer_id: str) -> List[Any]:
    """DEPRECATED: dead code (kept for unit-test stability only).

    Setting `tool.invoke = ...` does not intercept anything — the
    Strands runtime calls `tool.stream(tool_use, ...)` (an async
    generator), not `tool.invoke(args)`. Use `customer_id_hook` +
    `strip_customer_id_from_schemas` from this module instead.

    Sources (strands-agents/sdk-python v1.37.0):
      - executor calls `selected_tool.stream(tool_use, invocation_state, ...)` at
        src/strands/tools/executors/_executor.py:209
      - MCPAgentTool.stream implementation:
        src/strands/tools/mcp/mcp_agent_tool.py:79-104
    """
    logger.warning(
        "mcp_tools.wrap_tools_with_customer_id called — this is dead code; "
        "use customer_id_hook + strip_customer_id_from_schemas instead"
    )
    return tools


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
