/**
 * AgentCore Gateway Custom Resource Handler (Node.js)
 *
 * Handles Create/Update/Delete operations for AgentCore Gateway
 * as a CloudFormation Custom Resource.
 *
 * Ported from Python handler.py to eliminate Docker dependency for bundling.
 */

import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  GetGatewayCommand,
  DeleteGatewayCommand,
  ListGatewaysCommand,
  CreateGatewayTargetCommand,
  GetGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListGatewayTargetsCommand,
  UpdateGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  DeleteRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
  DetachRolePolicyCommand,
} from '@aws-sdk/client-iam';

import {
  APIGatewayClient,
  GetExportCommand,
} from '@aws-sdk/client-api-gateway';

const agentcoreClient = new BedrockAgentCoreControlClient();
const iamClient = new IAMClient();
const apigatewayClient = new APIGatewayClient();

// ─── Main Handler ────────────────────────────────────────────────────────────

export async function handler(event, context) {
  console.log(`RequestType: ${event.RequestType}`);

  try {
    const props = event.ResourceProperties;

    if (event.RequestType === 'Create') {
      const result = await createGateway(props);
      console.log('Create result:', JSON.stringify(result));
      return {
        PhysicalResourceId: result.gatewayId,
        Data: {
          GatewayId: result.gatewayId,
          GatewayUrl: result.gatewayUrl,
          GatewayArn: result.gatewayArn,
          GatewayRoleArn: result.gatewayRoleArn,
          TargetId: result.targetId,
          ApiGatewayId: result.apiGatewayId,
          ApiGatewayStage: result.apiGatewayStage,
          Region: result.region,
          AccountId: result.accountId,
          DeploymentTimestamp: result.deploymentTimestamp,
          ToolFiltersCount: String(result.toolFiltersCount),
          ToolOverridesCount: String(result.toolOverridesCount),
        },
      };

    } else if (event.RequestType === 'Update') {
      const gatewayId = event.PhysicalResourceId || 'not-created';
      const result = await updateGateway(gatewayId, props);
      return {
        PhysicalResourceId: gatewayId,
        Data: {
          GatewayId: result.gatewayId,
          GatewayUrl: result.gatewayUrl,
          GatewayArn: result.gatewayArn,
          GatewayRoleArn: result.gatewayRoleArn,
          TargetId: result.targetId,
          ApiGatewayId: result.apiGatewayId,
          ApiGatewayStage: result.apiGatewayStage,
          Region: result.region,
          AccountId: result.accountId,
          DeploymentTimestamp: result.deploymentTimestamp,
          ToolFiltersCount: String(result.toolFiltersCount),
          ToolOverridesCount: String(result.toolOverridesCount),
        },
      };

    } else if (event.RequestType === 'Delete') {
      const physicalResourceId = event.PhysicalResourceId || 'not-created';
      if (physicalResourceId !== 'not-created') {
        await deleteGateway(physicalResourceId, props);
      }
      return { PhysicalResourceId: physicalResourceId };
    }
  } catch (e) {
    console.error('Error:', e.message);
    throw e; // Let cr.Provider handle the error response
  }
}

// ─── Create Gateway ──────────────────────────────────────────────────────────

async function createGateway(props) {
  const gatewayName = props.GatewayName;
  const description = props.Description || 'QSR Ordering MCP Gateway';
  const apiGatewayId = props.ApiGatewayId;
  const stage = props.Stage;
  const region = props.Region;
  const accountId = props.AccountId;

  console.log(`Creating Gateway: ${gatewayName}`);

  // Step 1: Create IAM role
  const roleName = `${gatewayName}-service-role`;
  const apiGatewayArn = `arn:aws:execute-api:${region}:${accountId}:${apiGatewayId}/${stage}/*/*`;
  const roleArn = await createGatewayServiceRole(roleName, apiGatewayArn);

  // Wait for IAM propagation
  console.log('Waiting for IAM role propagation...');
  await sleep(10000);

  // Step 2: Fetch OpenAPI schema
  console.log(`Fetching OpenAPI schema from API Gateway ${apiGatewayId}...`);
  const schema = await fetchOpenApiSchema(apiGatewayId, stage);

  // Step 3: Parse schema for tool filters and overrides
  const { toolFilters, toolOverrides } = parseOpenApiSchema(schema);
  console.log(`Generated ${toolFilters.length} tool filters and ${toolOverrides.length} tool overrides`);

  // Step 4: Create Gateway
  console.log('Creating AgentCore Gateway...');
  let gatewayId;

  try {
    const resp = await agentcoreClient.send(new CreateGatewayCommand({
      name: gatewayName,
      description,
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      protocolConfiguration: {
        mcp: {
          supportedVersions: ['2025-03-26'],
          searchType: 'SEMANTIC',
          instructions: description,
        },
      },
      roleArn,
      exceptionLevel: 'DEBUG',
    }));

    gatewayId = resp.gatewayId || resp.gatewayIdentifier;
    if (!gatewayId) throw new Error(`Could not extract gateway ID from response`);
    console.log(`Gateway created: ${gatewayId}`);

  } catch (e) {
    if (e.name === 'ConflictException') {
      console.log(`Gateway ${gatewayName} already exists, retrieving...`);
      const listResp = await agentcoreClient.send(new ListGatewaysCommand({}));
      const existing = (listResp.items || []).find(g => g.name === gatewayName);
      if (!existing) throw new Error(`Gateway ${gatewayName} exists but could not be found`);
      gatewayId = existing.gatewayId || existing.gatewayIdentifier;
      console.log(`Using existing gateway: ${gatewayId}`);
    } else {
      throw e;
    }
  }

  // Fetch gateway details to get URL
  console.log('Fetching gateway details...');
  await sleep(2000);
  const getResp = await agentcoreClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
  const gatewayUrl = getResp.gatewayUrl;
  if (!gatewayUrl) throw new Error('Could not extract gateway URL');
  console.log(`Gateway URL: ${gatewayUrl}`);

  // Wait for gateway to be ready
  await waitForGatewayReady(gatewayId);

  // Step 5: Create Gateway Target
  console.log('Creating Gateway Target...');
  const targetPayload = {
    gatewayIdentifier: gatewayId,
    name: 'qsr-backend-api',
    description: 'QSR Backend API Lambda functions exposed as MCP tools',
    targetConfiguration: {
      mcp: {
        apiGateway: {
          restApiId: apiGatewayId,
          stage,
          apiGatewayToolConfiguration: {
            toolFilters,
            toolOverrides,
          },
        },
      },
    },
    credentialProviderConfigurations: [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ],
  };
  console.log('Target payload:', JSON.stringify(targetPayload, null, 2).substring(0, 2000));

  let targetResp;
  try {
    targetResp = await agentcoreClient.send(new CreateGatewayTargetCommand(targetPayload));
  } catch (targetErr) {
    console.error('CreateGatewayTarget error:', targetErr.message);
    console.error('Full error:', JSON.stringify(targetErr, Object.getOwnPropertyNames(targetErr)).substring(0, 2000));
    throw targetErr;
  }

  const targetId = targetResp.targetIdentifier || targetResp.targetId;
  console.log(`Target created: ${targetId}`);

  await waitForTargetReady(gatewayId, targetId);

  const gatewayArn = `arn:aws:bedrock:${region}:${accountId}:agent-gateway/${gatewayId}`;
  console.log(`Gateway deployment complete: ${gatewayUrl}`);

  return {
    gatewayId,
    gatewayUrl,
    gatewayArn,
    gatewayRoleArn: roleArn,
    targetId,
    apiGatewayId,
    apiGatewayStage: stage,
    region,
    accountId,
    deploymentTimestamp: new Date().toISOString(),
    toolFiltersCount: toolFilters.length,
    toolOverridesCount: toolOverrides.length,
  };
}

// ─── Update Gateway (delete target + recreate with fresh schema) ─────────────

async function updateGateway(gatewayId, props) {
  const apiGatewayId = props.ApiGatewayId;
  const stage = props.Stage;
  const region = props.Region;
  const accountId = props.AccountId;
  const gatewayName = props.GatewayName;

  console.log(`Updating Gateway: ${gatewayId}`);

  // Step 1: Get gateway details
  const getResp = await agentcoreClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
  const gatewayUrl = getResp.gatewayUrl;
  const gatewayArn = `arn:aws:bedrock:${region}:${accountId}:agent-gateway/${gatewayId}`;
  console.log(`Gateway URL: ${gatewayUrl}`);

  // Step 2: Update IAM role policy (in case API Gateway ARN changed)
  const roleName = `${gatewayName}-service-role`;
  const apiGatewayArn = `arn:aws:execute-api:${region}:${accountId}:${apiGatewayId}/${stage}/*/*`;
  const roleArn = await createGatewayServiceRole(roleName, apiGatewayArn);

  // Step 3: Update existing target with fresh schema (or create if none exists)
  console.log('Listing existing targets...');
  const listResp = await agentcoreClient.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId }));
  const existingTargets = listResp.items || [];
  console.log(`Found ${existingTargets.length} existing target(s)`);

  // Step 4: Fetch fresh OpenAPI schema
  console.log(`Fetching OpenAPI schema from API Gateway ${apiGatewayId}...`);
  const schema = await fetchOpenApiSchema(apiGatewayId, stage);

  // Step 5: Parse schema for tool filters and overrides
  const { toolFilters, toolOverrides } = parseOpenApiSchema(schema);
  console.log(`Generated ${toolFilters.length} tool filters and ${toolOverrides.length} tool overrides`);

  const targetConfig = {
    mcp: {
      apiGateway: {
        restApiId: apiGatewayId,
        stage,
        apiGatewayToolConfiguration: {
          toolFilters,
          toolOverrides,
        },
      },
    },
  };

  let targetId;

  if (existingTargets.length > 0) {
    // Update existing target in place
    const existingTarget = existingTargets[0];
    targetId = existingTarget.targetId || existingTarget.targetIdentifier;
    console.log(`Updating existing target: ${targetId}`);

    await agentcoreClient.send(new UpdateGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      targetId,
      name: 'qsr-backend-api',
      description: 'QSR Backend API Lambda functions exposed as MCP tools',
      targetConfiguration: targetConfig,
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    }));

    console.log(`Target ${targetId} update initiated`);
    await waitForTargetReady(gatewayId, targetId);
  } else {
    // No existing target — create new one
    console.log('No existing target, creating new one...');
    const targetResp = await agentcoreClient.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      name: 'qsr-backend-api',
      description: 'QSR Backend API Lambda functions exposed as MCP tools',
      targetConfiguration: targetConfig,
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    }));

    targetId = targetResp.targetIdentifier || targetResp.targetId;
    console.log(`New target created: ${targetId}`);
    await waitForTargetReady(gatewayId, targetId);
  }

  console.log(`Gateway update complete: ${gatewayUrl}`);

  return {
    gatewayId,
    gatewayUrl,
    gatewayArn,
    gatewayRoleArn: roleArn,
    targetId,
    apiGatewayId,
    apiGatewayStage: stage,
    region,
    accountId,
    deploymentTimestamp: new Date().toISOString(),
    toolFiltersCount: toolFilters.length,
    toolOverridesCount: toolOverrides.length,
  };
}

// ─── IAM Role ────────────────────────────────────────────────────────────────

async function createGatewayServiceRole(roleName, apiGatewayArn) {
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  const policyDocument = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: 'execute-api:Invoke',
      Resource: apiGatewayArn,
    }],
  });

  try {
    const resp = await iamClient.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicy,
      Description: 'Service role for AgentCore Gateway',
    }));
    const roleArn = resp.Role.Arn;
    console.log(`Created IAM role: ${roleArn}`);

    await iamClient.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: 'GatewayServicePolicy',
      PolicyDocument: policyDocument,
    }));

    return roleArn;
  } catch (e) {
    if (e.name === 'EntityAlreadyExistsException') {
      console.log(`Role ${roleName} exists, updating policy...`);
      const resp = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      const roleArn = resp.Role.Arn;

      await iamClient.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: 'GatewayServicePolicy',
        PolicyDocument: policyDocument,
      }));

      return roleArn;
    }
    throw e;
  }
}

// ─── OpenAPI Schema ──────────────────────────────────────────────────────────

async function fetchOpenApiSchema(apiGatewayId, stage) {
  const resp = await apigatewayClient.send(new GetExportCommand({
    restApiId: apiGatewayId,
    stageName: stage,
    exportType: 'oas30',
    accepts: 'application/json',
  }));

  // resp.body is a Uint8Array
  const bodyStr = new TextDecoder().decode(resp.body);
  return JSON.parse(bodyStr);
}

function parseOpenApiSchema(schema) {
  const toolFilters = [];
  const toolOverrides = [];

  if (!schema.paths) {
    console.log('Warning: No paths found in OpenAPI schema');
    return { toolFilters, toolOverrides };
  }

  const validMethods = ['get', 'post', 'put', 'delete', 'patch'];

  for (const [path, pathItem] of Object.entries(schema.paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;

    const methods = [];

    for (const method of validMethods) {
      if (pathItem[method]) {
        methods.push(method.toUpperCase());

        const operation = pathItem[method];
        const operationId = operation.operationId || generateOperationId(path, method);
        const description = operation.summary || operation.description || undefined;

        const override = {
          name: operationId,
          path,
          method: method.toUpperCase(),
        };
        if (description) override.description = description;

        toolOverrides.push(override);
      }
    }

    if (methods.length > 0) {
      toolFilters.push({ filterPath: path, methods });
    }
  }

  return { toolFilters, toolOverrides };
}

function generateOperationId(path, method) {
  const parts = path.split('/').filter(p => p && !p.startsWith('{'));
  const camelCase = parts.map((p, i) => i > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p).join('');
  return `${method}${camelCase.charAt(0).toUpperCase() + camelCase.slice(1)}`;
}

// ─── Wait Helpers ────────────────────────────────────────────────────────────

async function waitForGatewayReady(gatewayId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await agentcoreClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    const status = resp.status || 'UNKNOWN';
    if (status === 'READY') { console.log('Gateway READY'); return; }
    if (['FAILED', 'DELETING', 'DELETED'].includes(status)) {
      throw new Error(`Gateway entered terminal state: ${status}`);
    }
    await sleep(2000);
  }
  throw new Error('Gateway did not become READY in time');
}

async function waitForTargetReady(gatewayId, targetId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await agentcoreClient.send(new GetGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      targetId,
    }));
    const status = resp.status || 'UNKNOWN';
    console.log(`Target status: ${status} (attempt ${i + 1}/${maxAttempts})`);
    if (status === 'READY') { console.log('Target READY'); return; }
    if (status === 'FAILED') {
      const reason = resp.statusReason || resp.failureReason || 'No reason provided';
      console.error(`Target FAILED. Reason: ${reason}`);
      console.error('Target response:', JSON.stringify(resp, null, 2).substring(0, 1000));
      throw new Error(`Target creation failed: ${reason}`);
    }
    await sleep(2000);
  }
  throw new Error('Target did not become READY in time');
}

// ─── Delete Gateway ──────────────────────────────────────────────────────────

async function deleteGateway(gatewayId, props) {
  console.log(`Deleting Gateway: ${gatewayId}`);

  try {
    // Step 1: Delete all targets
    console.log('Step 1: Discovering and deleting targets...');
    try {
      const listResp = await agentcoreClient.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId }));
      const targets = listResp.items || [];
      console.log(`Found ${targets.length} target(s)`);

      for (const target of targets) {
        const tid = target.targetId || target.targetIdentifier;
        if (tid) {
          console.log(`Deleting target: ${tid}`);
          try {
            await agentcoreClient.send(new DeleteGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: tid }));
            await waitForTargetDeletion(gatewayId, tid);
          } catch (e) { console.log(`Error deleting target ${tid}: ${e.message}`); }
        }
      }

      if (targets.length > 0) {
        console.log('Waiting for targets to dissociate...');
        await sleep(10000);
      }
    } catch (e) { console.log(`Error listing targets: ${e.message}`); }

    // Step 2: Delete gateway with retries
    console.log('Step 2: Deleting gateway...');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await agentcoreClient.send(new DeleteGatewayCommand({ gatewayIdentifier: gatewayId }));
        console.log(`Gateway deleted: ${gatewayId}`);
        break;
      } catch (e) {
        if (e.name === 'ResourceNotFoundException') { console.log('Gateway already deleted'); break; }
        if (attempt < 4) { console.log(`Retry ${attempt + 1}/4 in 10s...`); await sleep(10000); }
        else console.log(`Failed to delete gateway after 5 attempts: ${e.message}`);
      }
    }

    // Step 3: Delete IAM role
    console.log('Step 3: Deleting IAM role...');
    const gatewayName = props?.GatewayName;
    if (gatewayName) {
      await deleteIamRole(`${gatewayName}-service-role`);
    }
  } catch (e) {
    console.log(`Error in deletion: ${e.message}`);
  }
}

async function waitForTargetDeletion(gatewayId, targetId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await agentcoreClient.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId }));
      await sleep(2000);
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') { console.log(`Target ${targetId} deleted`); return; }
      await sleep(2000);
    }
  }
}

async function deleteIamRole(roleName) {
  try {
    // Delete inline policies
    try {
      const resp = await iamClient.send(new ListRolePoliciesCommand({ RoleName: roleName }));
      for (const policyName of resp.PolicyNames || []) {
        await iamClient.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
        console.log(`Deleted inline policy: ${policyName}`);
      }
    } catch (e) { /* ignore */ }

    // Detach managed policies
    try {
      const resp = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
      for (const policy of resp.AttachedPolicies || []) {
        await iamClient.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.PolicyArn }));
        console.log(`Detached policy: ${policy.PolicyName}`);
      }
    } catch (e) { /* ignore */ }

    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    console.log(`IAM role deleted: ${roleName}`);
  } catch (e) {
    if (e.name === 'NoSuchEntityException') console.log(`IAM role ${roleName} already deleted`);
    else console.log(`Error deleting IAM role: ${e.message}`);
  }
}

async function getGatewayUrl(gatewayId) {
  const resp = await agentcoreClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
  return resp.gatewayUrl || '';
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
