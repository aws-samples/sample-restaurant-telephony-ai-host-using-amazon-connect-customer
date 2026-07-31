#!/usr/bin/env bash
################################################################################
# cleanup-all.sh — Teardown all stacks in reverse dependency order
#
# Reverse of deploy-all.sh. Safe to run multiple times (idempotent).
################################################################################

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/deployment-state.sh"

FORCE=false
PROJECT_PREFIX="qsr-cn"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)           FORCE=true;              shift ;;
    --deploymentPrefix) PROJECT_PREFIX="$2";    shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

print_section() {
  echo ""; echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"; echo ""
}
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }

OUTPUTS_DIR="cdk-outputs"

init_state

# Recover prefix from state
for _key in "${COMPONENT_KEYS[@]}"; do
  _d=$(is_deployed "$_key")
  if [ "$_d" = "true" ]; then
    _p=$(get_state_data "$_key" "prefix")
    if [ -n "$_p" ]; then
      PROJECT_PREFIX="$_p"
      break
    fi
  fi
done

destroy_stack() {
  local component=$1
  local cdk_dir=$2
  local stack_id=$3
  local outputs_file=$4

  local deployed; deployed=$(is_deployed "$component")
  if [ "$deployed" = "false" ] && [ "$FORCE" = false ]; then
    print_info "Skipping $component (not deployed)"
    return
  fi

  print_section "Destroying $component ($stack_id)"

  cd "$WORKSPACE_ROOT/$cdk_dir"
  if [ ! -d "node_modules" ]; then
    npm install --no-fund --no-audit --silent 2>&1 | tail -1
  fi

  set +e
  npx cdk destroy "$stack_id" --force 2>&1
  local exit_code=$?
  set -e

  if [ $exit_code -eq 0 ]; then
    update_state "$component" false "{}"
    rm -f "$WORKSPACE_ROOT/$OUTPUTS_DIR/$outputs_file"
    print_success "$component destroyed"
  else
    print_warning "$component destroy returned exit code $exit_code — may already be deleted"
    update_state "$component" false "{}"
  fi

  cd "$WORKSPACE_ROOT"
}

################################################################################
# Step 0a: Pre-cleanup before any stack destruction
# Correct order (mandatory — each step unblocks the next):
# 1. Clear Applications from security profiles (uncheck tools) — required
#    before the integration association can be deleted
# 2. Delete APPLICATION integration associations from Connect instance —
#    required before AppIntegrations application can be deleted
# 3. Disassociate security profiles from AI agent entities — prevents
#    security profile deletion failure during stack destroy
################################################################################
print_section "Step 0a: Pre-cleanup (security profiles + integration associations)"

set +e
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
INSTANCE_IDS=$(aws connect list-instances --region us-east-1 \
  --query "InstanceSummaryList[?contains(InstanceAlias, '${PROJECT_PREFIX}')].Id" \
  --output text 2>/dev/null)

for INST_ID in $INSTANCE_IDS; do
  print_info "Instance: $INST_ID"

  # 1. Clear Applications from security profiles — MUST happen before step 2
  print_info "  Clearing Applications from security profiles..."
  SP_IDS=$(aws connect list-security-profiles \
    --instance-id "$INST_ID" \
    --region us-east-1 \
    --query "SecurityProfileSummaryList[?contains(Name, '${PROJECT_PREFIX}')].Id" \
    --output text 2>/dev/null)
  for SP_ID in $SP_IDS; do
    print_info "    Clearing apps from security profile: $SP_ID"
    aws connect update-security-profile \
      --instance-id "$INST_ID" \
      --security-profile-id "$SP_ID" \
      --applications '[]' \
      --region us-east-1 2>/dev/null || true
  done

  # 2. Delete APPLICATION integration associations — MUST happen after step 1
  print_info "  Removing APPLICATION integration associations..."
  ASSOC_IDS=$(aws connect list-integration-associations \
    --instance-id "$INST_ID" \
    --integration-type APPLICATION \
    --region us-east-1 \
    --query 'IntegrationAssociationSummaryList[*].IntegrationAssociationId' \
    --output text 2>/dev/null)
  for ASSOC_ID in $ASSOC_IDS; do
    print_info "    Deleting integration association: $ASSOC_ID"
    aws connect delete-integration-association \
      --instance-id "$INST_ID" \
      --integration-association-id "$ASSOC_ID" \
      --region us-east-1 2>/dev/null || true
  done

  # 3. Disassociate security profiles from AI agent entities
  # Connect auto-associates to extra versions (:1, :2, bare ID) when CDK
  # creates the agent — those block security profile deletion during stack destroy.
  print_info "  Disassociating security profiles from AI agent entities..."
  ASSISTANT_IDS=$(aws qconnect list-assistants --region us-east-1 \
    --query "assistantSummaries[?contains(name, '${PROJECT_PREFIX}')].assistantId" \
    --output text 2>/dev/null)

  for SP_ID in $SP_IDS; do
    for ASST_ID in $ASSISTANT_IDS; do
      AGENT_IDS=$(aws qconnect list-ai-agents --assistant-id "$ASST_ID" \
        --region us-east-1 \
        --query 'aiAgentSummaries[*].aiAgentId' \
        --output text 2>/dev/null)
      for AGENT_ID in $AGENT_IDS; do
        for SUFFIX in ":\$LATEST" ":\$SAVED" "" ":1" ":2" ":3" ":4" ":5" ":6" ":7" ":8" ":9" ":10" ":11" ":12" ":13" ":14" ":15" ":16" ":17" ":18" ":19" ":20"; do
          ENTITY_ARN="arn:aws:wisdom:us-east-1:${ACCOUNT_ID}:ai-agent/${ASST_ID}/${AGENT_ID}${SUFFIX}"
          aws connect disassociate-security-profiles \
            --instance-id "$INST_ID" \
            --entity-type AI_AGENT \
            --entity-arn "$ENTITY_ARN" \
            --security-profiles "Id=${SP_ID}" \
            --region us-east-1 2>/dev/null || true
        done
      done
    done
  done
done
set -e
print_success "Pre-cleanup done"

################################################################################
# Step 0: Synthetic data cleanup (while DynamoDB tables still exist)
################################################################################
print_section "Step 0: Cleaning synthetic data"
cd "$WORKSPACE_ROOT/backend/synthetic-data"
if [ ! -d "node_modules" ]; then npm install --no-fund --no-audit --silent 2>&1 | tail -1; fi
set +e
node cleanup-data.js --deployment-prefix "$PROJECT_PREFIX" --force
set -e
update_state "cn-synthetic-data" false "{}"
print_success "Synthetic data cleaned"
cd "$WORKSPACE_ROOT"

################################################################################
# Reverse order: D → C → B → A
################################################################################

# Step 1: Connect phone + flow (Section D)
destroy_stack "cn-telephony" \
  "connect-interface/connect-telephony/cdk" \
  "ConnectTelephonyStack" \
  "cn-telephony.json"

# Step 2: Connect AI Agent + Lex (Section C)
destroy_stack "cn-ai-agent" \
  "connect-interface/connect-ai-agent/cdk" \
  "ConnectAIAgentStack" \
  "cn-ai-agent.json"

# Step 3: Connect Instance + Assistant (Section C)
destroy_stack "cn-instance" \
  "connect-interface/connect-instance/cdk" \
  "ConnectInstanceStack" \
  "cn-instance.json"

# Step 4: AgentCore Gateway (Section B)
destroy_stack "cn-gateway" \
  "backend/agentcore-gateway/cdk" \
  "AgentCoreGatewayStack" \
  "cn-gateway.json"

# Step 5: API Gateway (Section A)
destroy_stack "cn-apigw" \
  "backend/backend-infrastructure" \
  "ApiGatewayStack" \
  "cn-apigw.json"

# Step 6: Lambda (Section A)
destroy_stack "cn-lambdas" \
  "backend/backend-infrastructure" \
  "LambdaStack" \
  "cn-lambdas.json"

# Step 7: Location Service (Section A)
destroy_stack "cn-location" \
  "backend/backend-infrastructure" \
  "LocationStack" \
  "cn-location.json"

# Step 8: DynamoDB (Section A)
destroy_stack "cn-ddb" \
  "backend/backend-infrastructure" \
  "DynamoDBStack" \
  "cn-ddb.json"

print_section "Cleanup complete"
print_success "All stacks destroyed. Prefix: $PROJECT_PREFIX"

# Clean up outputs dir
rm -f "$WORKSPACE_ROOT/$OUTPUTS_DIR"/cn-*.json
print_info "Cleaned cdk-outputs/cn-*.json"

################################################################################
# Post-destroy: Clean AppIntegrations apps + Service Linked Role
#
# Must run AFTER cn-instance is destroyed. Once the Connect instance is gone,
# AWS eventually releases the application associations, allowing the app and
# SLR to be deleted. We poll until associations are cleared.
# Also deletes any orphaned Connect instances with the deployment prefix alias.
################################################################################
print_section "Post-destroy: Cleaning AppIntegrations apps and Service Linked Role"

set +e

# Delete any orphaned Connect instances matching the prefix alias
print_info "Checking for orphaned Connect instances with alias prefix: $PROJECT_PREFIX"
ORPHAN_INSTANCES=$(aws connect list-instances --region us-east-1 \
  --query "InstanceSummaryList[?contains(InstanceAlias, '${PROJECT_PREFIX}')].Id" \
  --output text 2>/dev/null)
for INST_ID in $ORPHAN_INSTANCES; do
  print_info "Deleting orphaned Connect instance: $INST_ID"
  aws connect delete-instance --instance-id "$INST_ID" --region us-east-1 2>/dev/null || true
done

# Delete any orphaned Lex bots matching the prefix
print_info "Checking for orphaned Lex bots with prefix: $PROJECT_PREFIX"
ORPHAN_BOT_IDS=$(aws lexv2-models list-bots --region us-east-1 \
  --query "botSummaries[?contains(botName, '${PROJECT_PREFIX}')].botId" \
  --output text 2>/dev/null)
for BOT_ID in $ORPHAN_BOT_IDS; do
  print_info "Deleting orphaned Lex bot: $BOT_ID"
  aws lexv2-models delete-bot --bot-id "$BOT_ID" --skip-resource-in-use-check --region us-east-1 2>/dev/null || true
done
APP_ARNS=$(aws appintegrations list-applications --region us-east-1 \
  --query "Applications[?contains(Name, '${PROJECT_PREFIX}')].Arn" --output text 2>/dev/null)

for APP_ARN in $APP_ARNS; do
  APP_ID=$(echo "$APP_ARN" | awk -F/ '{print $NF}')
  print_info "Checking associations on: $APP_ARN"
  ASSOC_COUNT=$(aws appintegrations list-application-associations \
    --application-id "$APP_ID" --region us-east-1 \
    --query 'length(ApplicationAssociations)' --output text 2>/dev/null || echo "0")
  if [ "$ASSOC_COUNT" = "0" ] || [ "$ASSOC_COUNT" = "None" ]; then
    print_info "Deleting application: $APP_ARN"
    aws appintegrations delete-application --arn "$APP_ARN" --region us-east-1 2>&1 || true
  else
    print_warning "Skipping $APP_ARN — still has $ASSOC_COUNT association(s) (likely from a deleted Connect instance, cannot be removed)"
  fi
done

# Delete SLR after apps are gone
print_info "Deleting AWSServiceRoleForAppIntegrations..."
TASK_ID=$(aws iam delete-service-linked-role \
  --role-name AWSServiceRoleForAppIntegrations --region us-east-1 \
  --query 'DeletionTaskId' --output text 2>/dev/null || echo "")
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "None" ]; then
  sleep 8
  STATUS=$(aws iam get-service-linked-role-deletion-status \
    --deletion-task-id "$TASK_ID" --region us-east-1 \
    --query 'Status' --output text 2>/dev/null || echo "UNKNOWN")
  print_info "SLR deletion status: $STATUS"
fi
set -e

print_success "Post-destroy cleanup complete"
