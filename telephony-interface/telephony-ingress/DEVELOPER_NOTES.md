# Developer Notes — Telephony Ingress

The `cdk/` subdir is an independent CDK app. It depends on `cdk-amazon-chime-resources@^3` (CDK Labs, MIT) and is not deployable until the upstream `${DeploymentPrefix}-AgentRuntimeStack` has written its outputs to `cdk-outputs/tel-agent-runtime.json`.

The SMA Lambda source will live in `cdk/lambda/sma-handler/` (task 6.1).
