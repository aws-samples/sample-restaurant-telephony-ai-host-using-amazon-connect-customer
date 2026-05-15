# SipGatewayStack

drachtio-server + Node.js SIP gateway for the telephony voice ordering
agent (r7 architecture). Bridges Session Initiation Protocol (SIP) +
Real-time Transport Protocol (RTP) from the Chime SDK Voice Connector
into a SigV4-signed WebSocket to the Amazon Bedrock AgentCore Runtime.

The container speaks RTP directly with Chime — no separate media engine.
Earlier prototypes used FreeSWITCH plus mod_audio_stream; the same
audio-frame envelope shape is preserved on the WebSocket so the
server-side agent stayed unchanged across the cutover.

Architecture: see `.kiro/specs/telephony-voice-ordering-agent/design.md`
§14-§22 (r6 + r7 addenda).

## Inputs (CfnParameters)

| Name | Type | Validator | Description |
|---|---|---|---|
| `DeploymentPrefix` | String | `^[a-z][a-z0-9-]{1,19}$` | Shared project prefix. |
| `VpcId` | String | non-empty | VPC from `${prefix}-NetworkStack` (threaded from `cdk-outputs/tel-network.json`). |
| `PrivateSubnetIds` | CommaDelimitedList | non-empty | Private subnets for the build-time CodeBuild project. |
| `PublicSubnetIds` | CommaDelimitedList | non-empty | Public subnets for the Fargate tasks (each task gets an auto-assigned public IP for direct RTP). |
| `AgentRuntimeArn` | String | non-empty | AgentCore Runtime ARN the SIP gateway tasks connect to via SigV4 WebSocket. |
| `CallLifetimeSeconds` | Number | 60 ≤ n ≤ 3600 | Maximum per-call duration. Default 600. |
| `MaxTasksPerService` | Number | 1 ≤ n ≤ 50 | Fargate service autoscaling upper bound. Default 10. |
| `AgentVoiceId` | String | one of `matthew`, `tiffany`, `amy` | Nova Sonic voice id passed to AgentCore Runtime. Default `tiffany`. |

## Outputs (no exportName, per P5)

| Logical id | Consumer |
|---|---|
| `NlbDnsName` | `${prefix}-IngressStack` (VC origination route target). |
| `NlbHostedZoneId` | Optional - downstream Route53 alias setups. |
| `SipGatewayEcrRepoUri` | Operator observability / rollback tag lookup. |
| `BuildWaiterArn` | Reserved for downstream DependsOn handles. |
| `SipGatewayServiceName` / `SipGatewayClusterName` | Operator observability. |

## Resources provisioned

- ECR repository `${prefix}-sip-gateway` for the SIP gateway container image.
- CodeBuild project that builds the ARM64 image from
  `backend/drachtio-sip-gateway/` (drachtio-server compiled from
  https://github.com/drachtio/drachtio-server, rtpengine compiled from
  https://github.com/sipwise/rtpengine, plus a Node.js application).
- ECS cluster + Fargate service running in the NetworkStack VPC's public
  subnets with auto-assigned public IPs (r7: each task advertises its
  own ENI public IP in SDP `c=` so Chime sends RTP directly to the
  task, bypassing the NLB).
- Internet-facing Network Load Balancer on TCP/5060 (SIP signaling).
- Application autoscaling with target-tracking on a custom CloudWatch
  metric `${prefix}/SipGateway/ActiveCalls` emitted every 30 s from each
  task. Target value 6 calls/task. Min 2 tasks, max set by parameter.

## Deploy

Invoked from `scripts/deploy-all.sh` Layer 9b (between AgentRuntime and
IngressNumber). For a manual one-off:

```bash
cd telephony-interface/telephony-sip-gateway/cdk
npx cdk deploy SipGatewayStack \
  --parameters SipGatewayStack:DeploymentPrefix=dev \
  --parameters SipGatewayStack:VpcId=<from tel-network.json> \
  --parameters SipGatewayStack:PrivateSubnetIds=<csv from tel-network.json> \
  --parameters SipGatewayStack:PublicSubnetIds=<csv from tel-network.json> \
  --parameters SipGatewayStack:AgentRuntimeArn=<from tel-agent-runtime.json> \
  --parameters SipGatewayStack:CallLifetimeSeconds=600 \
  --parameters SipGatewayStack:MaxTasksPerService=10 \
  --outputs-file ../../../cdk-outputs/tel-sip-gateway.json
```

## Production hardening

This stack ships dev-friendly defaults. Before taking it to production, review the following items and flip them as needed.

### ECR repository removal policy

Default: `RemovalPolicy.DESTROY` + `emptyOnDelete: true` on the
`${prefix}-sip-gateway` ECR repository. A stack teardown (or a failed
create-stack that auto-rolls back) will delete the repo AND every image
in it.

For production, change the repository declaration in
`lib/sip-gateway-stack.ts` to:

```ts
const imageRepo = new ecr.Repository(this, 'SipGatewayRepo', {
  repositoryName: cdk.Fn.sub('${P}-sip-gateway', { P: prefix }),
  imageScanOnPush: true,
  imageTagMutability: ecr.TagMutability.MUTABLE,
  emptyOnDelete: false,                       // preserve images on destroy
  removalPolicy: cdk.RemovalPolicy.RETAIN,    // preserve repo on destroy
  lifecycleRules: [
    { description: 'Retain only the 10 most recent images', maxImageCount: 10, rulePriority: 1 },
  ],
});
```

Same edit applies to `backend/agentcore-runtime-telephony/cdk/ecr/lib/ecr-stack.ts` (the agent image repo).

Why RETAIN+preserve in production: if a rollback deletes the ECR repo,
every Fargate task trying to pull the image fails with
`ImagePullBackOff` and the service becomes unrecoverable without
re-running CodeBuild. In dev, the 10-minute CodeBuild rebuild is cheap
and predictable; in production, the image history needs to stay intact
so rolling back to a known-good image is a one-line change.

### Chime Voice Connector encryption

Default: `encryption: false` on the VC. For production, set
`encryption: true` AND verify all origination routes are
`Protocol.TCP` (the library rejects UDP origination on an
encryption-enabled VC). The current code already uses TCP, so this is a
one-flag flip.

### NLB access logs

Default: NLB access logs DISABLED (cdk-nag AwsSolutions-ELB2
suppression). SIP signaling is already captured in container logs
(CloudWatch Logs via the awslogs driver); UDP RTP under r7 bypasses the
NLB entirely so it cannot be logged there. For production, consider
enabling access logs anyway for the TCP/5060 path to have a second
source of truth independent of container logs.
