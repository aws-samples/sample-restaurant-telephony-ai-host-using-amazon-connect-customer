# Telephony AgentCore Runtime

This module holds the three independent CDK apps that build and host the telephony agent container, plus the agent's own source tree.

## Layout

| Path | Stack (CloudFormation name) | Purpose |
|---|---|---|
| `cdk/ecr/` | `AgentEcrStack` | ECR repository `${DeploymentPrefix}-agent` with scan-on-push and a keep-last-10 lifecycle rule. |
| `cdk/build/` | `AgentBuildStack` | Source S3 bucket + ARM64 CodeBuild project + a build waiter custom resource. The buildspec installs Python packages from `requirements.txt`, diffs the resolved set against `requirements.lock`, builds a `linux/arm64` image with `docker buildx`, and pushes to ECR. |
| `cdk/runtime/` | `AgentRuntimeStack` | `AWS::BedrockAgentCore::Runtime` with `protocolConfiguration=HTTP` and `networkMode=VPC`; the `CustomerIdPepper` SSM `SecureString` custom resource; the playback S3 bucket (1-hour lifecycle); and the fallback apology WAV upload. |
| `agent/` | (source) | FastAPI + Strands `BidiAgent` + Nova Sonic + KVS reader + Chime `PlayAudio` client + MCP client. Python 3.13. Built by `AgentBuildStack` — **not** installed on developer workstations (NFR4). |

Each `cdk/*` dir is a fully self-contained CDK app with its own `package.json`, `cdk.json`, `tsconfig.json`, and `bin/cdk.ts`. There is no root or workspace `package.json`. `scripts/deploy-all.sh` deploys the three stacks in order (ecr → build → runtime) and threads cross-stack values via `cdk-outputs/*.json` + `--parameters Stack:Key=Value` — no CloudFormation Exports, no `Fn::ImportValue`.

## Deploy

Automated via the workspace-root `scripts/deploy-all.sh`. For manual invocation see `cdk/ecr/README.md`, `cdk/build/README.md`, and `cdk/runtime/README.md`.

## Pepper Rotation

The `customer_id` field sent with every MCP tool call is derived as:

```
customer_id = "pstn-" + sha256(E164 || pepper).hexdigest()[:16]
```

where `pepper` is a 32-byte random value stored in SSM Parameter Store at
`/{DeploymentPrefix}/customer-id-pepper` (SecureString, KMS-encrypted).

The pepper is provisioned by the `CustomerIdPepper` custom resource in
`{prefix}-AgentRuntimeStack` on first deploy. Rotating it invalidates every
previously-derived `customer_id` — upstream systems keyed on `customer_id`
will see a new identifier for the same caller. Only rotate for a documented
compromise or at a scheduled window you have coordinated downstream.

### When to rotate

- Suspected pepper compromise (parameter access by an unknown principal, logs
  or CloudTrail entries you cannot account for).
- Scheduled rotation as part of a broader security-hygiene runbook (quarterly
  or annually, depending on your policy).

### How to rotate

1. **Coordinate downstream.** Any system that stores `customer_id` as a
   lookup key will lose the link to the caller's historical records after
   rotation. The tool-call body still carries `fromPhoneNumber` (unless
   anonymous), so re-linking is possible but is a manual one-off per caller.

2. **Delete the existing SSM parameter.** From the account's shell with
   SSM write permissions:

   ```bash
   aws ssm delete-parameter \
     --name "/${DeploymentPrefix}/customer-id-pepper" \
     --region "${AWS_REGION}"
   ```

3. **Redeploy the runtime stack.** The `CustomerIdPepper` custom resource's
   `Delete` handler is idempotent and tolerates the parameter already being
   absent; the `Create` handler regenerates a fresh 32-byte random value:

   ```bash
   ./scripts/deploy-all.sh --deploymentPrefix ${DeploymentPrefix} --force-deploy
   ```

   (Or target the runtime stack directly with `cdk deploy` from
   `backend/agentcore-runtime-telephony/cdk/runtime/` — both paths trigger
   the custom resource to re-create the SSM parameter.)

4. **Verify.** The new pepper is live once the stack reaches
   `UPDATE_COMPLETE`. AgentCore Runtime sessions read the pepper at the
   time they process each inbound call, so new calls will use the new
   pepper on their next session start.

### In-flight calls

Existing `CallSession`s hold their `customer_id` in memory for the lifetime
of the call (from `pstn_start` to `pstn_end`). A rotation that lands mid-call
does NOT re-derive the identifier for that call — the session keeps the
`customer_id` it was created with. Only calls that start **after** the
AgentCore Runtime process picks up the new pepper will derive with the new
value.

AgentCore reads the pepper via `ssm:GetParameter(WithDecryption=true)` at
call start (see `agent/pstn_customer.py:_load_pepper`), so the refresh window
is at most the duration of a single call. No container restart is required.

### Auditing

- SSM parameter changes show up in CloudTrail as
  `PutParameter` / `DeleteParameter` events with the parameter name
  (the **value** is never logged, per SSM's SecureString contract).
- The pepper value itself never appears in any CloudFormation output, log
  line, or metric — only its **parameter name** is published on the
  `CustomerIdPepperParameterName` stack output for operator reference.
