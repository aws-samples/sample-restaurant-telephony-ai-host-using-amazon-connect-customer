# Developer Notes — Telephony Network Stack

## Scope

This CDK app is a **fully self-contained** application. It owns its own `package.json`, `cdk.json`, `tsconfig.json`, and `node_modules`. It does NOT share dependencies with any other new-module CDK dir in this repo — `scripts/deploy-all.sh` calls `safe_npm_install` which cleans `node_modules` in sibling dirs between layers to respect CloudShell's 1 GB home-dir limit.

## Cross-stack wiring

This stack receives the `DeploymentPrefix` value as a CloudFormation Parameter (NOT a CDK context value). `scripts/deploy-all.sh` threads it via:

```bash
npx cdk deploy --parameters "${PROJECT_PREFIX}-NetworkStack:DeploymentPrefix=${PROJECT_PREFIX}"
```

This stack emits CfnOutputs **without** `exportName`. Downstream stacks do not use `Fn::ImportValue`; instead `scripts/deploy-all.sh` reads `cdk-outputs/tel-network.json` via the `json_val` helper and passes the values as `--parameters` to the next `cdk deploy`.

## Current state

Placeholder implementation only. Task 2 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md` replaces the stub with real VPC / subnet / NAT / security-group resources.
