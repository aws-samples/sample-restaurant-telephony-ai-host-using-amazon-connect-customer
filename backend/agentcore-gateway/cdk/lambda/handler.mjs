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
  UpdateGatewayCommand,
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
  CreatePolicyCommand,
  GetPolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  DeletePolicyCommand,
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
  // When ConnectInstanceUrl is provided, the gateway uses CUSTOM_JWT auth so that
  // Amazon Connect can invoke it as an MCP tool server. When absent, it falls back
  // to AWS_IAM for direct agent/SDK access.
  const connectInstanceUrl = props.ConnectInstanceUrl || '';
  const useJwtAuth = !!connectInstanceUrl;

  console.log(`Creating Gateway: ${gatewayName}, auth: ${useJwtAuth ? 'CUSTOM_JWT' : 'AWS_IAM'}`);

  // Step 1: Create the gateway service role with correct path /service-role/ and
  // trust policy matching the working account's role exactly.
  // The role name uses the gateway name prefix with a wildcard in the trust condition
  // so it works before the exact gateway ID is known.
  const roleName = `AmazonBedrockAgentCoreGatewayServiceRole-${gatewayName}`;
  const roleArn = await createGatewayServiceRole(roleName, gatewayName, region, accountId);

  // Wait for IAM propagation
  console.log('Waiting for IAM role propagation...');
  await sleep(10000);

  // Step 2: Fetch OpenAPI schema
  console.log(`Fetching OpenAPI schema from API Gateway ${apiGatewayId}...`);
  const schema = await fetchOpenApiSchema(apiGatewayId, stage);

  // Step 3: Parse schema for tool filters and overrides
  const { toolFilters, toolOverrides } = parseOpenApiSchema(schema);
  console.log(`Generated ${toolFilters.length} tool filters and ${toolOverrides.length} tool overrides`);

  // Step 4: Create Gateway — roleArn is mandatory.
  console.log('Creating AgentCore Gateway...');
  let gatewayId;
  let gatewayUrl;

  const createParams = {
    name: gatewayName,
    description,
    authorizerType: useJwtAuth ? 'CUSTOM_JWT' : 'AWS_IAM',
    protocolType: 'MCP',
    protocolConfiguration: {
      mcp: {
        supportedVersions: ['2025-03-26'],
        instructions: description,
      },
    },
    roleArn,
    exceptionLevel: 'DEBUG',
  };

  if (useJwtAuth) {
    const discoveryUrl = `${connectInstanceUrl}/.well-known/openid-configuration`;
    createParams.authorizerConfiguration = {
      customJWTAuthorizer: {
        discoveryUrl,
        allowedAudience: ['placeholder'],  // gateway ID not known yet — updated after creation
        // allowedClients intentionally empty — per workshop setup
      },
    };
  }

  try {
    const resp = await agentcoreClient.send(new CreateGatewayCommand(createParams));
    gatewayId = resp.gatewayId || resp.gatewayIdentifier;
    if (!gatewayId) throw new Error(`Could not extract gateway ID from response`);
    // CreateGateway response returns URL with /mcp suffix — use this directly.
    // GetGateway API currently drops the /mcp suffix, causing AppIntegrations
    // createApplication to fail validation. Capture from CreateGateway response.
    gatewayUrl = resp.gatewayUrl;
    console.log(`Gateway created: ${gatewayId}, URL: ${gatewayUrl}`);
  } catch (e) {
    if (e.name === 'ConflictException') {
      console.log(`Gateway ${gatewayName} already exists, retrieving...`);
      const listResp = await agentcoreClient.send(new ListGatewaysCommand({}));
      const existing = (listResp.items || []).find(g => g.name === gatewayName);
      if (!existing) throw new Error(`Gateway ${gatewayName} exists but could not be found`);
      gatewayId = existing.gatewayId || existing.gatewayIdentifier;
      gatewayUrl = existing.gatewayUrl;  // from list response
      console.log(`Using existing gateway: ${gatewayId}, URL: ${gatewayUrl}`);
    } else {
      throw e;
    }
  }

  // Ensure URL has /mcp suffix — normalize in case list response omits it.
  if (gatewayUrl && !gatewayUrl.endsWith('/mcp')) {
    gatewayUrl = `${gatewayUrl}/mcp`;
  }
  if (!gatewayUrl) throw new Error('Could not extract gateway URL');
  console.log(`Gateway URL (normalized): ${gatewayUrl}`);

  // Wait for gateway READY before updating JWT audience.
  // Also attach the base policy now that we have the real gateway ID — scope it
  // to the exact gateway ARN (matching what the working account's managed policy does).
  await waitForGatewayReady(gatewayId);
  await attachGatewayBasePolicy(roleName, gatewayId, region, accountId);

  if (useJwtAuth) {
    console.log(`Updating JWT allowed audience to gateway ID: ${gatewayId}`);
    const discoveryUrl = `${connectInstanceUrl}/.well-known/openid-configuration`;
    await agentcoreClient.send(new UpdateGatewayCommand({
      gatewayIdentifier: gatewayId,
      name: gatewayName,
      roleArn,
      protocolType: 'MCP',
      protocolConfiguration: {
        mcp: {
          supportedVersions: ['2025-03-26'],
          instructions: description,
        },
      },
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl,
          allowedAudience: [gatewayId],
        },
      },
    }));
    console.log(`JWT audience updated to: ${gatewayId}`);
    // Wait for READY again after the update (gateway enters UPDATING state during update).
    await waitForGatewayReady(gatewayId);
  }

  // Step 5: Create Gateway Target
  console.log('Creating Gateway Target...');
  const targetPayload = {
    gatewayIdentifier: gatewayId,
    name: 'qsr-restaurant-api',
    description: 'Restaurant ordering API tools',
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

  const gatewayReturnArn = `arn:aws:bedrock:${region}:${accountId}:agent-gateway/${gatewayId}`;
  console.log(`Gateway deployment complete: ${gatewayUrl}`);

  return {
    gatewayId,
    gatewayUrl,
    gatewayArn: gatewayReturnArn,
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
  const rawUrl = getResp.gatewayUrl || '';
  const gatewayUrl = rawUrl.endsWith('/mcp') ? rawUrl : `${rawUrl}/mcp`;
  const gatewayArn = `arn:aws:bedrock:${region}:${accountId}:agent-gateway/${gatewayId}`;
  const roleArn = getResp.roleArn;  // reuse the role that was created at gateway create time
  console.log(`Gateway URL: ${gatewayUrl}, Role: ${roleArn}`);

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
      name: 'qsr-restaurant-api',
      description: 'Restaurant ordering API tools',
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
      name: 'qsr-restaurant-api',
      description: 'Restaurant ordering API tools',
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

// ─── IAM — Gateway Service Role ──────────────────────────────────────────────
//
// Creates a proper service role for the AgentCore Gateway matching exactly
// what the AWS console auto-creates (confirmed from working account inspection):
//
//   Path:        /service-role/
//   Trust:       bedrock-agentcore.amazonaws.com with SourceAccount + SourceArn conditions
//   Inline:      ApiGatewayInvokePolicy — execute-api:Invoke on the API Gateway
//   Managed:     AmazonBedrockAgentCoreGatewayBasePolicyProd_* (created inline here as managed)
//                  - bedrock-agentcore:GetGateway on the gateway ARN
//                  - bedrock-agentcore:GetConfigurationBundleVersion on configuration-bundle/*
//
// The role is REQUIRED — the CreateGateway API rejects null roleArn.
// Without the base policy, the gateway returns "Failed to obtain execution role credentials"
// at runtime because it cannot read its own configuration.

async function createGatewayServiceRole(roleName, gatewayName, region, accountId) {
  const gatewayArnPattern = `arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/${gatewayName}-*`;

  // Trust policy — matches the working account role exactly
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AmazonBedrockAgentCoreGatewayBasePolicyProd',
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:SourceAccount': accountId },
        ArnLike: { 'aws:SourceArn': gatewayArnPattern },
      },
    }],
  });

  let roleArn;
  try {
    const resp = await iamClient.send(new CreateRoleCommand({
      RoleName: roleName,
      Path: '/service-role/',
      AssumeRolePolicyDocument: trustPolicy,
      Description: 'Service role for AgentCore Gateway MCP server',
    }));
    roleArn = resp.Role.Arn;
    console.log(`Created IAM role: ${roleArn}`);
  } catch (e) {
    if (e.name === 'EntityAlreadyExistsException') {
      const resp = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      roleArn = resp.Role.Arn;
      console.log(`Role already exists: ${roleArn}`);
    } else {
      throw e;
    }
  }

  return roleArn;
}

// Attaches the ApiGatewayInvokePolicy (inline) and creates+attaches the
// AmazonBedrockAgentCoreGatewayBasePolicyProd managed policy.
// Called AFTER gateway creation so we have the exact gateway ID for scoping.
async function attachGatewayBasePolicy(roleName, gatewayId, region, accountId) {
  const apiGatewayArn = `arn:aws:execute-api:${region}:${accountId}:*/*/*`;
  const gatewayArn = `arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/${gatewayId}`;

  // Inline: execute-api:Invoke — scoped to this account's APIs
  await iamClient.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'ApiGatewayInvokePolicy',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: 'execute-api:Invoke',
        Resource: apiGatewayArn,
      }],
    }),
  }));

  // Managed: GetGateway + GetConfigurationBundleVersion
  // Create as a managed policy under /service-role/ path, then attach
  const basePolicyName = `AmazonBedrockAgentCoreGatewayBasePolicyProd-${gatewayId}`;
  const basePolicyArn = `arn:aws:iam::${accountId}:policy/service-role/${basePolicyName}`;

  const basePolicyDocument = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'GetGateway',
        Effect: 'Allow',
        Action: ['bedrock-agentcore:GetGateway'],
        Resource: [gatewayArn],
      },
      {
        Sid: 'GetConfigurationBundleVersion',
        Effect: 'Allow',
        Action: ['bedrock-agentcore:GetConfigurationBundleVersion'],
        Resource: [`arn:aws:bedrock-agentcore:${region}:${accountId}:configuration-bundle/*`],
        Condition: {
          StringEquals: {
            'aws:ResourceAccount': '${aws:PrincipalAccount}',
            'aws:RequestedRegion': region,
          },
        },
      },
    ],
  });

  try {
    await iamClient.send(new CreatePolicyCommand({
      PolicyName: basePolicyName,
      Path: '/service-role/',
      PolicyDocument: basePolicyDocument,
      Description: 'Base policy for AgentCore Gateway service role',
    }));
    console.log(`Created managed policy: ${basePolicyArn}`);
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
    console.log(`Managed policy already exists: ${basePolicyArn}`);
  }

  await iamClient.send(new AttachRolePolicyCommand({
    RoleName: roleName,
    PolicyArn: basePolicyArn,
  }));
  console.log(`Attached ${basePolicyName} to ${roleName}`);
}

async function deleteGatewayRole(roleName, accountId) {
  try {
    // Detach managed policies
    try {
      const resp = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
      for (const policy of resp.AttachedPolicies || []) {
        await iamClient.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.PolicyArn }));
        // Delete the managed policy we created (base policy is gateway-specific)
        if (policy.PolicyName.startsWith('AmazonBedrockAgentCoreGatewayBasePolicyProd-')) {
          try {
            await iamClient.send(new DeletePolicyCommand({ PolicyArn: policy.PolicyArn }));
            console.log(`Deleted managed policy: ${policy.PolicyArn}`);
          } catch (e) { console.log(`Could not delete policy: ${e.message}`); }
        }
      }
    } catch (e) { /* ignore */ }

    // Delete inline policies
    try {
      const resp = await iamClient.send(new ListRolePoliciesCommand({ RoleName: roleName }));
      for (const policyName of resp.PolicyNames || []) {
        await iamClient.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
      }
    } catch (e) { /* ignore */ }

    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    console.log(`Deleted IAM role: ${roleName}`);
  } catch (e) {
    if (e.name === 'NoSuchEntityException') console.log(`Role ${roleName} already deleted`);
    else console.log(`Error deleting role: ${e.message}`);
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

  // Tool descriptions matching the old working account's gateway target toolOverrides.
  // Confirmed from live API inspection of gateway-quick-start-4c5e0a-hbvuqocfka.
  const TOOL_DESCRIPTIONS = {
    'GetMenu': 'Get restaurant menu items',
    'AddToCart': 'Add Item to cart',
    'GetCart': 'Get current cart contents',
    'UpdateCart': 'Update cart item',
    'PlaceOrder': 'Place the order',
    'GetNearestLocations': 'Find nearest locations',
    'GeocodeAddress': 'Geocode an address',
    'FindLocationAlongRoute': 'Find location along route',
    'GetCustomerProfile': 'Get customer profile',
    'GetPreviousOrders': 'Get previous orders',
  };

  const validMethods = ['get', 'post', 'put', 'delete', 'patch'];

  for (const [path, pathItem] of Object.entries(schema.paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;

    const methods = [];

    for (const method of validMethods) {
      if (pathItem[method]) {
        methods.push(method.toUpperCase());

        const operation = pathItem[method];
        const operationId = operation.operationId || generateOperationId(path, method);
        // Use rich description from map, fall back to API spec summary/description, then operationId
        const description = TOOL_DESCRIPTIONS[operationId] || operation.summary || operation.description || undefined;

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

  } catch (e) {
    console.log(`Error in deletion: ${e.message}`);
  }
  // Delete the gateway service role
  const roleName = `AmazonBedrockAgentCoreGatewayServiceRole-${props?.GatewayName}`;
  if (props?.GatewayName) {
    await deleteGatewayRole(roleName, props?.AccountId);
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

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
