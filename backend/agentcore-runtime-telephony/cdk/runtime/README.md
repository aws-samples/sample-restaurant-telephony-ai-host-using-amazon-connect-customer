# Telephony Agent Runtime Stack

**Stack name:** `${DeploymentPrefix}-AgentRuntimeStack`

**Inputs (CfnParameters):** `DeploymentPrefix`, `VpcId`, `PrivateSubnetIds`, `AgentSecurityGroupId`, `AgentEcrRepoUri`, `AgentCoreGatewayUrl`, `BuildWaiterArn`.

**Outputs (CfnOutputs, NO `exportName`):** `AgentRuntimeArn`, `PlaybackBucketName`.

**Consumer:** `${DeploymentPrefix}-IngressStack` reads both outputs as CfnParameters.

**Implementation status:** stub. Task 5 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md` adds the runtime IAM role, SSM pepper custom resource, playback S3 bucket, fallback WAV deployment, and `CfnRuntime` resource.
