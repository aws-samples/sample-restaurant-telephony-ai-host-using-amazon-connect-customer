# Telephony Network Stack

**Stack name (CloudFormation):** `NetworkStack`.
The deployment prefix is **not** in the stack name — it flows in as a `CfnParameter` and gets baked into physical resource names (VPC tag, security group name) inside the stack.

## Inputs (CfnParameters)

- `DeploymentPrefix` — 1-20 chars, lowercase, must start with a letter. Regex: `^[a-z][a-z0-9-]{1,19}$`. Applied to the VPC `Name` tag (`${DeploymentPrefix}-vpc`) and the security group name (`${DeploymentPrefix}-agent-sg`).

## Outputs (CfnOutputs, NO `exportName`)

| Output | Value | Consumed by |
|---|---|---|
| `VpcId` | `vpc.vpcId` | `AgentRuntimeStack:VpcId` |
| `PrivateSubnetIds` | Comma-delimited list of 2 private subnet ids | `AgentRuntimeStack:PrivateSubnetIds` (as `CommaDelimitedList`) |
| `AgentSecurityGroupId` | Egress-only SG: 443/tcp + UDP 1024-65535 | `AgentRuntimeStack:AgentSecurityGroupId` |

Consumers read these via `scripts/deploy-all.sh` + `cdk-outputs/tel-network.json`. No CloudFormation Export is declared — wiring is one-way at deploy time.

## Resources

- `ec2.Vpc` with 2 AZs, private-with-egress subnets + NAT gateways (per design §3#3 and §9.1).
- `ec2.SecurityGroup` with egress 443/tcp (all) and UDP 1024-65535 (all) for the agent runtime's outbound traffic (Bedrock, Chime, KVS, S3 via NAT; UDP for any future WebRTC fallback).

## Deploy

Via `scripts/deploy-all.sh` in the workspace root, or manually:

```bash
cd backend/network
npm install
npx cdk deploy NetworkStack \
  --require-approval never \
  --parameters NetworkStack:DeploymentPrefix=qsr-tel \
  --outputs-file ../../cdk-outputs/tel-network.json
```

## cdk-nag

`AwsSolutionsChecks` is applied in `bin/cdk.ts`. One documented suppression:

- **AwsSolutions-VPC7** — VPC Flow Logs disabled for MVP. Justification: agent traffic is service-API over NAT; CloudTrail + per-service access logs cover forensics. Enable flow logs when a compliance reviewer requires network-layer logging.
