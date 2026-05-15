# AgentCore Gateway — Developer Notes

## Provenance

This subtree is a **verbatim vendored copy** of `reference-project/backend/agentcore-gateway/` from the upstream QSR omnichannel sample. **No code changes** are made by the telephony-voice-ordering-agent feature — the MCP gateway, `AWS_IAM` authorization, and the 8 exposed backend tool endpoints (`GetCustomerProfile`, `GetMenu`, `AddToCart`, `GetCart`, `UpdateCart`, `PlaceOrder`, `GetPreviousOrders`, `GetNearestLocations`, `GeocodeAddress`, `FindLocationAlongRoute`) flow through unchanged.

Why reused as-is:

- The telephony variant's agent (`backend/agentcore-runtime-telephony/agent/telephony_agent.py`) uses the exact same MCP client pattern as the reference's `qsr_agent.py` — `list_tools_sync()` then `_strip_base_path_param(tools)` — so it sees the same tool surface.
- The `PlaceOrder` MCP tool body now carries three additional optional fields (`fromPhoneNumber`, `channel`, `anonymousCaller`) per design §2.1 "Single additive backend change" and property **P21**; those fields are accepted at the Gateway layer without schema changes because they are additive and defaulted in the `place-order` Lambda itself (see `backend/backend-infrastructure/lambda/place-order/index.js`).

If you need to sync this subtree against a newer upstream revision, re-copy it verbatim; no telephony-specific edits should be introduced here.

See requirements **R17.2**, **R17.4**, **R17.8** for the testable reuse contract.
