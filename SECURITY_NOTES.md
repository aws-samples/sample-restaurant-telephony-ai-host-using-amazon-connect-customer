# Security notes — IAM wildcard justifications

## Purpose

This document catalogs every `Resource: '*'` (or otherwise broad) IAM grant in this Guidance, the AWS-service reason the wildcard is required, and any condition keys that further scope the grant. It exists so a security reviewer can verify in one pass that each wildcard is justified by an AWS service limitation and scoped to the minimum privilege the workload requires.

Every wildcard listed here is also annotated inline at its declaration site and registered with a `cdk-nag` `AwsSolutions-IAM5` suppression carrying the same justification.

## Cross-reference

| File | Line | Action(s) | Why the wildcard is required |
|------|------|-----------|------------------------------|
| `backend/agentcore-gateway/cdk/lib/cdk-stack.ts` | 132 | `bedrock-agentcore:CreateGateway`, `DeleteGateway`, `GetGateway`, `UpdateGateway`, `CreateGatewayTarget`, `DeleteGatewayTarget`, `GetGatewayTarget`, `ListGateways`, `ListGatewayTargets`, `SynchronizeGatewayTargets`, `UpdateGatewayTarget`, `CreateWorkloadIdentity`, `DeleteWorkloadIdentity`, `GetWorkloadIdentity`, `ListWorkloadIdentities` | Amazon Bedrock AgentCore management APIs do not support resource-level IAM. The grant is account-scoped through the provisioner Lambda's execution role; that role is in turn assumable only by AWS Lambda and is short-lived (custom-resource lifecycle). The `iam:PassRole` companion grant is scoped to the single `${prefix}-gateway-service-role` ARN. |
| `backend/agentcore-runtime-telephony/cdk/runtime/lib/runtime-stack.ts` | 301 | `ecr:GetAuthorizationToken` | AWS service mandate: this action is account-scoped and does not support resource-level IAM. The image-pull APIs (`BatchGetImage`, `GetDownloadUrlForLayer`) are scoped to the agent's repository ARN; only the auth-token call requires `*`. |
| `backend/agentcore-runtime-telephony/cdk/runtime/lib/runtime-stack.ts` | 384 | `cloudwatch:PutMetricData` | AWS service mandate: `PutMetricData` does not support resource-level IAM. The grant is conditioned with `StringEquals` on `cloudwatch:namespace = bedrock-agentcore`, the canonical least-privilege pattern documented by AWS. |
| `backend/agentcore-runtime-telephony/cdk/runtime/lib/runtime-stack.ts` | 403 | `xray:PutTraceSegments`, `xray:PutTelemetryRecords`, `xray:GetSamplingRules`, `xray:GetSamplingTargets` | AWS service mandate: AWS X-Ray actions are account-scoped and do not support resource-level IAM. |
| `telephony-interface/telephony-ingress/cdk/lib/ingress-stack.ts` | 160 | `logs:CreateLogGroup` | The grant is partially scoped to `arn:aws:logs:${region}:${account}:*`, which limits creation to the account+region pair. AWS does not allow resource-level IAM for `CreateLogGroup` because the resource does not exist yet at the time the action is evaluated. The `logs:PutLogEvents` and `logs:CreateLogStream` companion grants are scoped to the SMA Lambda's specific log-group ARN. |
| `telephony-interface/telephony-ingress/cdk/lib/ingress-stack.ts` | 374 | `chime-sdk-voice:*`, `chime:*` | These are internal grants on custom-resource Lambdas owned by the [`cdk-amazon-chime-resources`](https://github.com/cdklabs/cdk-amazon-chime-resources) library, not on user-owned roles. The library uses these wildcards to provision the Voice Connector, the SIP Media Application, the SIP rule, and the phone number — none of these Amazon Chime SDK control-plane APIs support resource-level IAM at create time. The custom-resource Lambdas exist only during stack create and update operations. |
| `backend/network/lib/network-stack.ts` | 117 | Egress to `0.0.0.0/0` on TCP 443 and UDP 1024-65535 | The agent security group needs HTTPS egress to AWS service endpoints (Bedrock, Chime SDK, S3, ECR, CloudWatch, SSM) — there is no per-service IP range to scope to without using AWS-managed prefix lists, which require ongoing maintenance. UDP 1024-65535 egress was originally for KVS TURN traffic (r5 architecture); it is dead in r7 but kept as a no-op pending a separate cleanup pass. |
| `telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts` | 291 | `ecr:GetAuthorizationToken` | AWS service mandate; same rationale as runtime-stack.ts line 301. The CodeBuild build role uses this only to obtain temporary credentials for `docker login` against the SIP gateway's image repository. All other ECR actions are scoped to the repository ARN. |
| `telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts` | 619 | `cloudwatch:PutMetricData` | AWS service mandate; same rationale as runtime-stack.ts line 384. The grant is conditioned with `StringEquals` on `cloudwatch:namespace = ${prefix}/SipGateway`. |
| `telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts` | 644 | `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`, `ssmmessages:OpenControlChannel`, `ssmmessages:OpenDataChannel` | AWS service mandate: ECS Exec session-manager actions do not support resource-level IAM. The grant is scoped to the SIP gateway task role; the role is otherwise constrained by the task security group's lack of any inbound rule on port 443 (the channel direction is outbound from the task). ECS Exec is enabled only when an operator runs `aws ecs execute-command` against a specific task in this cluster. |
| `telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts` | 672 | `ec2:DescribeNetworkInterfaces`, `ecs:DescribeTasks` | AWS service mandate: both `Describe*` actions are read-only and do not support resource-level IAM. The SIP gateway task uses them at startup to discover the task's own auto-assigned public IP address (so it can advertise the address in the SDP `c=` line per requirement R29). These read-only actions cannot modify resources. |

## Defense-in-depth context

The security model relies on multiple layers, not on IAM scoping alone. The following controls are documented in design §20 and tested at synth time:

- **R27 — UDP media ingress** is locked to the five Amazon Chime SDK Voice Connector source CIDRs only. The security group blocks all `0.0.0.0/0` ingress on every protocol and port. Synth-time Jest assertion blocks deploy on drift.
- **R28 — TCP 5060 SIP ingress** to the Fargate task is locked to the Network Load Balancer security group only.
- **R29 — Task public IP advertisement** is the canonical pattern for direct media; the SDP `c=` line carries the task's own ENI public IP (not a load balancer EIP).
- **R31 — Chime VC source CIDRs** are pinned to constants in `sip-gateway-stack.ts` with a quarterly drift review documented in `backend/drachtio-sip-gateway/README.md`.
- **All ten new IAM roles** declared by this Guidance use explicit per-statement grants with documented suppressions where the action does not support resource-level IAM.
- **`cdk-nag` runs at synth time on every stack** (per non-functional requirement NFR13). Every suppression carries a written justification that maps to a row in the table above.

## Secrets handling

The SIP gateway task requires a shared secret for the drachtio admin TCP/9022 loopback socket. The secret is provisioned in **AWS Secrets Manager** with an auto-generated 32-character value at stack creation, and is exposed to the container as the `DRACHTIO_SECRET` environment variable through the ECS task definition `Secrets:` field. By design, the secret value is not exposed in the task definition, CloudFormation events, or log output — only the secret ARN is visible.

The execution role holds the only `secretsmanager:GetSecretValue` grant, scoped to the secret's exact ARN, and is assumable only by `ecs-tasks.amazonaws.com`.

Automatic rotation is intentionally not scheduled for this secret (`AwsSolutions-SMG4` suppressed with written justification in `sip-gateway-stack.ts`): the secret protects an in-task loopback socket on TCP/9022 with no security-group ingress from outside the container, so rotation provides no incremental security benefit while the loopback-only posture holds.

The pseudonymous-customer-id pepper used by the agent runtime is provisioned in **AWS Systems Manager Parameter Store** as a `SecureString`, with the parameter ARN granted to the agent runtime role only. Both control-plane endpoints (Secrets Manager and Parameter Store SecureString) are encrypted at rest with AWS-managed keys.

## Network egress note (network-stack.ts line 117)

The agent security group's egress rules to `0.0.0.0/0` are the residual r5-era posture from when the agent ran inside the VPC and needed direct access to AWS service endpoints over both HTTPS and UDP. Under r7, the agent runs as an Amazon Bedrock AgentCore Runtime container whose network is managed by AWS, not as a Fargate task using this security group. The egress rules are therefore not on a hot path. They are kept (rather than removed) so the network stack remains usable for any future Fargate workload that needs the same egress profile, and so the change is logically separate from the security-review patch series.

A future pass should split this stack so the agent-side egress rules can be removed cleanly without affecting the SIP gateway.

## Reviewer checklist

For each row above, the reviewer should confirm:

1. The action(s) listed truly do not support resource-level IAM (verify against the [AWS service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/)).
2. Where a condition key is documented (CloudWatch namespace, log-group ARN, etc.), the rendered CloudFormation template carries the condition.
3. The action is read-only, account-scoped, or otherwise non-destructive.

If any row fails the check, file an issue against the project — do not deploy.
