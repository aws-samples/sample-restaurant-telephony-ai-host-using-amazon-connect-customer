# Developer Notes — Telephony Agent ECR Stack

## Scope

Fully self-contained CDK app. Owns its `package.json`, `cdk.json`, `tsconfig.json`, `node_modules`. `scripts/deploy-all.sh`'s `safe_npm_install` helper cleans sibling `node_modules` dirs between layers (CloudShell 1 GB constraint).

## Cross-stack wiring

Emits `AgentEcrRepoUri` and `AgentEcrRepoArn` as CfnOutputs **without** `exportName`. `scripts/deploy-all.sh` extracts them from `cdk-outputs/tel-agent-ecr.json` via the `json_val` helper and threads them into downstream stacks as `--parameters`.

## Current state

Placeholder implementation only. Task 4.1 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md` replaces the stub with the real `ecr.Repository`.
