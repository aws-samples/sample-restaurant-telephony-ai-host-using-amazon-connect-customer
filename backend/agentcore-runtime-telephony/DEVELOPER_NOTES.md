# Developer Notes — Telephony AgentCore Runtime

Three independent CDK apps (`cdk/ecr`, `cdk/build`, `cdk/runtime`) plus an `agent/` source tree (added in task 3). Each CDK app has its own `node_modules`; `safe_npm_install` in `scripts/deploy-all.sh` cleans sibling dirs between layers (CloudShell 1 GB home-dir constraint).

See each subdir's own `DEVELOPER_NOTES.md` for stack-specific details.
