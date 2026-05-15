# Telephony Agent ECR Stack

**Stack name:** `${DeploymentPrefix}-AgentEcrStack`

**Inputs (CfnParameters):**
- `DeploymentPrefix` — 1-20 chars, lowercase, must start with a letter.

**Outputs (CfnOutputs, NO `exportName`):**
- `AgentEcrRepoUri`
- `AgentEcrRepoArn`

**Consumers:** `${DeploymentPrefix}-AgentBuildStack` (both values) and `${DeploymentPrefix}-AgentRuntimeStack` (URI only).

**Implementation status:** stub. Task 4.1 in `.kiro/specs/telephony-voice-ordering-agent/tasks.md` adds the real ECR repository with `imageScanOnPush=true` and lifecycle rule `keepLast: 10`.

## Production hardening

This stack ships dev-friendly defaults.  Before taking it to production, review:

### ECR repository removal policy

Default: `RemovalPolicy.DESTROY` + `emptyOnDelete: true`.  A stack teardown (or failed deploy that auto-rolls-back) will delete the repo AND every image in it.

For production, change the repository declaration in `lib/ecr-stack.ts` to:

```ts
const repo = new ecr.Repository(this, 'AgentRepo', {
  repositoryName: cdk.Fn.sub('${P}-agent', { P: prefix }),
  imageScanOnPush: true,
  imageTagMutability: ecr.TagMutability.MUTABLE,
  emptyOnDelete: false,                       // preserve images on destroy
  removalPolicy: cdk.RemovalPolicy.RETAIN,    // preserve repo on destroy
  lifecycleRules: [
    { description: 'Retain only the 10 most recent images', maxImageCount: 10, rulePriority: 1 },
  ],
});
```

Rationale: if a rollback deletes the ECR repo, every AgentCore Runtime session pulling the image fails and the runtime becomes un-recoverable without re-running CodeBuild (~10 min).  In dev the rebuild is cheap; in prod you want image history intact so rolling back to a known-good tag is a one-line change.
