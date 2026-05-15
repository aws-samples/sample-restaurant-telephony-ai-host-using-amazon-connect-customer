# Telephony Agent Build Stack

**Stack name:** `${DeploymentPrefix}-AgentBuildStack`

**Inputs (CfnParameters):**
- `DeploymentPrefix`
- `AgentEcrRepoUri` (from upstream `tel-agent-ecr.json`)
- `AgentEcrRepoArn` (from upstream `tel-agent-ecr.json`)

**Outputs (CfnOutputs, NO `exportName`):**
- `AgentCodeBuildProjectName`
- `AgentCodeBuildProjectArn`
- `AgentSourceBucketName`
- `BuildWaiterArn`

**Implementation status:** stub. Task 4.2 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md` adds the source S3 bucket, CodeBuild ARM64 project, bucket deployment + start-build + build waiter.
