# Developer Notes — Telephony Ingress Stack

Self-contained CDK app. Uses `cdk-amazon-chime-resources@^3` (CDK Labs, MIT). Receives 3 CfnParameters from `scripts/deploy-all.sh` `--parameters` (values come from `cdk-outputs/tel-agent-runtime.json`). Emits outputs WITHOUT `exportName`; `PhoneNumberE164` is read by `deploy-all.sh` via `json_val` and printed in the final success line.

Chime resources must live in `us-east-1` or `us-east-2`.

Placeholder only — see task 6 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md`.
