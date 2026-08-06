#!/usr/bin/env bash
################################################################################
# deploy-all.sh — Idempotent Deploy: Restaurant Connect AI Host
#
# Deploys all 8 stacks in dependency order:
#
#  Section A — Backend Infrastructure (stacks 1-4)
#    1. cn-ddb       DynamoDBStack
#    2. cn-location  LocationStack
#    3. cn-lambdas   LambdaStack
#    4. cn-apigw     ApiGatewayStack
#
#  Section C — Connect Instance (stack 5, must deploy before gateway)
#    5. cn-instance  ConnectInstanceStack
#
#  Section B — AgentCore Gateway / MCP (stack 6, needs ConnectInstanceArn)
#    6. cn-gateway   AgentCoreGatewayStack
#
#  Section C — Connect AI Agent (stack 7, needs both cn-instance + cn-gateway)
#    7. cn-ai-agent  ConnectAIAgentStack
#
#  Section D — Connect Telephony (stack 8)
#    8. cn-telephony ConnectTelephonyStack
#
#  Synthetic data (seeded after stack 4)
#    9. cn-synthetic-data
#
# Cross-stack wiring: all done via --parameters <StackId>:Key=Value threaded
# from cdk-outputs/<component>.json using the json_val helper.
# NO CloudFormation cross-stack exports.
################################################################################

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/deployment-state.sh"

# Defaults
PROJECT_PREFIX="qsr-cn"
PROJECT_PREFIX_EXPLICIT=false
MODE="update"
FORCE_DEPLOY=false
SKIP_PREFLIGHT=false
ONLY_COMPONENT=""
LOW_STORAGE_MODE=false
OUTPUTS_DIR="cdk-outputs"

# Synthetic data options
USER_NAME=""
USER_PHONE=""
COMPANY_NAME=""
SKIP_SYNTHETIC_DATA=false
ASSUME_YES=false
SYNTH_LOCATION=""
SYNTH_BUSINESS_NAME=""

DEFAULT_USER_NAME="Jane Doe"
DEFAULT_SYNTH_LOCATION="Dallas, Texas"
DEFAULT_SYNTH_BUSINESS_NAME="Burger Restaurants"
DEFAULT_COMPANY_NAME="Amazing Burgers"

# Connect options
PHONE_COUNTRY_CODE="US"
PHONE_TYPE="DID"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploymentPrefix)    PROJECT_PREFIX="$2"; PROJECT_PREFIX_EXPLICIT=true; shift 2 ;;
    --mode)                MODE="$2";           shift 2 ;;
    --force-deploy)        FORCE_DEPLOY=true;   shift ;;
    --skip-preflight)      SKIP_PREFLIGHT=true; shift ;;
    --only)                ONLY_COMPONENT="$2"; shift 2 ;;
    --low-storage-mode)    LOW_STORAGE_MODE=true; shift ;;
    --user-name)           USER_NAME="$2";       shift 2 ;;
    --user-phone)          USER_PHONE="$2";      shift 2 ;;
    --company-name)        COMPANY_NAME="$2";    shift 2 ;;
    --skip-synthetic-data) SKIP_SYNTHETIC_DATA=true; shift ;;
    --yes|--non-interactive) ASSUME_YES=true;   shift ;;
    --synth-location)      SYNTH_LOCATION="$2"; shift 2 ;;
    --synth-business-name) SYNTH_BUSINESS_NAME="$2"; shift 2 ;;
    --phone-country-code)  PHONE_COUNTRY_CODE="$2"; shift 2 ;;
    --phone-type)          PHONE_TYPE="$2";     shift 2 ;;
    --help)
      cat <<'USAGE'
Usage: ./scripts/deploy-all.sh [OPTIONS]

Options:
  --deploymentPrefix <name>   Prefix for all physical resource names.
                              Must match ^[a-z][a-z0-9-]{1,19}$.
                              Default: qsr-cn

  --mode <update|fresh>       update (default) = idempotent redeploy.
                              fresh = cleanup-all.sh --force first.

  --force-deploy              Redeploy every layer even if state says done.

  --skip-preflight            Skip prerequisite checks.

  --only <component>          Deploy only one component. Valid keys:
                                cn-ddb, cn-location, cn-lambdas, cn-apigw,
                                cn-instance, cn-gateway, cn-ai-agent,
                                cn-telephony, cn-synthetic-data

  --company-name "<brand>"    Restaurant brand name for the AI agent system
                              prompt and synthetic data. Default: Amazing Burgers

  --user-name "<name>"        Loyalty customer display name. Default: Jane Doe

  --user-phone <E.164>        Real phone number for the loyalty customer
                              (the number you dial from). No default.

  --skip-synthetic-data       Skip seeding DynamoDB with menu + location data.

  --synth-location "<where>"  Amazon Location Service search anchor.
                              Default: "Dallas, Texas"

  --synth-business-name "<q>" Location query for Geo Places.
                              Default: "Burger Restaurants"

  --phone-country-code <cc>   ISO country code for phone number. Default: US

  --phone-type <DID|TOLL_FREE> Phone number type. Default: DID

  --yes, --non-interactive    Never prompt interactively.

  --help                      Show this message.

Prerequisites:
  - Node.js >= 24, npm, AWS CLI v2, git
  - AWS credentials configured (us-east-1 recommended)
  - CDK bootstrapped: npx cdk bootstrap aws://<ACCOUNT>/<REGION>
  - Amazon Bedrock Nova Sonic model access enabled
  - Amazon Connect phone number quota >= 1
USAGE
      exit 0 ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2; echo "Use --help for usage."; exit 1 ;;
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

################################################################################
# Helpers
################################################################################

CDK_ROLLBACK_FLAG=""
if [ "${NO_ROLLBACK:-false}" = true ]; then CDK_ROLLBACK_FLAG="--no-rollback"; fi

# Read a value from a cdk-outputs JSON file.
# Usage: json_val <file.json> <StackLogicalId> <OutputKey> [default]
json_val() {
  local file=$1 stack=$2 key=$3 default=${4:-}
  local full_path="$WORKSPACE_ROOT/$OUTPUTS_DIR/$file"
  if [ ! -f "$full_path" ]; then echo "$default"; return; fi
  node -e "
    const d=JSON.parse(require('fs').readFileSync('$full_path','utf8'));
    console.log((d['$stack']||{})['$key']||'$default');
  "
}

safe_npm_install() {
  local current_dir; current_dir=$(pwd)
  local project_dirs=(
    "backend/backend-infrastructure"
    "backend/agentcore-gateway/cdk"
    "backend/synthetic-data"
    "connect-interface/connect-instance/cdk"
    "connect-interface/connect-ai-agent/cdk"
    "connect-interface/connect-telephony/cdk"
  )

  if [ "$LOW_STORAGE_MODE" = true ]; then
    for dir in "${project_dirs[@]}"; do
      local abs_dir="$WORKSPACE_ROOT/$dir"
      if [ "$abs_dir" != "$current_dir" ] && [ -d "$abs_dir/node_modules" ]; then
        rm -rf "$abs_dir/node_modules"
      fi
    done
  fi

  local output; local exit_code
  set +e; output=$(npm install --no-fund --no-audit 2>&1); exit_code=$?; set -e

  if [ $exit_code -ne 0 ]; then
    echo "$output"
    if echo "$output" | grep -q "ENOSPC"; then
      print_error "npm install failed — no disk space. Re-run with --low-storage-mode"
    else
      print_error "npm install failed (exit code $exit_code)"
    fi
    exit 1
  fi
  echo "$output" | tail -1
}

assert_account() {
  local identity; identity=$(aws sts get-caller-identity --output json 2>&1)
  if ! echo "$identity" | grep -q "Account"; then
    print_error "AWS credentials not valid. Run: ada credentials update --account=<ACCOUNT> --provider=isengard --role=Admin --once"
    exit 1
  fi
  print_info "Account: $(echo "$identity" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>console.log(JSON.parse(b).Account))")"
}

should_deploy() {
  local component=$1
  if [ -n "$ONLY_COMPONENT" ]; then
    [ "$ONLY_COMPONENT" = "$component" ] && return 0 || return 1
  fi
  if [ "$FORCE_DEPLOY" = true ]; then return 0; fi
  local deployed; deployed=$(is_deployed "$component")
  [ "$deployed" = "true" ] && { print_info "Skipping $component (already deployed). Use --force-deploy to redeploy."; return 1; }
  return 0
}

deploy_stack() {
  local component=$1   # e.g. cn-ddb
  local cdk_dir=$2     # relative to WORKSPACE_ROOT
  local stack_id=$3    # CDK construct id, e.g. DynamoDBStack
  local outputs_file=$4 # e.g. cn-ddb.json
  shift 4
  local extra_params=("$@")

  print_section "Deploying $component ($stack_id)"
  assert_account

  cd "$WORKSPACE_ROOT/$cdk_dir"
  safe_npm_install

  mkdir -p "$WORKSPACE_ROOT/$OUTPUTS_DIR"

  local params=(
    "--parameters" "${stack_id}:DeploymentPrefix=${PROJECT_PREFIX}"
  )
  for p in "${extra_params[@]+"${extra_params[@]}"}"; do
    params+=("--parameters" "$p")
  done

  npx cdk deploy "$stack_id" \
    --require-approval never \
    $CDK_ROLLBACK_FLAG \
    "${params[@]}" \
    --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/$outputs_file"

  update_state "$component" true "{\"prefix\":\"$PROJECT_PREFIX\"}"
  print_success "$component deployed"
  cd "$WORKSPACE_ROOT"
}

################################################################################
# Resolve prefix from state if --deploymentPrefix not passed and state exists
################################################################################
init_state

if [ "$PROJECT_PREFIX_EXPLICIT" = false ] && [ -f "$STATE_FILE" ]; then
  for key in "${COMPONENT_KEYS[@]}"; do
    _deployed=$(is_deployed "$key")
    if [ "$_deployed" = "true" ]; then
      _saved_prefix=$(get_state_data "$key" "prefix")
      if [ -n "$_saved_prefix" ]; then
        PROJECT_PREFIX="$_saved_prefix"
        print_info "Recovered deployment prefix from state: $PROJECT_PREFIX"
        break
      fi
    fi
  done
fi

# Apply defaults
[ -z "$COMPANY_NAME" ] && COMPANY_NAME="$DEFAULT_COMPANY_NAME"
[ -z "$USER_NAME" ]    && USER_NAME="$DEFAULT_USER_NAME"
[ -z "$SYNTH_LOCATION" ] && SYNTH_LOCATION="$DEFAULT_SYNTH_LOCATION"
[ -z "$SYNTH_BUSINESS_NAME" ] && SYNTH_BUSINESS_NAME="$DEFAULT_SYNTH_BUSINESS_NAME"

################################################################################
# Preflight
################################################################################
if [ "$SKIP_PREFLIGHT" = false ]; then
  print_section "Preflight checks"
  # Node.js — require >= 18 (LTS baseline); 20, 22, 23, 24 all work fine
  node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [ -z "$node_version" ] || [ "$node_version" -lt 18 ]; then
    print_error "Node.js >= 18 required. Current: $(node --version 2>/dev/null || echo 'not found')"
    exit 1
  fi
  print_success "Node.js $(node --version)"

  # AWS CLI
  if ! aws --version &>/dev/null; then
    print_error "AWS CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
  fi
  print_success "AWS CLI $(aws --version 2>&1 | head -1)"

  # CDK bootstrap
  assert_account
  print_success "Preflight passed"
fi

################################################################################
# Fresh mode — teardown first
################################################################################
if [ "$MODE" = "fresh" ]; then
  print_section "Fresh mode — running cleanup-all.sh --force first"
  "$SCRIPT_DIR/cleanup-all.sh" --force --deploymentPrefix "$PROJECT_PREFIX"
fi

################################################################################
# Layer 1: DynamoDB tables
################################################################################
if should_deploy "cn-ddb"; then
  deploy_stack "cn-ddb" \
    "backend/backend-infrastructure" \
    "DynamoDBStack" \
    "cn-ddb.json"
fi

################################################################################
# Layer 2: Location Service
################################################################################
if should_deploy "cn-location"; then
  deploy_stack "cn-location" \
    "backend/backend-infrastructure" \
    "LocationStack" \
    "cn-location.json"
fi

################################################################################
# Layer 3: Lambda functions
################################################################################
if should_deploy "cn-lambdas"; then
  deploy_stack "cn-lambdas" \
    "backend/backend-infrastructure" \
    "LambdaStack" \
    "cn-lambdas.json" \
    "LambdaStack:MenuTableName=$(json_val cn-ddb.json DynamoDBStack MenuTableName)" \
    "LambdaStack:CartsTableName=$(json_val cn-ddb.json DynamoDBStack CartsTableName)" \
    "LambdaStack:OrdersTableName=$(json_val cn-ddb.json DynamoDBStack OrdersTableName)" \
    "LambdaStack:CustomersTableName=$(json_val cn-ddb.json DynamoDBStack CustomersTableName)" \
    "LambdaStack:LocationsTableName=$(json_val cn-ddb.json DynamoDBStack LocationsTableName)" \
    "LambdaStack:PlaceIndexName=$(json_val cn-location.json LocationStack PlaceIndexName)" \
    "LambdaStack:RouteCalculatorName=$(json_val cn-location.json LocationStack RouteCalculatorName)"
fi

################################################################################
# Layer 4: API Gateway
################################################################################
if should_deploy "cn-apigw"; then
  deploy_stack "cn-apigw" \
    "backend/backend-infrastructure" \
    "ApiGatewayStack" \
    "cn-apigw.json" \
    "ApiGatewayStack:GetCustomerProfileLambdaArn=$(json_val cn-lambdas.json LambdaStack GetCustomerProfileLambdaArn)" \
    "ApiGatewayStack:GetPreviousOrdersLambdaArn=$(json_val cn-lambdas.json LambdaStack GetPreviousOrdersLambdaArn)" \
    "ApiGatewayStack:GetMenuLambdaArn=$(json_val cn-lambdas.json LambdaStack GetMenuLambdaArn)" \
    "ApiGatewayStack:AddToCartLambdaArn=$(json_val cn-lambdas.json LambdaStack AddToCartLambdaArn)" \
    "ApiGatewayStack:GetCartLambdaArn=$(json_val cn-lambdas.json LambdaStack GetCartLambdaArn)" \
    "ApiGatewayStack:UpdateCartLambdaArn=$(json_val cn-lambdas.json LambdaStack UpdateCartLambdaArn)" \
    "ApiGatewayStack:PlaceOrderLambdaArn=$(json_val cn-lambdas.json LambdaStack PlaceOrderLambdaArn)" \
    "ApiGatewayStack:GetNearestLocationsLambdaArn=$(json_val cn-lambdas.json LambdaStack GetNearestLocationsLambdaArn)" \
    "ApiGatewayStack:FindLocationAlongRouteLambdaArn=$(json_val cn-lambdas.json LambdaStack FindLocationAlongRouteLambdaArn)" \
    "ApiGatewayStack:GeocodeAddressLambdaArn=$(json_val cn-lambdas.json LambdaStack GeocodeAddressLambdaArn)"
fi

################################################################################
# Synthetic data — seeded here, after DynamoDB + Location + API Gateway are ready.
# Populates menu and location data. No SSM pepper needed (no --user-phone).
# Anonymous callers can order end-to-end without loyalty data.
################################################################################
if [ "$SKIP_SYNTHETIC_DATA" = false ] && should_deploy "cn-synthetic-data"; then
  print_section "Seeding synthetic data (menu + locations)"
  assert_account

  cd "$WORKSPACE_ROOT/backend/synthetic-data"
  safe_npm_install

  node populate-data.js \
    --deployment-prefix "$PROJECT_PREFIX" \
    --company-name "$COMPANY_NAME" \
    --location "$SYNTH_LOCATION" \
    --business-name "$SYNTH_BUSINESS_NAME" \
    --user-name "$USER_NAME" \
    --non-interactive

  update_state "cn-synthetic-data" true "{\"prefix\":\"$PROJECT_PREFIX\"}"
  print_success "Synthetic data seeded"
  cd "$WORKSPACE_ROOT"
fi

################################################################################
# Layer 5: Connect Instance + Q in Connect Assistant (Section C)
################################################################################
if should_deploy "cn-instance"; then
  deploy_stack "cn-instance" \
    "connect-interface/connect-instance/cdk" \
    "ConnectInstanceStack" \
    "cn-instance.json"
fi

################################################################################
# Layer 6: AgentCore Gateway (Section B — MCP tools)
# NOTE: Deployed after cn-instance because it needs ConnectInstanceArn + ConnectInstanceUrl
################################################################################
if should_deploy "cn-gateway"; then
  deploy_stack "cn-gateway" \
    "backend/agentcore-gateway/cdk" \
    "AgentCoreGatewayStack" \
    "cn-gateway.json" \
    "AgentCoreGatewayStack:ApiGatewayId=$(json_val cn-apigw.json ApiGatewayStack ApiGatewayId)" \
    "AgentCoreGatewayStack:ApiGatewayUrl=$(json_val cn-apigw.json ApiGatewayStack ApiGatewayUrl)" \
    "AgentCoreGatewayStack:ApiGatewayRestApiId=$(json_val cn-apigw.json ApiGatewayStack ApiGatewayRestApiId)" \
    "AgentCoreGatewayStack:ConnectInstanceUrl=https://${PROJECT_PREFIX}-restaurant.my.connect.aws"
fi

################################################################################
# Layer 7: Connect AI Agent + Lex bot + Nova Sonic (Section C continued)
################################################################################
if should_deploy "cn-ai-agent"; then
  deploy_stack "cn-ai-agent" \
    "connect-interface/connect-ai-agent/cdk" \
    "ConnectAIAgentStack" \
    "cn-ai-agent.json" \
    "ConnectAIAgentStack:ConnectInstanceArn=$(json_val cn-instance.json ConnectInstanceStack ConnectInstanceArn)" \
    "ConnectAIAgentStack:AssistantId=$(json_val cn-instance.json ConnectInstanceStack AssistantId)" \
    "ConnectAIAgentStack:AssistantArn=$(json_val cn-instance.json ConnectInstanceStack AssistantArn)" \
    "ConnectAIAgentStack:CompanyName=${COMPANY_NAME}" \
    "ConnectAIAgentStack:GatewayId=$(json_val cn-gateway.json AgentCoreGatewayStack GatewayId)" \
    "ConnectAIAgentStack:GatewayUrl=$(json_val cn-gateway.json AgentCoreGatewayStack GatewayUrl)"
fi

################################################################################
# Layer 8: Connect phone number + contact flow (Section D)
################################################################################
if should_deploy "cn-telephony"; then
  deploy_stack "cn-telephony" \
    "connect-interface/connect-telephony/cdk" \
    "ConnectTelephonyStack" \
    "cn-telephony.json" \
    "ConnectTelephonyStack:ConnectInstanceArn=$(json_val cn-instance.json ConnectInstanceStack ConnectInstanceArn)" \
    "ConnectTelephonyStack:AssistantArn=$(json_val cn-instance.json ConnectInstanceStack AssistantArn)" \
    "ConnectTelephonyStack:LexBotId=$(json_val cn-ai-agent.json ConnectAIAgentStack LexBotId)" \
    "ConnectTelephonyStack:LexBotAliasId=$(json_val cn-ai-agent.json ConnectAIAgentStack LexBotAliasId)" \
    "ConnectTelephonyStack:PhoneCountryCode=${PHONE_COUNTRY_CODE}" \
    "ConnectTelephonyStack:PhoneType=${PHONE_TYPE}" \
    "ConnectTelephonyStack:PushSessionDataFnArn=$(json_val cn-ai-agent.json ConnectAIAgentStack PushSessionDataFnArn)"
fi

################################################################################
# Success
################################################################################
print_section "Deployment complete"

PHONE=$(json_val cn-telephony.json ConnectTelephonyStack PhoneNumberE164)
if [ -n "$PHONE" ]; then
  print_success "Your restaurant AI host is live at ${PHONE} — dial to test."
  echo ""
  echo "  Brand:     ${COMPANY_NAME}"
  echo "  Prefix:    ${PROJECT_PREFIX}"
  echo "  Phone:     ${PHONE}"
  echo "  Region:    ${AWS_DEFAULT_REGION:-us-east-1}"
  echo ""
else
  print_warning "Phone number not yet in outputs — check cdk-outputs/cn-telephony.json"
fi
