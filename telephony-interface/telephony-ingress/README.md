# Telephony Ingress

The public-facing telephony entry point. The `cdk/` subdir is a single CDK app that provisions (via `cdk-amazon-chime-resources@^3`) the Chime phone number, SIP Media Application, Voice Connector, SIP rule, and SMA Lambda handler.

Chime resources must live in `us-east-1` or `us-east-2` — this stack pins `us-east-1`.

## Stack

**Stack name (CloudFormation):** `IngressStack`.

## Inputs (CfnParameters)

- `DeploymentPrefix` — 1-20 chars, lowercase, must start with a letter. Regex: `^[a-z][a-z0-9-]{1,19}$`. Applied to the SMA name (`${DeploymentPrefix}-sma`), Voice Connector name (`${DeploymentPrefix}-vc`), SIP rule name, and SMA Lambda function name (`${DeploymentPrefix}-sma-handler`).
- `AgentRuntimeArn` — the `AWS::BedrockAgentCore::Runtime` ARN to invoke on `NEW_INBOUND_CALL` / `HANGUP`. Threaded in by `scripts/deploy-all.sh` from `cdk-outputs/tel-agent-runtime.json`.
- `PlaybackBucketName` — S3 bucket that the agent writes TTS WAV files to. The stack grants the Chime SDK SMA service principal `s3:GetObject` on keys matching `${DeploymentPrefix}/*`.

## Outputs (CfnOutputs, NO `exportName`)

| Output | Value | Consumed by |
|---|---|---|
| `PhoneNumberE164` | The provisioned Chime phone number (e.g. `+14155551234`) | `scripts/deploy-all.sh` — printed as the final success line. |
| `SipMediaApplicationId` | The Chime SMA id | Reference only. |

## Resources

- SMA Lambda (Node.js 24.x, esbuild via `NodejsFunction`): handles `NEW_INBOUND_CALL` (resolves the per-call KVS stream, invokes the AgentCore Runtime with `action:"pstn_start"`) and `HANGUP` (invokes `action:"pstn_end"`). Role `${DeploymentPrefix}-sma-lambda-role`.
- `ChimeVoiceConnector` with streaming configuration targeting Kinesis Video Streams.
- `ChimeSipMediaApplication` wired to the SMA Lambda.
- `ChimePhoneNumber` (US local, product type `SipMediaApplicationDialIn`).
- `ChimeSipRule` trigger `ToPhoneNumber` targeting the SMA.
- Bucket policy grant on `PlaybackBucketName` for the Chime SMA service principal.

## Deploy

Via `scripts/deploy-all.sh` in the workspace root, or manually:

```bash
cd telephony-interface/telephony-ingress/cdk
npm install
npx cdk deploy IngressStack \
  --require-approval never \
  --parameters IngressStack:DeploymentPrefix=qsr-tel \
  --parameters IngressStack:AgentRuntimeArn=<arn from tel-agent-runtime.json> \
  --parameters IngressStack:PlaybackBucketName=<bucket from tel-agent-runtime.json> \
  --outputs-file ../../../cdk-outputs/tel-ingress.json
```

## cdk-nag

`AwsSolutionsChecks` is applied in `bin/cdk.ts`. The `cdk-amazon-chime-resources` library ships its own internal custom-resource Lambdas for provisioning Chime objects — those trigger several framework-level findings. Stack-level suppressions (with written justifications) are in `bin/cdk.ts`:

- **AwsSolutions-IAM4** — `AWSLambdaBasicExecutionRole` on Chime library internals. Library-managed.
- **AwsSolutions-IAM5** — Residual wildcards: either unavoidable because the AWS service doesn't support resource-level IAM (`chime-sdk-voice:GetVoiceConnector`, `kinesisvideo:ListStreams`), or internal to library-managed Lambdas.
- **AwsSolutions-L1** — Our user-owned `NodejsFunction` pins `nodejs24.x`; library internals pin their own runtime.

Per-construct suppressions live in `lib/ingress-stack.ts`.
