# Developer Notes — Telephony Agent Build Stack

Self-contained CDK app. `scripts/deploy-all.sh` threads `AgentEcrRepoUri` and `AgentEcrRepoArn` from `cdk-outputs/tel-agent-ecr.json` into this stack as CfnParameters. Outputs carry NO `exportName`; downstream consumers receive `BuildWaiterArn` as a CfnParameter threaded via `--parameters`.

Placeholder only — see task 4.2 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md`.
