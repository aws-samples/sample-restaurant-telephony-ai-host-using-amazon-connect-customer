/**
 * CloudFormation custom-resource handlers for the CodeBuild start-build
 * and build-complete-waiter pattern.
 *
 * Flow (CDK Provider framework):
 *   1. `onEvent` receives Create / Update from CFN. It calls
 *      `codebuild:StartBuild` and returns the build id as `PhysicalResourceId`.
 *   2. The Provider polls `isComplete` every 30s for up to 60 min. Each call
 *      does a `codebuild:BatchGetBuilds` on the buildId; returns `IsComplete: true`
 *      only on terminal `SUCCEEDED`. SUCCEEDED → success. Any FAILED /
 *      STOPPED / FAULT / TIMED_OUT / throttled state raises so CFN rolls the
 *      custom resource back (which in turn fails the stack) — that satisfies
 *      design §13 F7 "stack creation fails with the CodeBuild log stream URL
 *      in the error".
 *   3. On Delete, the handler is a no-op (buildId is a historical artifact;
 *      ECR lifecycle policy on the image repo handles cleanup).
 *
 * No E.164 is ever touched here so NFR9 is trivially satisfied. All logging
 * goes to CloudWatch via console.*; the Provider framework captures stdout.
 */
import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';

type OnEventRequest = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    ProjectName: string;
    // Cache-buster so CFN re-invokes `onEvent` on every stack update.
    TriggerHash?: string;
  };
  PhysicalResourceId?: string;
};

type OnEventResponse = {
  PhysicalResourceId: string;
  Data?: { BuildId: string };
};

type IsCompleteRequest = {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId: string;
  ResourceProperties: { ProjectName: string };
};

type IsCompleteResponse = {
  IsComplete: boolean;
  Data?: { BuildStatus: string };
};

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const client = new CodeBuildClient({ region: REGION });

/**
 * Kick off the CodeBuild build. Returns the buildId as PhysicalResourceId so
 * subsequent `isComplete` invocations can poll the same build.
 *
 * On Delete: no-op — the build is a historical record.
 */
export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  console.log('build-waiter onEvent', JSON.stringify({ RequestType: event.RequestType }));

  if (event.RequestType === 'Delete') {
    // Preserve the existing physical id so CFN doesn't try to "replace" the resource.
    return { PhysicalResourceId: event.PhysicalResourceId ?? 'deleted' };
  }

  const projectName = event.ResourceProperties.ProjectName;
  if (!projectName) {
    throw new Error('ProjectName is required');
  }

  const startResp = await client.send(new StartBuildCommand({ projectName }));
  const buildId = startResp.build?.id;
  if (!buildId) {
    throw new Error('CodeBuild StartBuild returned no build id');
  }

  console.log('build-waiter StartBuild succeeded', JSON.stringify({ buildId }));
  return {
    PhysicalResourceId: buildId,
    Data: { BuildId: buildId },
  };
}

/**
 * Poll one CodeBuild build and return IsComplete:true only when it reaches
 * SUCCEEDED. Any failure state throws — CFN rolls the custom resource back.
 *
 * On Delete: always complete (no-op).
 */
export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  console.log('build-waiter isComplete', JSON.stringify({
    RequestType: event.RequestType,
    PhysicalResourceId: event.PhysicalResourceId,
  }));

  if (event.RequestType === 'Delete') {
    return { IsComplete: true };
  }

  const resp = await client.send(new BatchGetBuildsCommand({ ids: [event.PhysicalResourceId] }));
  const build = resp.builds?.[0];
  if (!build) {
    throw new Error(`BatchGetBuilds returned no build for id ${event.PhysicalResourceId}`);
  }

  const status = build.buildStatus;
  console.log('build-waiter poll', JSON.stringify({ buildId: event.PhysicalResourceId, status }));

  switch (status) {
    case 'SUCCEEDED':
      return { IsComplete: true, Data: { BuildStatus: status } };
    case 'IN_PROGRESS':
      return { IsComplete: false };
    case 'FAILED':
    case 'FAULT':
    case 'STOPPED':
    case 'TIMED_OUT':
    default:
      // Any non-SUCCEEDED terminal state fails the stack with a clear message
      // including the CloudWatch Logs link (design §13 F7).
      throw new Error(
        `CodeBuild build ${event.PhysicalResourceId} ended in ${status ?? 'UNKNOWN'}. ` +
          `Logs: ${build.logs?.deepLink ?? '(no logs link)'}`,
      );
  }
}
