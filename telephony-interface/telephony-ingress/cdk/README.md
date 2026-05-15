# Telephony Ingress — CDK App

Single CDK app that deploys `IngressStack`. See the parent directory's [`README.md`](../README.md) for the full stack description, IAM/cdk-nag notes, and manual deploy recipe.

**Stack name (CloudFormation):** `IngressStack`
(The `DeploymentPrefix` flows in as a `CfnParameter` and gets baked into physical resource names — SMA, Voice Connector, SIP rule, Lambda — but NOT into the CloudFormation stack name itself.)

**Inputs (CfnParameters):**
- `DeploymentPrefix` — regex `^[a-z][a-z0-9-]{1,19}$`.
- `AgentRuntimeArn` — threaded from `cdk-outputs/tel-agent-runtime.json`.
- `PlaybackBucketName` — threaded from `cdk-outputs/tel-agent-runtime.json`.

**Outputs (no `exportName`):** `PhoneNumberE164`, `SipMediaApplicationId`.

## Layout

- `bin/cdk.ts` — `cdk.App` entry point. Applies `AwsSolutionsChecks` aspect and stack-level cdk-nag suppressions for `cdk-amazon-chime-resources` library internals.
- `lib/ingress-stack.ts` — stack definition. Declares the 3 CfnParameters, provisions the SMA Lambda + Chime VC/SMA/PhoneNumber/SipRule, emits the 2 outputs.
- `lambda/sma-handler/index.ts` — Chime SMA event handler (Node.js 24.x via `NodejsFunction`). Dispatches `NEW_INBOUND_CALL` → `InvokeAgentRuntime(action:"pstn_start")` and `HANGUP` → `InvokeAgentRuntime(action:"pstn_end")`. Retry-once-at-2s contract per R17.
