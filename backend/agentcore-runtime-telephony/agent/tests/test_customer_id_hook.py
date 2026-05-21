"""Unit tests for the customer_id hook + schema stripper.

The hook is the load-bearing safety net that prevents an LLM-supplied
customerId from reaching downstream tools. These tests run without
strands installed: we exercise the hook callback directly with a
mock event object that quacks like `BidiBeforeToolCallEvent`.
"""
import asyncio
import pytest

import mcp_tools


class _MockEvent:
    """Quacks like BidiBeforeToolCallEvent for the hook callback."""

    def __init__(self, tool_use):
        self.tool_use = tool_use


class _MockMcpTool:
    """Quacks like the MCP tool wrapper exposed by Strands.

    Has a `mcp_tool` attribute carrying an inputSchema dict — the same
    shape `apply_basepath_workaround` and `strip_customer_id_from_schemas`
    rely on.
    """

    def __init__(self, schema):
        self.mcp_tool = type("InnerMcp", (), {"inputSchema": schema, "name": "fake"})()


# ───────── strip_customer_id_from_schemas ─────────


class TestStripCustomerIdFromSchemas:
    def test_removes_field_from_properties_and_required(self):
        schema = {
            "type": "object",
            "properties": {
                "customerId": {"type": "string"},
                "locationId": {"type": "string"},
            },
            "required": ["customerId", "locationId"],
        }
        tool = _MockMcpTool(schema)
        mcp_tools.strip_customer_id_from_schemas([tool])
        assert "customerId" not in schema["properties"]
        assert "customerId" not in schema["required"]
        assert "locationId" in schema["properties"]  # don't touch others
        assert "locationId" in schema["required"]

    def test_no_op_when_field_absent(self):
        schema = {
            "type": "object",
            "properties": {"locationId": {"type": "string"}},
            "required": ["locationId"],
        }
        tool = _MockMcpTool(schema)
        mcp_tools.strip_customer_id_from_schemas([tool])
        assert schema == {
            "type": "object",
            "properties": {"locationId": {"type": "string"}},
            "required": ["locationId"],
        }

    def test_handles_missing_required_list(self):
        schema = {
            "type": "object",
            "properties": {"customerId": {"type": "string"}},
            # no `required` key at all
        }
        tool = _MockMcpTool(schema)
        mcp_tools.strip_customer_id_from_schemas([tool])
        assert "customerId" not in schema["properties"]

    def test_skips_tools_with_no_input_schema(self):
        # Tool whose getattr chain returns None — must not raise.
        bad_tool = type("X", (), {})()
        mcp_tools.strip_customer_id_from_schemas([bad_tool])  # no exception


# ───────── _CustomerIdInjector ─────────


class TestCustomerIdHookCallback:
    def test_overwrites_hallucinated_value(self):
        hook = mcp_tools.customer_id_hook("pstn-abcdef0123456789")
        event = _MockEvent({"name": "GetPreviousOrders", "input": {"customerId": "Jane Doe"}})
        asyncio.run(hook._on_before_tool_call(event))
        assert event.tool_use["input"]["customerId"] == "pstn-abcdef0123456789"

    def test_overwrites_when_model_omitted_field(self):
        hook = mcp_tools.customer_id_hook("pstn-abcdef0123456789")
        event = _MockEvent({"name": "GetMenu", "input": {"locationId": "loc-1"}})
        asyncio.run(hook._on_before_tool_call(event))
        assert event.tool_use["input"]["customerId"] == "pstn-abcdef0123456789"
        assert event.tool_use["input"]["locationId"] == "loc-1"  # don't lose other fields

    def test_handles_input_not_a_dict(self):
        hook = mcp_tools.customer_id_hook("pstn-abcdef0123456789")
        # Some pathological model emit-shape — input is None or a string.
        event = _MockEvent({"name": "GetCart", "input": None})
        asyncio.run(hook._on_before_tool_call(event))
        assert event.tool_use["input"] == {"customerId": "pstn-abcdef0123456789"}

    def test_unconditional_overwrite_even_when_model_passes_correct_value(self):
        # Even if the model happens to pass our exact id, we overwrite —
        # that's cheaper than checking and removes a class of subtle bugs.
        hook = mcp_tools.customer_id_hook("pstn-abcdef0123456789")
        event = _MockEvent({
            "name": "GetCart",
            "input": {"customerId": "pstn-abcdef0123456789"},
        })
        asyncio.run(hook._on_before_tool_call(event))
        assert event.tool_use["input"]["customerId"] == "pstn-abcdef0123456789"

    def test_rejects_empty_customer_id(self):
        with pytest.raises(ValueError):
            mcp_tools.customer_id_hook("")


# ───────── deprecation guard ─────────


def test_wrap_tools_with_customer_id_is_dead_code():
    """The old wrapper should still return the tools unchanged so any
    legacy caller won't crash, but it should not mutate them."""
    tool = _MockMcpTool({"properties": {"customerId": {"type": "string"}}})
    out = mcp_tools.wrap_tools_with_customer_id([tool], "pstn-1234")
    assert out == [tool]  # same object, no wrapping
    # Confirm no `invoke` was set on the tool.
    assert not hasattr(tool, "invoke")
