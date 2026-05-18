#!/usr/bin/env bash

################################################################################
# Idempotent Deploy - Telephony Voice Ordering Agent
#
# Mirrors the shape of reference-project/deploy-all.sh (sources deployment-state.sh
# for init_state/update_state/is_deployed; uses safe_npm_install/json_val/json_stdin
# helpers; singular .deployment-state.json keyed by component).
#
# Each CDK app's bin/cdk.ts declares its construct with an UN-prefixed logical
# id (NetworkStack, AgentEcrStack, AgentBuildStack, AgentRuntimeStack,
# IngressStack). Therefore `cdk deploy <UnprefixedName>` addresses the stack,
# and cdk-outputs/*.json is keyed on the same UN-prefixed name. The
# DeploymentPrefix flows in via --parameters, baked into resource names
# inside each stack at synth time.
################################################################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source state manager.
# shellcheck source=deployment-state.sh
source "$SCRIPT_DIR/deployment-state.sh"

# Defaults
PROJECT_PREFIX="qsr-tel"
MODE="update"          # update (idempotent) | fresh (clean redeploy)
FORCE_DEPLOY=false
SKIP_PREFLIGHT=false
NO_ROLLBACK=false
ONLY_COMPONENT=""      # empty = deploy all layers; when set, run ONLY that one
LOW_STORAGE_MODE=false # --low-storage-mode: wipe sibling node_modules before each npm install
OUTPUTS_DIR="cdk-outputs"

# Synthetic-data options. Populated from --user-name/--user-phone flags; the
# layer itself runs only when either --with-synthetic-data is passed OR the
# operator answers "yes" at the interactive prompt. Email is synthesized from
# --user-name inside populate-data.js so the schema parity with the reference
# Customers table stays intact without exposing a second flag.
USER_NAME=""
USER_PHONE=""
COMPANY_NAME=""
WITH_SYNTHETIC_DATA=false
SKIP_SYNTHETIC_DATA=false
SYNTH_LOCATION=""
SYNTH_BUSINESS_NAME=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploymentPrefix) PROJECT_PREFIX="$2"; shift 2 ;;
    --mode)             MODE="$2";           shift 2 ;;
    --force-deploy)     FORCE_DEPLOY=true;   shift ;;
    --skip-preflight)   SKIP_PREFLIGHT=true; shift ;;
    --no-rollback)      NO_ROLLBACK=true;    shift ;;
    --only)             ONLY_COMPONENT="$2"; shift 2 ;;
    --low-storage-mode) LOW_STORAGE_MODE=true; shift ;;
    --chimePhoneSearch) CHIME_PHONE_SEARCH="$2"; shift 2 ;;
    --user-name)            USER_NAME="$2";            shift 2 ;;
    --user-phone)           USER_PHONE="$2";           shift 2 ;;
    --company-name)         COMPANY_NAME="$2";         shift 2 ;;
    --with-synthetic-data)  WITH_SYNTHETIC_DATA=true;  shift ;;
    --skip-synthetic-data)  SKIP_SYNTHETIC_DATA=true;  shift ;;
    --synth-location)       SYNTH_LOCATION="$2";       shift 2 ;;
    --synth-business-name)  SYNTH_BUSINESS_NAME="$2";  shift 2 ;;
    --help)
      cat <<'USAGE'
Usage: ./scripts/deploy-all.sh [OPTIONS]

Options:
  --deploymentPrefix <name>   Prefix baked into physical resource names on
                              every new stack. Default: qsr-tel.
                              Must match ^[a-z][a-z0-9-]{1,19}$
                              (1-20 chars, lowercase, start with letter).
                              Threaded via CFN Parameter on every stack.
  --mode <update|fresh>       update (default) = idempotent redeploy.
                              fresh = cleanup-all.sh --force first.
  --force-deploy              Redeploy every layer even if state says done.
  --skip-preflight            Skip scripts/preflight-check.sh.
  --low-storage-mode          Before each `npm install`, wipe the
                              `node_modules/` directory from every OTHER CDK
                              project in this workspace. Keeps disk usage
                              down on constrained environments (e.g.
                              CloudShell's 1 GB home limit) at the cost of
                              re-installing each project's deps on every
                              redeploy. Off by default — leaves each
                              project's `node_modules/` in place so the
                              IDE doesn't flag unresolved imports between
                              deploys.
  --no-rollback               Pass `--no-rollback` to every `cdk deploy`.
                              On a failed deploy, resources created so far are
                              KEPT (stack left in UPDATE_FAILED / CREATE_FAILED)
                              instead of being auto-rolled-back. Useful for
                              iterative bring-up debugging so you can inspect
                              partial state in the console. Off by default so
                              successful normal deploys don't leak half-built
                              stacks on transient errors.
  --only <component>          Deploy ONLY the named component and skip every
                              other layer. Implies --force-deploy for the
                              selected layer. Other layers' outputs are still
                              read from cdk-outputs/*.json to supply upstream
                              CfnParameters. Valid component keys (match
                              .deployment-state.json):
                                tel-ddb, tel-location, tel-lambdas,
                                tel-apigw, tel-gateway, tel-network,
                                tel-agent-ecr, tel-agent-build,
                                tel-agent-runtime, tel-sip-gateway,
                                tel-ingress-number, tel-ingress,
                                tel-synthetic-data
                              Example: --only tel-sip-gateway
  --chimePhoneSearch <spec>   Pin the Chime phone-number search spec instead
                              of auto-probing. Format: "toll-free:<3digits>"
                              or "local:<3digits>".
                              Examples:
                                --chimePhoneSearch toll-free:844
                                --chimePhoneSearch local:425
                              If omitted, the script probes toll-free prefixes
                              then local area codes and uses the first one
                              with available inventory.
  --user-name "<name>"        Display name used by the seeded loyalty
                              customer when --with-synthetic-data runs.
                              Mirrors reference-project --user-name.
  --user-phone <E.164>        E.164 phone number ("+12125550100") used as
                              the seeded loyalty customer's caller id.
                              Replaces reference-project's --user-email
                              since the telephony agent keys customers
                              by phone (hashed via the customer-id pepper).
  --company-name "<brand>"    Optional rebrand for the synthetic
                              locations (e.g. "Example Cafe"). Threaded
                              into populate-data.js verbatim.
  --with-synthetic-data       Run the tel-synthetic-data layer non-
                              interactively. Requires --user-name +
                              --user-phone and either --synth-location
                              + --synth-business-name OR the interactive
                              defaults (skipped in --non-interactive).
  --skip-synthetic-data       Skip the tel-synthetic-data layer entirely.
                              No prompt.
  --synth-location "<where>"  City / zip / address / "lat,lon" passed
                              through to populate-data.js. Required in
                              --with-synthetic-data unattended mode.
  --synth-business-name "<q>" Business-type search term passed through
                              to populate-data.js (e.g. "burgers").
                              Required in --with-synthetic-data
                              unattended mode.
  --help                      Show this help.

Prerequisites:
  - scripts/preflight-check.sh passes (Node >= 24, npm, aws v2, git).
  - AWS credentials and CDK bootstrap in us-east-1.
  - Nova Sonic model access granted in Bedrock (preflight probes this).
  - Chime SDK PSTN phone-number quota >= 1.
USAGE
      exit 0 ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      echo "Use --help for usage information." >&2
      exit 1 ;;
  esac
done

print_section() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo ""
}

print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }

################################################################################
# Helper functions (verbatim shape from reference-project/deploy-all.sh,
# adjusted project_dirs list to point at THIS feature's five new CDK dirs).
################################################################################

# Run npm install with proper error handling.
# Suppresses noise on success, shows full output on failure.
# When --low-storage-mode is set, frees disk space first by cleaning
# node_modules from other CDK projects (CloudShell has only ~1 GB home
# directory). Off by default so the IDE's language server keeps resolving
# imports between deploys — trades extra disk for zero red-folder noise.
safe_npm_install() {
  local current_dir
  current_dir=$(pwd)
  local project_dirs=(
    "backend/backend-infrastructure"
    "backend/agentcore-gateway/cdk"
    "backend/network"
    "backend/agentcore-runtime-telephony/cdk/ecr"
    "backend/agentcore-runtime-telephony/cdk/build"
    "backend/agentcore-runtime-telephony/cdk/runtime"
    "telephony-interface/telephony-sip-gateway/cdk"
    "telephony-interface/telephony-number/cdk"
    "telephony-interface/telephony-ingress/cdk"
    "backend/synthetic-data"
  )

  if [ "$LOW_STORAGE_MODE" = true ]; then
    for dir in "${project_dirs[@]}"; do
      local abs_dir="$WORKSPACE_ROOT/$dir"
      if [ "$abs_dir" != "$current_dir" ] && [ -d "$abs_dir/node_modules" ]; then
        rm -rf "$abs_dir/node_modules"
      fi
    done
  fi

  local output
  local exit_code
  set +e
  output=$(npm install --no-fund --no-audit 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    echo "$output"
    echo ""
    if echo "$output" | grep -q "ENOSPC"; then
      print_error "npm install failed — no disk space left"
      print_info "CloudShell has a 1 GB home directory limit."
      print_info "Re-run with --low-storage-mode to auto-clean sibling node_modules."
      print_info "Or manually: rm -rf ~/*/node_modules ~/.npm/_cacache && npm cache clean --force"
    else
      print_error "npm install failed (exit code $exit_code)"
    fi
    print_info "Directory: $(pwd)"
    exit 1
  fi

  echo "$output" | tail -1
}

# Helper: extract JSON value from file — json_val <file> <stack> <key> [default]
json_val() {
  local file=$1 stack=$2 key=$3 default=${4:-}
  node -e "const d=JSON.parse(require('fs').readFileSync('$file','utf8')); console.log((d['$stack']||{})['$key']||'$default')"
}

# Helper: extract JSON value from stdin
json_stdin() {
  local key=$1 default=${2:-}
  node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(b)['$key']||'$default')}catch(e){console.log('$default')}})"
}

################################################################################
# Up-front validation
################################################################################

# Validate prefix once, up front. Each stack also re-validates via
# CfnParameter.allowedPattern at deploy time.
if ! [[ "$PROJECT_PREFIX" =~ ^[a-z][a-z0-9-]{1,19}$ ]]; then
  print_error "--deploymentPrefix must match ^[a-z][a-z0-9-]{1,19}\$ (1-20 chars, start with letter)"
  exit 2
fi

# Validate --only key against the known component set.
VALID_COMPONENTS="tel-ddb tel-location tel-lambdas tel-apigw tel-gateway tel-network tel-agent-ecr tel-agent-build tel-agent-runtime tel-sip-gateway tel-ingress-number tel-ingress tel-synthetic-data"
if [ -n "$ONLY_COMPONENT" ]; then
  if ! echo " $VALID_COMPONENTS " | grep -q " $ONLY_COMPONENT "; then
    print_error "--only must be one of: $VALID_COMPONENTS"
    exit 2
  fi
  print_warning "--only $ONLY_COMPONENT — every other layer will be SKIPPED"
  print_info    "Upstream outputs will still be loaded from cdk-outputs/*.json"
fi

# should_deploy <component> — returns 0 when this layer should run, 1 when
# it should be skipped. Encapsulates the three gates:
#   1. --only <X> — run X, skip everything else.
#   2. --force-deploy — re-run every layer that is not skipped by --only.
#   3. Default (idempotent) — skip anything the state file marks as done.
should_deploy() {
  local component="$1"
  if [ -n "$ONLY_COMPONENT" ]; then
    [ "$ONLY_COMPONENT" = "$component" ]
    return
  fi
  if [ "$FORCE_DEPLOY" = true ] || [ "$(is_deployed "$component")" != "true" ]; then
    return 0
  fi
  return 1
}

# Run preflight checks unless skipped.
if [ "$SKIP_PREFLIGHT" = false ]; then
  print_section "Running Preflight Checks"
  "$SCRIPT_DIR/preflight-check.sh" || exit 1
fi

init_state
mkdir -p "$WORKSPACE_ROOT/$OUTPUTS_DIR"

# Handle fresh mode
if [ "$MODE" = "fresh" ]; then
  print_warning "Fresh mode: cleaning up existing deployment"
  "$SCRIPT_DIR/cleanup-all.sh" --force --ignore-missing-resources || true
  rm -f "$STATE_FILE_ABS"
  init_state
fi

print_section "Idempotent Deployment — Mode: $MODE, Prefix: $PROJECT_PREFIX"

# Optional --no-rollback flag threaded into every `cdk deploy` below. Empty
# string when not requested so bash word-splitting drops the argument cleanly.
CDK_ROLLBACK_FLAG=""
if [ "$NO_ROLLBACK" = true ]; then
  CDK_ROLLBACK_FLAG="--no-rollback"
  print_warning "--no-rollback is ON — failed deploys will LEAVE partial resources in place"
  print_info    "Re-run with the same prefix (or run cleanup-all.sh) to clean up"
fi

################################################################################
# Resolve Bedrock AgentCore Runtime-supported AZs (letters) for THIS account.
#
# Bedrock AgentCore Runtime only supports a subset of AZ IDs in each region
# (as of 2026-05 in us-east-1: use1-az1, use1-az2, use1-az4). AZ-ID-to-letter
# mapping is randomized per account — e.g. your `us-east-1a` may be any of
# `use1-az1`..`use1-az6`. We query the account's AZ mapping, filter to the
# supported IDs, and thread the first two matching zone letters into
# ${prefix}-NetworkStack as the `AvailabilityZones` CfnParameter.
#
# If Bedrock expands its AZ support, update BEDROCK_SUPPORTED_AZ_IDS below.
################################################################################
BEDROCK_SUPPORTED_AZ_IDS="use1-az1 use1-az2 use1-az4"
# Query the account's zone mapping and pick 2 supported zones.
# Output: comma-separated zone names (e.g. "us-east-1b,us-east-1d").
AGENTCORE_AZS=$(aws ec2 describe-availability-zones \
  --region us-east-1 \
  --filters Name=zone-type,Values=availability-zone \
  --query 'AvailabilityZones[].[ZoneName,ZoneId]' \
  --output text 2>/dev/null \
  | awk -v supported="$BEDROCK_SUPPORTED_AZ_IDS" '
      BEGIN { split(supported, arr, " "); for (i in arr) s[arr[i]] = 1; n = 0 }
      { if ($2 in s && n < 2) { if (n > 0) printf ","; printf "%s", $1; n++ } }
      END { print "" }
    ')

if [ -z "$AGENTCORE_AZS" ] || [ "$(echo "$AGENTCORE_AZS" | tr ',' '\n' | wc -l)" -lt 2 ]; then
  print_error "Could not find 2 Bedrock AgentCore Runtime-supported AZs in us-east-1 for this account."
  print_info  "Expected at least 2 zones mapping to AZ IDs in: $BEDROCK_SUPPORTED_AZ_IDS"
  print_info  "Run: aws ec2 describe-availability-zones --region us-east-1 --query 'AvailabilityZones[].[ZoneName,ZoneId]' --output table"
  print_info  "If Bedrock support has expanded, update BEDROCK_SUPPORTED_AZ_IDS in scripts/deploy-all.sh."
  exit 6
fi

print_info "Bedrock AgentCore-supported AZs in this account: $AGENTCORE_AZS"

################################################################################
# Auto-heal: remove orphan dev-prefix log groups + stuck CFN stacks before
# the deploy starts. Per working agreement #9: scripts must auto-heal where
# possible. The two recurring failure modes this addresses:
#
#   1. CloudWatch log groups for Lambda/CodeBuild/ECS/API Gateway are created
#      by AWS at first invocation, NOT by CDK. After a `cdk destroy` they
#      survive as orphans. The next `cdk deploy` then fails with
#      "Resource of type AWS::Logs::LogGroup ... already exists" because
#      CFN can't claim ownership of an existing resource it didn't create.
#      Fix: delete every orphan log group whose name starts with the project
#      prefix BEFORE `cdk deploy` runs.
#
#   2. CFN stacks left in REVIEW_IN_PROGRESS / ROLLBACK_COMPLETE from a
#      prior failed deploy block re-creation. CFN refuses `update-stack`
#      on those statuses; the stack must be deleted first.
#      Fix: scan project-known stack names and delete any in those states.
################################################################################
preflight_log_group_sweep() {
  local prefix="$1"
  local lgs
  # Patterns covering every project-owned log namespace.
  lgs=$(aws logs describe-log-groups --region us-east-1 \
    --query "logGroups[?starts_with(logGroupName, '/aws/lambda/${prefix}-') \
      || starts_with(logGroupName, '/aws/codebuild/${prefix}-') \
      || starts_with(logGroupName, '/ecs/${prefix}-') \
      || starts_with(logGroupName, '/aws/apigateway/${prefix}-')].logGroupName" \
    --output text 2>/dev/null || true)
  if [ -z "$lgs" ]; then
    print_info "Auto-heal: no orphan log groups for prefix '${prefix}'"
    return 0
  fi
  print_warning "Auto-heal: found orphan log groups for prefix '${prefix}', deleting..."
  for lg in $lgs; do
    if aws logs delete-log-group --region us-east-1 --log-group-name "$lg" 2>/dev/null; then
      echo "    deleted: $lg"
    else
      echo "    skipped (delete failed): $lg"
    fi
  done
}

preflight_stuck_stack_sweep() {
  local stuck_statuses="REVIEW_IN_PROGRESS ROLLBACK_COMPLETE"
  local project_stacks="DynamoDBStack LocationStack LambdaStack ApiGatewayStack \
    AgentCoreGatewayStack NetworkStack AgentEcrStack AgentBuildStack \
    AgentRuntimeStack SipGatewayStack IngressNumberStack IngressStack"
  for stack in $project_stacks; do
    local status
    status=$(aws cloudformation describe-stacks --region us-east-1 \
      --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")
    if echo "$stuck_statuses" | grep -qw "$status"; then
      print_warning "Auto-heal: stack '$stack' is in $status, deleting..."
      aws cloudformation delete-stack --region us-east-1 --stack-name "$stack" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name "$stack" 2>/dev/null || true
    fi
  done
}

print_section "Pre-deploy auto-heal sweep"
preflight_stuck_stack_sweep
preflight_log_group_sweep "$PROJECT_PREFIX"

################################################################################
# Resolve an available Chime phone-number search spec for Layer 10a
# (IngressNumberStack). Skipped entirely if the number is already
# deployed (state says true) — the persistent number does not need
# re-probing on every redeploy.
#
# Why: `ChimePhoneNumber` in cdk-amazon-chime-resources deploys by calling
# Chime's `search-available-phone-numbers` + `createPhoneNumberOrder` APIs
# at stack-create time. If the search returns zero numbers the custom
# resource fails with:
#     "No numbers were found with this search parameters."
# and the whole number stack rolls back.
#
# Fix: probe Chime's inventory BEFORE `cdk deploy` and thread a known-good
# search spec into the stack via --context. We try each candidate in order
# and stop on the first that reports >= 1 available number:
#
#   1. Toll-free prefixes (no geographic bias, largest pools): 833, 844,
#      855, 866, 877, 888, 800
#   2. Reliably-stocked US local area codes: 425, 312, 480, 512, 720, 216,
#      463, 737, 628, 984
#
# Operators can override the whole list via the --chimePhoneSearch flag,
# which accepts a single spec in the form "toll-free:844" or "local:425"
# and skips the auto-probe.
################################################################################
resolve_chime_search_spec() {
  local kind=$1  # "toll-free" or "local"
  local value=$2 # e.g. "844" or "425"
  local count
  if [ "$kind" = "toll-free" ]; then
    count=$(aws chime-sdk-voice search-available-phone-numbers \
              --region us-east-1 \
              --phone-number-type TollFree \
              --toll-free-prefix "$value" \
              --max-results 1 \
              --query 'length(E164PhoneNumbers || `[]`)' \
              --output text 2>/dev/null || echo 0)
  else
    count=$(aws chime-sdk-voice search-available-phone-numbers \
              --region us-east-1 \
              --phone-number-type Local \
              --area-code "$value" \
              --max-results 1 \
              --query 'length(E164PhoneNumbers || `[]`)' \
              --output text 2>/dev/null || echo 0)
  fi
  [ "${count:-0}" -ge 1 ] 2>/dev/null
}

CHIME_SEARCH_KIND=""
CHIME_SEARCH_VALUE=""

# Only probe if we're actually about to deploy the number stack. Otherwise
# we'd burn inventory queries on every redeploy of the plumbing layers.
if should_deploy tel-ingress-number; then
if [ -n "${CHIME_PHONE_SEARCH:-}" ]; then
  # Operator override: `--chimePhoneSearch toll-free:844` or `local:425`.
  CHIME_SEARCH_KIND=$(echo "$CHIME_PHONE_SEARCH" | cut -d: -f1)
  CHIME_SEARCH_VALUE=$(echo "$CHIME_PHONE_SEARCH" | cut -d: -f2)
  print_info "Using operator-supplied Chime search spec: $CHIME_SEARCH_KIND=$CHIME_SEARCH_VALUE (not probing inventory)"
else
  # Auto-probe: toll-free first (no geographic bias), then US local fallbacks.
  CHIME_TOLLFREE_CANDIDATES="833 844 855 866 877 888 800"
  CHIME_LOCAL_CANDIDATES="425 312 480 512 720 216 463 737 628 984"

  print_info "Probing Chime inventory for an available phone number..."
  for pfx in $CHIME_TOLLFREE_CANDIDATES; do
    if resolve_chime_search_spec "toll-free" "$pfx"; then
      CHIME_SEARCH_KIND="toll-free"
      CHIME_SEARCH_VALUE="$pfx"
      print_success "Found available toll-free numbers in prefix $pfx"
      break
    fi
  done

  if [ -z "$CHIME_SEARCH_KIND" ]; then
    for ac in $CHIME_LOCAL_CANDIDATES; do
      if resolve_chime_search_spec "local" "$ac"; then
        CHIME_SEARCH_KIND="local"
        CHIME_SEARCH_VALUE="$ac"
        print_success "Found available local numbers in area code $ac"
        break
      fi
    done
  fi
fi

if [ -z "$CHIME_SEARCH_KIND" ]; then
  print_error "No available Chime phone numbers found in any candidate prefix or area code."
  print_info  "Candidates tried: toll-free [$CHIME_TOLLFREE_CANDIDATES], local [$CHIME_LOCAL_CANDIDATES]"
  print_info  "You can pin a specific search via:"
  print_info  "  CHIME_PHONE_SEARCH=toll-free:844 ./scripts/deploy-all.sh --deploymentPrefix $PROJECT_PREFIX"
  print_info  "  CHIME_PHONE_SEARCH=local:404     ./scripts/deploy-all.sh --deploymentPrefix $PROJECT_PREFIX"
  exit 7
fi
fi  # end "only probe if the number stack is not already deployed"

################################################################################
# Layer 1 — DynamoDBStack (deployed as ${PROJECT_PREFIX}-DynamoDBStack)
# Part of the 4-stack backend app at backend/backend-infrastructure/.
# Owns Menu / Carts / Orders / Customers / Locations tables.
################################################################################

print_section "Layer 1: ${PROJECT_PREFIX}-DynamoDBStack"

if should_deploy tel-ddb; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy DynamoDBStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "DynamoDBStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json"
  )
  update_state "tel-ddb" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-ddb deployed"
else
  print_info "tel-ddb already deployed; skipping (use --force-deploy to override)"
fi

MENU_TABLE=$(json_val      "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" "DynamoDBStack" "MenuTableName")
CARTS_TABLE=$(json_val     "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" "DynamoDBStack" "CartsTableName")
ORDERS_TABLE=$(json_val    "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" "DynamoDBStack" "OrdersTableName")
CUSTOMERS_TABLE=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" "DynamoDBStack" "CustomersTableName")
LOCATIONS_TABLE=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" "DynamoDBStack" "LocationsTableName")

if [ -z "$MENU_TABLE" ] || [ -z "$CARTS_TABLE" ] || [ -z "$ORDERS_TABLE" ] \
   || [ -z "$CUSTOMERS_TABLE" ] || [ -z "$LOCATIONS_TABLE" ]; then
  print_error "Missing one or more table names from tel-ddb.json. Aborting."
  exit 5
fi

################################################################################
# Layer 2 — LocationStack (deployed as ${PROJECT_PREFIX}-LocationStack)
################################################################################

print_section "Layer 2: ${PROJECT_PREFIX}-LocationStack"

if should_deploy tel-location; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy LocationStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "LocationStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-location.json"
  )
  update_state "tel-location" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-location deployed"
else
  print_info "tel-location already deployed; skipping"
fi

PLACE_INDEX=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-location.json" "LocationStack" "PlaceIndexName")
ROUTE_CALC=$(json_val  "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-location.json" "LocationStack" "RouteCalculatorName")

if [ -z "$PLACE_INDEX" ] || [ -z "$ROUTE_CALC" ]; then
  print_error "Missing PlaceIndexName / RouteCalculatorName from tel-location.json. Aborting."
  exit 5
fi

################################################################################
# Layer 3 — LambdaStack (deployed as ${PROJECT_PREFIX}-LambdaStack)
# 10 ordering Lambdas with scoped DDB + Location grants.
################################################################################

print_section "Layer 3: ${PROJECT_PREFIX}-LambdaStack"

if should_deploy tel-lambdas; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy LambdaStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "LambdaStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "LambdaStack:MenuTableName=${MENU_TABLE}" \
      --parameters "LambdaStack:CartsTableName=${CARTS_TABLE}" \
      --parameters "LambdaStack:OrdersTableName=${ORDERS_TABLE}" \
      --parameters "LambdaStack:CustomersTableName=${CUSTOMERS_TABLE}" \
      --parameters "LambdaStack:LocationsTableName=${LOCATIONS_TABLE}" \
      --parameters "LambdaStack:PlaceIndexName=${PLACE_INDEX}" \
      --parameters "LambdaStack:RouteCalculatorName=${ROUTE_CALC}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json"
  )
  update_state "tel-lambdas" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-lambdas deployed"
else
  print_info "tel-lambdas already deployed; skipping"
fi

# Extract the 10 Lambda ARNs.
GET_CUSTOMER_PROFILE_ARN=$(json_val    "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GetCustomerProfileLambdaArn")
GET_PREVIOUS_ORDERS_ARN=$(json_val     "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GetPreviousOrdersLambdaArn")
GET_MENU_ARN=$(json_val                "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GetMenuLambdaArn")
ADD_TO_CART_ARN=$(json_val             "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "AddToCartLambdaArn")
GET_CART_ARN=$(json_val                "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GetCartLambdaArn")
UPDATE_CART_ARN=$(json_val             "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "UpdateCartLambdaArn")
PLACE_ORDER_ARN=$(json_val             "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "PlaceOrderLambdaArn")
GET_NEAREST_LOCATIONS_ARN=$(json_val   "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GetNearestLocationsLambdaArn")
FIND_LOCATION_ALONG_ROUTE_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "FindLocationAlongRouteLambdaArn")
GEOCODE_ADDRESS_ARN=$(json_val         "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-lambdas.json" "LambdaStack" "GeocodeAddressLambdaArn")

for var_name in GET_CUSTOMER_PROFILE_ARN GET_PREVIOUS_ORDERS_ARN GET_MENU_ARN \
                ADD_TO_CART_ARN GET_CART_ARN UPDATE_CART_ARN PLACE_ORDER_ARN \
                GET_NEAREST_LOCATIONS_ARN FIND_LOCATION_ALONG_ROUTE_ARN \
                GEOCODE_ADDRESS_ARN; do
  if [ -z "${!var_name}" ]; then
    print_error "Missing Lambda ARN $var_name from tel-lambdas.json. Aborting."
    exit 5
  fi
done

################################################################################
# Layer 4 — ApiGatewayStack (deployed as ${PROJECT_PREFIX}-ApiGatewayStack)
# REST API with AWS_IAM authorizer, 10 Lambda integrations.
################################################################################

print_section "Layer 4: ${PROJECT_PREFIX}-ApiGatewayStack"

if should_deploy tel-apigw; then
  (
    cd "$WORKSPACE_ROOT/backend/backend-infrastructure"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy ApiGatewayStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "ApiGatewayStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "ApiGatewayStack:GetCustomerProfileLambdaArn=${GET_CUSTOMER_PROFILE_ARN}" \
      --parameters "ApiGatewayStack:GetPreviousOrdersLambdaArn=${GET_PREVIOUS_ORDERS_ARN}" \
      --parameters "ApiGatewayStack:GetMenuLambdaArn=${GET_MENU_ARN}" \
      --parameters "ApiGatewayStack:AddToCartLambdaArn=${ADD_TO_CART_ARN}" \
      --parameters "ApiGatewayStack:GetCartLambdaArn=${GET_CART_ARN}" \
      --parameters "ApiGatewayStack:UpdateCartLambdaArn=${UPDATE_CART_ARN}" \
      --parameters "ApiGatewayStack:PlaceOrderLambdaArn=${PLACE_ORDER_ARN}" \
      --parameters "ApiGatewayStack:GetNearestLocationsLambdaArn=${GET_NEAREST_LOCATIONS_ARN}" \
      --parameters "ApiGatewayStack:FindLocationAlongRouteLambdaArn=${FIND_LOCATION_ALONG_ROUTE_ARN}" \
      --parameters "ApiGatewayStack:GeocodeAddressLambdaArn=${GEOCODE_ADDRESS_ARN}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-apigw.json"
  )
  update_state "tel-apigw" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-apigw deployed"
else
  print_info "tel-apigw already deployed; skipping"
fi

APIGW_ID=$(json_val          "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-apigw.json" "ApiGatewayStack" "ApiGatewayId")
APIGW_URL=$(json_val         "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-apigw.json" "ApiGatewayStack" "ApiGatewayUrl")
APIGW_REST_API_ID=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-apigw.json" "ApiGatewayStack" "ApiGatewayRestApiId")

if [ -z "$APIGW_ID" ] || [ -z "$APIGW_URL" ] || [ -z "$APIGW_REST_API_ID" ]; then
  print_error "Missing ApiGatewayId / ApiGatewayUrl / ApiGatewayRestApiId from tel-apigw.json. Aborting."
  exit 5
fi

################################################################################
# Layer 5 — AgentCoreGatewayStack (deployed as ${PROJECT_PREFIX}-AgentCoreGatewayStack)
# MCP + AWS_IAM gateway fronting the REST API. GatewayUrl is the PRIMARY
# handoff into the agent runtime layer downstream.
################################################################################

print_section "Layer 5: ${PROJECT_PREFIX}-AgentCoreGatewayStack"

if should_deploy tel-gateway; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-gateway/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy AgentCoreGatewayStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "AgentCoreGatewayStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayId=${APIGW_ID}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayUrl=${APIGW_URL}" \
      --parameters "AgentCoreGatewayStack:ApiGatewayRestApiId=${APIGW_REST_API_ID}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-gateway.json"
  )
  update_state "tel-gateway" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-gateway deployed"
else
  print_info "tel-gateway already deployed; skipping"
fi

GATEWAY_URL=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-gateway.json" "AgentCoreGatewayStack" "GatewayUrl")

if [ -z "$GATEWAY_URL" ]; then
  print_error "Missing GatewayUrl from tel-gateway.json. Aborting."
  exit 5
fi

################################################################################
# Layer 6 — NetworkStack (deployed as ${PROJECT_PREFIX}-NetworkStack)
################################################################################

print_section "Layer 6: ${PROJECT_PREFIX}-NetworkStack"

if should_deploy tel-network; then
  (
    cd "$WORKSPACE_ROOT/backend/network"
    safe_npm_install
    # shellcheck disable=SC2086  # word-splitting $CDK_ROLLBACK_FLAG is intentional — empty-string drops the arg
    npx cdk deploy NetworkStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "agentcoreAzs=${AGENTCORE_AZS}" \
      --parameters "NetworkStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-network.json"
  )
  update_state "tel-network" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-network deployed"
else
  print_info "tel-network already deployed; skipping (use --force-deploy to override)"
fi

VPC_ID=$(json_val   "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-network.json" "NetworkStack" "VpcId")
SUBNETS=$(json_val  "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-network.json" "NetworkStack" "PrivateSubnetIds")
PUBLIC_SUBNETS=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-network.json" "NetworkStack" "PublicSubnetIds")
AGENT_SG=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-network.json" "NetworkStack" "AgentSecurityGroupId")

if [ -z "$VPC_ID" ] || [ -z "$SUBNETS" ] || [ -z "$PUBLIC_SUBNETS" ] || [ -z "$AGENT_SG" ]; then
  print_error "Missing VpcId / PrivateSubnetIds / PublicSubnetIds / AgentSecurityGroupId from tel-network.json. Aborting."
  exit 5
fi

################################################################################
# Layer 7 — AgentEcrStack (deployed as ${PROJECT_PREFIX}-AgentEcrStack)
################################################################################

print_section "Layer 7: ${PROJECT_PREFIX}-AgentEcrStack"

if should_deploy tel-agent-ecr; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-runtime-telephony/cdk/ecr"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy AgentEcrStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "AgentEcrStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-ecr.json"
  )
  update_state "tel-agent-ecr" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-agent-ecr deployed"
else
  print_info "tel-agent-ecr already deployed; skipping"
fi

ECR_URI=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-ecr.json" "AgentEcrStack" "AgentEcrRepoUri")
ECR_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-ecr.json" "AgentEcrStack" "AgentEcrRepoArn")

if [ -z "$ECR_URI" ] || [ -z "$ECR_ARN" ]; then
  print_error "Missing AgentEcrRepoUri / AgentEcrRepoArn from tel-agent-ecr.json. Aborting."
  exit 5
fi

################################################################################
# Layer 8 — AgentBuildStack (deployed as ${PROJECT_PREFIX}-AgentBuildStack)
################################################################################

print_section "Layer 8: ${PROJECT_PREFIX}-AgentBuildStack"

if should_deploy tel-agent-build; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-runtime-telephony/cdk/build"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy AgentBuildStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "AgentBuildStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "AgentBuildStack:AgentEcrRepoUri=${ECR_URI}" \
      --parameters "AgentBuildStack:AgentEcrRepoArn=${ECR_ARN}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-build.json"
  )
  update_state "tel-agent-build" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-agent-build deployed"
else
  print_info "tel-agent-build already deployed; skipping"
fi

BUILD_WAITER_ARN=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-build.json" "AgentBuildStack" "BuildWaiterArn")

if [ -z "$BUILD_WAITER_ARN" ]; then
  print_error "Missing BuildWaiterArn from tel-agent-build.json. Aborting."
  exit 5
fi

################################################################################
# Layer 9 — AgentRuntimeStack (deployed as ${PROJECT_PREFIX}-AgentRuntimeStack)
# AgentCoreGatewayUrl now comes from Layer 5's tel-gateway.json (internal
# handoff) — no external file is read.
################################################################################

print_section "Layer 9: ${PROJECT_PREFIX}-AgentRuntimeStack"

if should_deploy tel-agent-runtime; then
  (
    cd "$WORKSPACE_ROOT/backend/agentcore-runtime-telephony/cdk/runtime"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy AgentRuntimeStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "AgentRuntimeStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "AgentRuntimeStack:AgentEcrRepoUri=${ECR_URI}" \
      --parameters "AgentRuntimeStack:AgentCoreGatewayUrl=${GATEWAY_URL}" \
      --parameters "AgentRuntimeStack:BuildWaiterArn=${BUILD_WAITER_ARN}" \
      --parameters "AgentRuntimeStack:CustomersTableName=${CUSTOMERS_TABLE}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-runtime.json"
  )
  update_state "tel-agent-runtime" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-agent-runtime deployed"
else
  print_info "tel-agent-runtime already deployed; skipping"
fi

RUNTIME_ARN=$(json_val     "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-agent-runtime.json" "AgentRuntimeStack" "AgentRuntimeArn")

if [ -z "$RUNTIME_ARN" ]; then
  print_error "Missing AgentRuntimeArn from tel-agent-runtime.json. Aborting."
  exit 5
fi

################################################################################
# Layer 9b — SipGatewayStack (deployed as ${PROJECT_PREFIX}-SipGatewayStack)
# drachtio + Node.js SIP gateway on Fargate behind an internal Network
# Load Balancer (NLB).
# Consumes the AgentCore Runtime ARN + the VPC from the NetworkStack;
# emits the NLB DNS name that IngressStack configures as the Chime Voice
# Connector's origination route.
################################################################################

print_section "Layer 9b: ${PROJECT_PREFIX}-SipGatewayStack"

if should_deploy tel-sip-gateway; then
  (
    cd "$WORKSPACE_ROOT/telephony-interface/telephony-sip-gateway/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy SipGatewayStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "SipGatewayStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "SipGatewayStack:VpcId=${VPC_ID}" \
      --parameters "SipGatewayStack:PrivateSubnetIds=${SUBNETS}" \
      --parameters "SipGatewayStack:PublicSubnetIds=${PUBLIC_SUBNETS}" \
      --parameters "SipGatewayStack:AgentRuntimeArn=${RUNTIME_ARN}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-sip-gateway.json"
  )
  update_state "tel-sip-gateway" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-sip-gateway deployed"
else
  print_info "tel-sip-gateway already deployed; skipping"
fi

SIP_GATEWAY_NLB_DNS=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-sip-gateway.json" "SipGatewayStack" "NlbDnsName")

if [ -z "$SIP_GATEWAY_NLB_DNS" ]; then
  print_error "Missing NlbDnsName from tel-sip-gateway.json. Aborting."
  exit 5
fi

################################################################################
# Layer 10a — IngressNumberStack (deployed as ${PROJECT_PREFIX}-IngressNumberStack)
#
# Owns ONLY the ChimePhoneNumber. Persistent across IngressStack rebuilds so
# iterating on the Voice Connector / SMA / SIP rule / SMA Lambda does not
# re-order a phone number every time. See telephony-interface/telephony-number/
# for rationale.
################################################################################

print_section "Layer 10a: ${PROJECT_PREFIX}-IngressNumberStack"

if should_deploy tel-ingress-number; then
  (
    cd "$WORKSPACE_ROOT/telephony-interface/telephony-number/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy IngressNumberStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --context "chimePhoneSearchKind=${CHIME_SEARCH_KIND}" \
      --context "chimePhoneSearchValue=${CHIME_SEARCH_VALUE}" \
      --parameters "IngressNumberStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ingress-number.json"
  )
  update_state "tel-ingress-number" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-ingress-number deployed"
else
  print_info "tel-ingress-number already deployed; skipping (Chime phone number is persistent — use cleanup-all.sh --include-number to release it)"
fi

PHONE=$(json_val "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ingress-number.json" "IngressNumberStack" "PhoneNumberE164")

if [ -z "$PHONE" ]; then
  print_error "Missing PhoneNumberE164 from tel-ingress-number.json. Aborting."
  exit 5
fi

################################################################################
# Layer 10b — IngressStack (deployed as ${PROJECT_PREFIX}-IngressStack)
# VC + SMA + SMA Lambda + SIP rule. Consumes PhoneNumberE164 from 10a.
################################################################################

print_section "Layer 10b: ${PROJECT_PREFIX}-IngressStack"

if should_deploy tel-ingress; then
  (
    cd "$WORKSPACE_ROOT/telephony-interface/telephony-ingress/cdk"
    safe_npm_install
    # shellcheck disable=SC2086
    npx cdk deploy IngressStack \
      --require-approval never \
      $CDK_ROLLBACK_FLAG \
      --parameters "IngressStack:DeploymentPrefix=${PROJECT_PREFIX}" \
      --parameters "IngressStack:SipGatewayNlbDnsName=${SIP_GATEWAY_NLB_DNS}" \
      --parameters "IngressStack:PhoneNumberE164=${PHONE}" \
      --outputs-file "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ingress.json"
  )
  update_state "tel-ingress" true "{\"prefix\":\"${PROJECT_PREFIX}\"}"
  print_success "tel-ingress deployed"
else
  print_info "tel-ingress already deployed; skipping"
fi

################################################################################
# Layer 11 — Synthetic data (optional)
#
# Seeds the DynamoDB tables owned by tel-ddb with a realistic set of
# Locations / Customers / Menu / Orders rows. Single loyalty customer is
# keyed by the pstn-<hash> that the live agent will derive on the first
# inbound call from --user-phone — the pepper SSM path is read from the
# same SSM SecureString the agent container reads at runtime, so the PK
# we write matches what the agent computes.
#
# Gate:
#   1. --skip-synthetic-data              -> skip unconditionally.
#   2. --with-synthetic-data              -> run unattended (requires
#                                            --user-name / --user-phone
#                                            and --synth-location /
#                                            --synth-business-name for
#                                            --non-interactive).
#   3. otherwise, prompt the operator interactively (default is Yes).
#
# Runs AFTER tel-agent-runtime so the pepper SSM parameter exists.
################################################################################

print_section "Layer 11: tel-synthetic-data (optional)"

SHOULD_SEED=false

if [ -n "$ONLY_COMPONENT" ] && [ "$ONLY_COMPONENT" != "tel-synthetic-data" ]; then
  print_info "tel-synthetic-data skipped (--only $ONLY_COMPONENT)"
elif [ "$SKIP_SYNTHETIC_DATA" = true ]; then
  print_info "tel-synthetic-data skipped (--skip-synthetic-data)"
elif [ "$WITH_SYNTHETIC_DATA" = true ]; then
  SHOULD_SEED=true
elif [ -n "$ONLY_COMPONENT" ] && [ "$ONLY_COMPONENT" = "tel-synthetic-data" ]; then
  SHOULD_SEED=true
elif [ -t 0 ]; then
  # Interactive shell — prompt operator.
  print_info "Seed the DynamoDB tables with synthetic Locations / Customers / Menu / Orders?"
  print_info "(You can re-run this step later with: ./scripts/deploy-all.sh --only tel-synthetic-data ...)"
  read -r -p "Seed synthetic data now? (Y/n): " ANSWER
  if [[ "$ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]] || [ -z "$ANSWER" ]; then
    SHOULD_SEED=true
  fi
else
  print_info "Non-interactive shell; neither --with-synthetic-data nor --skip-synthetic-data set. Skipping."
fi

if [ "$SHOULD_SEED" = true ]; then
  # Validate the two required flags NOW so we fail fast before npm install.
  if [ -z "$USER_NAME" ]; then
    print_error "--user-name is required when seeding synthetic data"
    exit 2
  fi
  if [ -z "$USER_PHONE" ]; then
    print_error "--user-phone is required when seeding synthetic data (E.164, e.g. +12125550100)"
    exit 2
  fi
  if ! [[ "$USER_PHONE" =~ ^\+[1-9][0-9]{1,14}$ ]]; then
    print_error "--user-phone must be E.164 format (got: $USER_PHONE)"
    exit 2
  fi

  DATA_ALREADY_SEEDED=$(is_deployed "tel-synthetic-data")

  # Honor the standard idempotency contract used by the other layers:
  # if already seeded and neither --force-deploy nor --only was passed,
  # do nothing.
  if [ "$DATA_ALREADY_SEEDED" = "true" ] && [ "$FORCE_DEPLOY" != true ] && [ "$ONLY_COMPONENT" != "tel-synthetic-data" ]; then
    print_info "tel-synthetic-data already seeded; skipping (pass --force-deploy or --only tel-synthetic-data to re-seed)"
  else
    (
      cd "$WORKSPACE_ROOT/backend/synthetic-data"
      safe_npm_install

      if [ "$DATA_ALREADY_SEEDED" = "true" ]; then
        print_warning "Re-seed requested - wiping existing Locations/Customers/Menu/Orders first"
        node cleanup-data.js --force
      fi

      # Build the node populate-data.js command. Non-interactive if either
      # --with-synthetic-data was passed AND --synth-location +
      # --synth-business-name were both supplied; interactive otherwise.
      NODE_ARGS=(
        populate-data.js
        --user-name "$USER_NAME"
        --user-phone "$USER_PHONE"
        --deployment-prefix "$PROJECT_PREFIX"
      )
      if [ -n "$COMPANY_NAME" ]; then
        NODE_ARGS+=(--company-name "$COMPANY_NAME")
      fi
      if [ -n "$SYNTH_LOCATION" ] && [ -n "$SYNTH_BUSINESS_NAME" ]; then
        NODE_ARGS+=(
          --location "$SYNTH_LOCATION"
          --business-name "$SYNTH_BUSINESS_NAME"
          --non-interactive
        )
      elif [ "$WITH_SYNTHETIC_DATA" = true ] && [ ! -t 0 ]; then
        print_error "--with-synthetic-data in a non-TTY shell requires --synth-location + --synth-business-name"
        exit 2
      fi

      node "${NODE_ARGS[@]}"
    )

    update_state "tel-synthetic-data" true "{\"prefix\":\"${PROJECT_PREFIX}\",\"user_phone\":\"${USER_PHONE}\"}"
    print_success "tel-synthetic-data seeded"
  fi
fi

################################################################################
# Final success line — matches AC1 regex when PHONE is populated.
# Em-dash is U+2014 (per AC1). This MUST be the final line of stdout.
################################################################################

printf 'Your telephony agent is live at %s — dial to test.\n' "$PHONE"
