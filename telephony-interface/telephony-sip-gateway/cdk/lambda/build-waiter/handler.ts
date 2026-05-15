/**
 * CloudFormation custom-resource handlers for the SipGatewayStack's
 * CodeBuild start-build and build-complete-waiter pattern.
 *
 * This handler is functionally identical to
 * `backend/agentcore-runtime-telephony/cdk/build/lambda/build-waiter/handler.ts`
 * — intentionally duplicated per r4 isolation (each CDK app bundles its own
 * Lambdas; no shared helper module that would cross stack boundaries).
 *
 * Flow (CDK Provider framework):
 *   1. `onEvent` receives Create/Update from CFN. Calls `codebuild:StartBuild`
 *      and returns the build id as `PhysicalResourceId`.
 *   2. Provider polls `isComplete` every 30 s for up to 60 min. Each poll does
 *      a `codebuild:BatchGetBuilds` on the buildId. Terminal SUCCEEDED → done;
 *      FAILED/STOPPED/FAULT/TIMED_OUT raises so CFN rolls back the custom
 *      resource (which fails the stack).
 *   3. On Delete: no-op.
 */
import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';

type OnEventRequest = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    ProjectName: string;
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

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  console.log(
    'sip-gateway build-waiter onEvent',
    JSON.stringify({ RequestType: event.RequestType }),
  );

  if (event.RequestType === 'Delete') {
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

  console.log('sip-gateway build-waiter StartBuild succeeded', JSON.stringify({ buildId }));
  return { PhysicalResourceId: buildId, Data: { BuildId: buildId } };
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  console.log(
    'sip-gateway build-waiter isComplete',
    JSON.stringify({
      RequestType: event.RequestType,
      PhysicalResourceId: event.PhysicalResourceId,
    }),
  );

  if (event.RequestType === 'Delete') {
    return { IsComplete: true };
  }

  const resp = await client.send(
    new BatchGetBuildsCommand({ ids: [event.PhysicalResourceId] }),
  );
  const build = resp.builds?.[0];
  if (!build) {
    throw new Error(
      `BatchGetBuilds returned no build for id ${event.PhysicalResourceId}`,
    );
  }

  const status = build.buildStatus;
  console.log(
    'sip-gateway build-waiter poll',
    JSON.stringify({ buildId: event.PhysicalResourceId, status }),
  );

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
      throw new Error(
        `CodeBuild build ${event.PhysicalResourceId} ended in ${status ?? 'UNKNOWN'}. ` +
          `Logs: ${build.logs?.deepLink ?? '(no logs link)'}`,
      );
  }
}
