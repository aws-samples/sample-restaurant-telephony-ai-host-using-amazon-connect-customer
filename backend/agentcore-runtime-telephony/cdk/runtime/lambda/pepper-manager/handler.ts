/**
 * CloudFormation custom-resource handler for the customer-id-pepper SSM SecureString.
 *
 * Contract (design §8.5, R18):
 *   - onCreate: generate 32 bytes via crypto.randomBytes, store as SecureString
 *               at `/<DeploymentPrefix>/customer-id-pepper`. Physical id = param name.
 *   - onUpdate: no-op. The parameter value is preserved across stack updates so
 *               existing `customer_id` derivations stay stable. A deliberate
 *               rotation uses the runbook (README "Pepper Rotation") — this
 *               handler never rotates automatically.
 *   - onDelete: delete the SSM parameter. (Stack teardown removes the pepper;
 *               next deploy regenerates it, which invalidates all prior
 *               `customer_id`s — an acceptable break at teardown time.)
 *
 * The pepper value is NEVER returned in `Data` — only the parameter *name*
 * goes back to CloudFormation. The Lambda's own CloudWatch logs print the
 * parameter name and the byte-length, never the value (R18 / NFR9-style).
 *
 * No @aws-sdk/* is bundled here on purpose: `@aws-sdk/client-ssm` is
 * available from the Node 24 Lambda managed runtime.
 */
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes } from 'crypto';

type CreateEvent = {
  RequestType: 'Create';
  ResourceProperties: { DeploymentPrefix: string };
};

type UpdateEvent = {
  RequestType: 'Update';
  PhysicalResourceId: string;
  ResourceProperties: { DeploymentPrefix: string };
  OldResourceProperties?: { DeploymentPrefix?: string };
};

type DeleteEvent = {
  RequestType: 'Delete';
  PhysicalResourceId: string;
  ResourceProperties: { DeploymentPrefix: string };
};

type PepperEvent = CreateEvent | UpdateEvent | DeleteEvent;

type Response = {
  PhysicalResourceId: string;
  Data?: { ParameterName: string };
};

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const ssm = new SSMClient({ region: REGION });

function parameterName(prefix: string): string {
  return `/${prefix}/customer-id-pepper`;
}

export async function handler(event: PepperEvent): Promise<Response> {
  const prefix = event.ResourceProperties.DeploymentPrefix;
  if (!prefix) {
    throw new Error('DeploymentPrefix is required');
  }
  const paramName = parameterName(prefix);

  console.log('pepper-manager', JSON.stringify({ request: event.RequestType, paramName }));

  if (event.RequestType === 'Create') {
    // 32 bytes → base64 (~44 chars). Stored as SecureString so IAM + KMS
    // control access. The pepper never leaves SSM at read time — the
    // agent fetches it with GetParameter(WithDecryption=true) on container
    // startup (see agent/pstn_customer.py:_load_pepper).
    const value = randomBytes(32).toString('base64');

    await ssm.send(
      new PutParameterCommand({
        Name: paramName,
        Value: value,
        Type: 'SecureString',
        Description: 'Customer-id derivation pepper for telephony-voice-ordering-agent',
        Overwrite: false,
        Tier: 'Standard',
      }),
    );

    console.log('pepper-manager created', JSON.stringify({ paramName, byteLength: 32 }));
    return {
      PhysicalResourceId: paramName,
      Data: { ParameterName: paramName },
    };
  }

  if (event.RequestType === 'Update') {
    // Preserve existing pepper across stack updates. Only the prefix might
    // change — if it does, we would orphan the old parameter; for now we
    // refuse that since first-prefix-wins (R20) should prevent it.
    const oldPrefix = event.OldResourceProperties?.DeploymentPrefix;
    if (oldPrefix && oldPrefix !== prefix) {
      throw new Error(
        `DeploymentPrefix changed across update (${oldPrefix} → ${prefix}). ` +
          'Cross-prefix redeploys are not supported — clone the repo into a fresh working copy.',
      );
    }
    console.log('pepper-manager update — no-op', JSON.stringify({ paramName }));
    return {
      PhysicalResourceId: event.PhysicalResourceId,
      Data: { ParameterName: paramName },
    };
  }

  // RequestType === 'Delete'
  try {
    await ssm.send(new DeleteParameterCommand({ Name: paramName }));
    console.log('pepper-manager deleted', JSON.stringify({ paramName }));
  } catch (err: unknown) {
    // ParameterNotFound on delete is benign — the stack deployed without
    // the parameter or an operator pre-deleted it via the rotation runbook.
    const name = (err as { name?: string })?.name ?? '';
    if (name !== 'ParameterNotFound') {
      throw err;
    }
    console.log('pepper-manager delete — already absent', JSON.stringify({ paramName }));
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
}
