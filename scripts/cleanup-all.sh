#!/bin/bash

################################################################################
# Cleanup All - Telephony Voice Ordering Agent
#
# Deletes all ten telephony stacks in reverse DAG order.  Resumable via the
# shared .deployment-state.json.
#
# Each CDK app's bin/cdk.ts uses an UN-prefixed construct id (DynamoDBStack,
# LocationStack, LambdaStack, ApiGatewayStack, AgentCoreGatewayStack,
# NetworkStack, AgentEcrStack, AgentBuildStack, AgentRuntimeStack,
# IngressStack), so `cdk destroy <UnprefixedName>` is the correct incantation.
#
# Usage:
#   ./scripts/cleanup-all.sh [OPTIONS]
#
# Options:
#   --skip-ingress            Skip tel-ingress cleanup
#   --skip-sip-gateway        Skip tel-sip-gateway cleanup
#   --skip-agent-runtime      Skip tel-agent-runtime cleanup
#   --skip-agent-build        Skip tel-agent-build cleanup
#   --skip-agent-ecr          Skip tel-agent-ecr cleanup
#   --skip-network            Skip tel-network cleanup
#   --skip-gateway            Skip tel-gateway cleanup
#   --skip-apigw              Skip tel-apigw cleanup
#   --skip-lambdas            Skip tel-lambdas cleanup
#   --skip-location           Skip tel-location cleanup
#   --skip-ddb                Skip tel-ddb cleanup
#   --skip-synthetic-data     Skip scrubbing DDB rows seeded by
#                             backend/synthetic-data (safe — only matters
#                             when --skip-ddb is also set since otherwise
#                             the table itself is going to be destroyed)
#   --include-number          Also destroy tel-ingress-number (RELEASES the
#                             provisioned Chime phone number back to the pool).
#                             This is the default — see --preserve-number to
#                             opt out and keep the number across cleanups.
#   --preserve-number         Skip tel-ingress-number cleanup (keeps the Chime
#                             phone number across iterations). Useful when
#                             you want to retain the same dialable number
#                             through multiple deploy/cleanup cycles.
#                             Note: releasing the number (the default) is
#                             irreversible — the same E.164 cannot be
#                             recovered once Chime returns it to the pool.
#   --ignore-missing-resources  Continue even if stacks don't exist
#   --force                   Skip confirmation prompts
#   --dry-run                 Preview what would be deleted
#   --help                    Show this help
################################################################################

set +e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=deployment-state.sh
source "$SCRIPT_DIR/deployment-state.sh"

OUTPUTS_DIR="cdk-outputs"
SKIP_INGRESS=false
SKIP_SIP_GATEWAY=false
SKIP_AGENT_RUNTIME=false
# Project prefix for orphan resource sweeps. Read from .deployment-state.json
# if available, fall back to "dev" matching deploy-all.sh's default. Operators
# who deployed with a different prefix should pass --deploymentPrefix.
PROJECT_PREFIX="dev"
if [ -f .deployment-state.json ]; then
  state_prefix=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('.deployment-state.json','utf8'));
      const c = d.components || {};
      const first = Object.values(c).find(v => v && v.prefix);
      if (first && first.prefix) console.log(first.prefix);
    } catch (e) {}
  " 2>/dev/null || true)
  if [ -n "$state_prefix" ]; then
    PROJECT_PREFIX="$state_prefix"
  fi
fi

SKIP_AGENT_BUILD=false
SKIP_AGENT_ECR=false
SKIP_NETWORK=false
SKIP_GATEWAY=false
SKIP_APIGW=false
SKIP_LAMBDAS=false
SKIP_LOCATION=false
SKIP_DDB=false
# Opt out of scrubbing the DDB rows seeded by backend/synthetic-data.
# By default we run cleanup-data.js --force before dropping the tables
# so re-running deploy-all.sh --with-synthetic-data later starts clean.
SKIP_SYNTHETIC_DATA=false
# Default: release the Chime phone number along with the rest of the
# stack. End-to-end test cycles need to delete everything; operators who
# want to retain the number across iterations can opt out via
# --preserve-number.
INCLUDE_NUMBER=true
IGNORE_MISSING=true
FORCE=false
DRY_RUN=false
CONTINUE_ON_ERROR=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-ingress)            SKIP_INGRESS=true;        shift ;;
    --skip-sip-gateway)        SKIP_SIP_GATEWAY=true;    shift ;;
    --skip-agent-runtime)      SKIP_AGENT_RUNTIME=true;  shift ;;
    --skip-agent-build)        SKIP_AGENT_BUILD=true;    shift ;;
    --skip-agent-ecr)          SKIP_AGENT_ECR=true;      shift ;;
    --skip-network)            SKIP_NETWORK=true;        shift ;;
    --skip-gateway)            SKIP_GATEWAY=true;        shift ;;
    --skip-apigw)              SKIP_APIGW=true;          shift ;;
    --skip-lambdas)            SKIP_LAMBDAS=true;        shift ;;
    --skip-location)           SKIP_LOCATION=true;       shift ;;
    --skip-ddb)                SKIP_DDB=true;            shift ;;
    --skip-synthetic-data)     SKIP_SYNTHETIC_DATA=true; shift ;;
    --include-number)          INCLUDE_NUMBER=true;      shift ;;
    --preserve-number)         INCLUDE_NUMBER=false;     shift ;;
    --deploymentPrefix)        PROJECT_PREFIX="$2";      shift 2 ;;
    --ignore-missing-resources) IGNORE_MISSING=true; CONTINUE_ON_ERROR=true; shift ;;
    --force)                   FORCE=true;               shift ;;
    --dry-run)                 DRY_RUN=true;             shift ;;
    --help) grep "^#" "$0" | grep -v "^#!/" | sed 's/^# //'; exit 0 ;;
    *) echo -e "${RED}❌ Unknown option: $1${NC}"; echo "Use --help for usage information"; exit 1 ;;
  esac
done

print_section() {
  echo ""
  echo -e "${BLUE}============================================================${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}============================================================${NC}"
  echo ""
}

print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }

# safe_npm_install cleans node_modules in every OTHER new-module CDK dir before
# running `npm install` in the current dir. Matches the pattern used by
# deploy-all.sh — needed because CloudShell has only ~1 GB of home-dir space.
safe_npm_install() {
  local current_dir
  current_dir=$(pwd)

  # During teardown we do NOT wipe sibling node_modules (the deploy script's
  # low-storage trick). Wiping siblings here was the root cause of the
  # "Cannot find module 'aws-cdk-lib'" destroy failures: a later destroy
  # step would find its modules already deleted by an earlier step, and the
  # conditional install below skipped reinstalling when the dir looked
  # partially present. Teardown touches each dir once; just ensure deps
  # exist and FAIL LOUDLY if the install errors (destroy cannot synth
  # without them).
  if [ ! -d "node_modules" ] || [ ! -d "node_modules/aws-cdk-lib" ]; then
    print_info "Installing dependencies in $(basename "$current_dir")..."
    if ! npm install --no-fund --no-audit > /dev/null 2>&1; then
      print_error "npm install failed in $current_dir — cdk destroy cannot synthesize without dependencies."
      print_info  "Re-run: (cd $current_dir && npm install) then re-run cleanup-all.sh"
      return 1
    fi
  fi

  # Guard against an aws-cdk CLI too old to read the aws-cdk-lib schema —
  # `cdk destroy` synthesizes first, so the same skew that breaks deploy
  # breaks destroy. aws-cdk and aws-cdk-lib use different version lines, so
  # we detect the skew authoritatively via CDK's own schema check (a cheap
  # `cdk ls`) rather than comparing version numbers. On skew we flip
  # USE_NPX_LATEST_CDK so destroy_stack pulls a current CLI via npx.
  if [ -f node_modules/aws-cdk-lib/package.json ]; then
    local probe
    probe=$(npx cdk ls 2>&1 || true)
    if echo "$probe" | grep -q "Cloud assembly schema version mismatch"; then
      print_warning "aws-cdk CLI too old for aws-cdk-lib in $(basename "$current_dir"); destroy will use npx cdk@latest."
      USE_NPX_LATEST_CDK=true
    fi
  fi
}

print_section "Telephony Voice Ordering Agent — Full Cleanup"

if [ "$DRY_RUN" = true ]; then
  print_warning "DRY RUN MODE - No resources will be deleted"
  echo ""
fi

if [ "$FORCE" != true ] && [ "$DRY_RUN" != true ]; then
  echo -e "${YELLOW}⚠️  WARNING: This will delete the telephony stacks!${NC}"
  echo ""
  echo "This includes (in reverse DAG order):"
  echo "  - IngressStack            (SMA, VC, SIP rule, SMA Lambda)"
  if [ "$INCLUDE_NUMBER" = true ]; then
    echo "  - IngressNumberStack      (⚠️  RELEASES the Chime phone number — not recoverable)"
  else
    echo "  - IngressNumberStack      (SKIPPED — pass --include-number to also destroy, or default to release)"
  fi
  echo "  - SipGatewayStack         (drachtio Fargate cluster + NLB + CodeBuild + ECR)"
  echo "  - AgentRuntimeStack       (AgentCore Runtime, pepper SSM)"
  echo "  - AgentBuildStack         (CodeBuild project, source bucket)"
  echo "  - AgentEcrStack           (ECR repository)"
  echo "  - NetworkStack            (VPC, subnets, NAT, SG)"
  echo "  - AgentCoreGatewayStack   (MCP/AWS_IAM gateway + provisioner Lambda)"
  echo "  - ApiGatewayStack         (REST API, AWS_IAM auth)"
  echo "  - LambdaStack             (10 ordering Lambdas)"
  echo "  - LocationStack           (place-index, route-calculator)"
  echo "  - DynamoDBStack           (5 tables: Menu, Carts, Orders, Customers, Locations)"
  echo ""
  echo -e "${RED}This action cannot be undone!${NC}"
  echo ""
  read -r -p "Are you sure you want to continue? (yes/no): " response
  if [[ "$response" != "yes" && "$response" != "y" ]]; then
    print_info "Cleanup cancelled"
    exit 0
  fi
fi

init_state

# ───────────── Resolve Bedrock AgentCore-supported AZs ─────────────
#
# `backend/network/lib/network-stack.ts` requires the `agentcoreAzs` CDK
# context key to synthesize, AND `cdk destroy` runs synthesis first. So
# we mirror the AZ resolution from deploy-all.sh here. If the AWS call
# fails (e.g. expired creds, network blip), we fall back to a sensible
# pair of letter values — the value is not actually consumed at destroy
# time, it only has to satisfy synth-time validation.
BEDROCK_SUPPORTED_AZ_IDS="use1-az1 use1-az2 use1-az4"
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
  print_warning "Could not resolve AZ mapping from AWS; using fallback us-east-1a,us-east-1b for synth-only context"
  AGENTCORE_AZS="us-east-1a,us-east-1b"
fi

# Chime phone-number search spec — IngressNumberStack also throws at synth
# time without one. The values are not consumed during destroy; pass any
# valid pair so synth completes.
CHIME_SEARCH_KIND="${CHIME_SEARCH_KIND:-toll-free}"
CHIME_SEARCH_VALUE="${CHIME_SEARCH_VALUE:-833}"

print_info "Starting cleanup in reverse DAG order..."
echo ""
OVERALL_SUCCESS=true

# Helper: destroy one stack with the shared error-handling semantics. Runs in
# a subshell so `cd` stays local. Respects --force / --dry-run / --ignore-
# missing-resources / --continue-on-error.
#
# Arguments:
#   $1 = CDK dir (relative to workspace root)
#   $2 = CDK construct id (UN-prefixed; matches bin/cdk.ts)
#   $3 = cdk-outputs/<file>.json basename
#   $4 = component key for .deployment-state.json
#   $5 = optional extra cdk flags (space-separated, e.g. "--context k=v")
#        Some stacks throw at synth time if a required CfnParameter or
#        Context key is missing — even on `cdk destroy` (synth runs first).
#        Pass dummy-but-valid values here so destroy can proceed; the
#        physical resources are deleted by stack name regardless.
destroy_stack() {
  local cdk_dir=$1
  local stack_id=$2
  local outputs_file=$3
  local component_key=$4
  local extra_flags=${5:-}
  local destroy_flags=""

  if [ "$FORCE" = true ]; then
    destroy_flags="--force"
  fi

  if [ "$DRY_RUN" = true ]; then
    print_info "Would destroy $stack_id (cdk dir: $cdk_dir)"
    return 0
  fi

  (
    set -e
    cd "$WORKSPACE_ROOT/$cdk_dir"
    USE_NPX_LATEST_CDK=false
    safe_npm_install
    # When safe_npm_install detected a CLI/lib skew (local CLI too old to
    # read the lib schema), pull a current CLI via npx so destroy can still
    # synthesize. --yes auto-accepts the npx package install so it never
    # hangs on an interactive "Ok to proceed?" prompt in a background run.
    # shellcheck disable=SC2086
    if [ "${USE_NPX_LATEST_CDK:-false}" = true ]; then
      npx --yes cdk@latest destroy $destroy_flags $extra_flags "$stack_id"
    else
      npx cdk destroy $destroy_flags $extra_flags "$stack_id"
    fi
  )
  local ec=$?
  if [ $ec -eq 0 ]; then
    print_success "$stack_id destroyed"
    update_state "$component_key" false "{}"
    rm -f "$WORKSPACE_ROOT/$OUTPUTS_DIR/$outputs_file"
  else
    print_error "$stack_id destroy failed (exit $ec)"
    if [ "$IGNORE_MISSING" != true ] && [ "$CONTINUE_ON_ERROR" = false ]; then
      exit 1
    fi
    OVERALL_SUCCESS=false
  fi
}

# Step 0: Synthetic data (runs before any stack destroy so we wipe rows
# while the tables are still alive). No-op when tel-ddb was never
# deployed — cleanup-data.js prints a clean "deployment outputs not
# found" and exits. We also skip when --skip-synthetic-data is passed
# (operator already wiped manually, or wants the rows retained for a
# post-cleanup snapshot).
if [ "$SKIP_SYNTHETIC_DATA" = false ] && [ "$SKIP_DDB" = false ]; then
  print_section "Step 0: Scrubbing synthetic-data rows"
  if [ "$(is_deployed tel-synthetic-data)" = "true" ] || [ -f "$WORKSPACE_ROOT/$OUTPUTS_DIR/tel-ddb.json" ]; then
    if [ "$DRY_RUN" = true ]; then
      print_info "[dry-run] would run: node backend/synthetic-data/cleanup-data.js --force"
    else
      (
        cd "$WORKSPACE_ROOT/backend/synthetic-data"
        if [ -d node_modules ]; then
          node cleanup-data.js --force || print_warning "synthetic-data cleanup reported errors (continuing)"
        else
          print_info "node_modules not installed under backend/synthetic-data; skipping row scrub (tables will be destroyed anyway)"
        fi
      )
    fi
    # Clear state regardless of whether rows existed - the tables are next.
    if [ "$DRY_RUN" = false ]; then
      update_state "tel-synthetic-data" false "{}"
    fi
  else
    print_info "tel-synthetic-data not seeded; skipping"
  fi
else
  print_info "Skipping synthetic-data scrub"
fi

# Step 1: Ingress (reverse-order first)
if [ "$SKIP_INGRESS" = false ]; then
  print_section "Step 1: Destroying IngressStack"
  if [ "$(is_deployed tel-ingress)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "telephony-interface/telephony-ingress/cdk" \
      "IngressStack" \
      "tel-ingress.json" \
      "tel-ingress"
  else
    print_info "tel-ingress not deployed; skipping"
  fi
else
  print_warning "Skipping Ingress cleanup"
fi

# Step 1b: IngressNumber — released by default. Use --preserve-number to
# retain the number across cleanups (useful when iterating on plumbing
# without losing the same dialable E.164).
if [ "$INCLUDE_NUMBER" = true ]; then
  print_section "Step 1b: Destroying IngressNumberStack (releases the Chime phone number)"
  if [ "$(is_deployed tel-ingress-number)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "telephony-interface/telephony-number/cdk" \
      "IngressNumberStack" \
      "tel-ingress-number.json" \
      "tel-ingress-number" \
      "--context chimePhoneSearchKind=${CHIME_SEARCH_KIND} --context chimePhoneSearchValue=${CHIME_SEARCH_VALUE}"
  else
    print_info "tel-ingress-number not deployed; skipping"
  fi
else
  print_info "Retaining IngressNumberStack (Chime phone number) — --preserve-number was passed."
fi

# Step 1c: SipGatewayStack — r6 insertion. Must be destroyed before
# AgentRuntimeStack because the sip-gateway's Fargate task role references
# the runtime ARN; destroying the runtime first would leave the task role
# with a dangling grant (cosmetic — CFN handles it — but the reverse DAG
# order is cleaner).
if [ "$SKIP_SIP_GATEWAY" = false ]; then
  print_section "Step 1c: Destroying SipGatewayStack"
  if [ "$(is_deployed tel-sip-gateway)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "telephony-interface/telephony-sip-gateway/cdk" \
      "SipGatewayStack" \
      "tel-sip-gateway.json" \
      "tel-sip-gateway"
  else
    print_info "tel-sip-gateway not deployed; skipping"
  fi
else
  print_warning "Skipping SipGateway cleanup"
fi

# Step 2: Agent Runtime
if [ "$SKIP_AGENT_RUNTIME" = false ]; then
  print_section "Step 2: Destroying AgentRuntimeStack"
  if [ "$(is_deployed tel-agent-runtime)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-runtime-telephony/cdk/runtime" \
      "AgentRuntimeStack" \
      "tel-agent-runtime.json" \
      "tel-agent-runtime"
  else
    print_info "tel-agent-runtime not deployed; skipping"
  fi
else
  print_warning "Skipping Agent Runtime cleanup"
fi

# Step 3: Agent Build
if [ "$SKIP_AGENT_BUILD" = false ]; then
  print_section "Step 3: Destroying AgentBuildStack"
  if [ "$(is_deployed tel-agent-build)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-runtime-telephony/cdk/build" \
      "AgentBuildStack" \
      "tel-agent-build.json" \
      "tel-agent-build"
  else
    print_info "tel-agent-build not deployed; skipping"
  fi
else
  print_warning "Skipping Agent Build cleanup"
fi

# Step 4: Agent ECR
if [ "$SKIP_AGENT_ECR" = false ]; then
  print_section "Step 4: Destroying AgentEcrStack"
  if [ "$(is_deployed tel-agent-ecr)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-runtime-telephony/cdk/ecr" \
      "AgentEcrStack" \
      "tel-agent-ecr.json" \
      "tel-agent-ecr"
  else
    print_info "tel-agent-ecr not deployed; skipping"
  fi
else
  print_warning "Skipping Agent ECR cleanup"
fi

# Step 5: Network (agent-side complete — now destroy the backend layers)
if [ "$SKIP_NETWORK" = false ]; then
  print_section "Step 5: Destroying NetworkStack"
  if [ "$(is_deployed tel-network)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/network" \
      "NetworkStack" \
      "tel-network.json" \
      "tel-network" \
      "--context agentcoreAzs=${AGENTCORE_AZS}"
  else
    print_info "tel-network not deployed; skipping"
  fi
else
  print_warning "Skipping Network cleanup"
fi

# Step 6: AgentCoreGateway (must be destroyed before the REST API it fronts)
if [ "$SKIP_GATEWAY" = false ]; then
  print_section "Step 6: Destroying AgentCoreGatewayStack"
  if [ "$(is_deployed tel-gateway)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/agentcore-gateway/cdk" \
      "AgentCoreGatewayStack" \
      "tel-gateway.json" \
      "tel-gateway"
  else
    print_info "tel-gateway not deployed; skipping"
  fi
else
  print_warning "Skipping AgentCoreGateway cleanup"
fi

# Step 7: ApiGateway
if [ "$SKIP_APIGW" = false ]; then
  print_section "Step 7: Destroying ApiGatewayStack"
  if [ "$(is_deployed tel-apigw)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "ApiGatewayStack" \
      "tel-apigw.json" \
      "tel-apigw"
  else
    print_info "tel-apigw not deployed; skipping"
  fi
else
  print_warning "Skipping ApiGateway cleanup"
fi

# Step 8: Lambda (10 ordering Lambdas — must go before DDB + Location since
# their IAM policies reference those ARNs at deploy time; destroy is safe any
# order but we match DAG reverse for consistency)
if [ "$SKIP_LAMBDAS" = false ]; then
  print_section "Step 8: Destroying LambdaStack"
  if [ "$(is_deployed tel-lambdas)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "LambdaStack" \
      "tel-lambdas.json" \
      "tel-lambdas"
  else
    print_info "tel-lambdas not deployed; skipping"
  fi
else
  print_warning "Skipping Lambda cleanup"
fi

# Step 9: Location
if [ "$SKIP_LOCATION" = false ]; then
  print_section "Step 9: Destroying LocationStack"
  if [ "$(is_deployed tel-location)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "LocationStack" \
      "tel-location.json" \
      "tel-location"
  else
    print_info "tel-location not deployed; skipping"
  fi
else
  print_warning "Skipping Location cleanup"
fi

# Step 10: DynamoDB (5 tables — last because everything depends on them)
if [ "$SKIP_DDB" = false ]; then
  print_section "Step 10: Destroying DynamoDBStack"
  if [ "$(is_deployed tel-ddb)" = "true" ] || [ "$IGNORE_MISSING" = true ]; then
    destroy_stack \
      "backend/backend-infrastructure" \
      "DynamoDBStack" \
      "tel-ddb.json" \
      "tel-ddb"
  else
    print_info "tel-ddb not deployed; skipping"
  fi
else
  print_warning "Skipping DynamoDB cleanup"
fi

print_section "Cleanup Complete!"

if [ "$DRY_RUN" = false ] && [ "$OVERALL_SUCCESS" = true ] && [ -f "$STATE_FILE_ABS" ]; then
  if [ "$INCLUDE_NUMBER" = true ]; then
    rm -f "$STATE_FILE_ABS"
    print_info "Removed deployment state file"
  else
    print_info "Preserving deployment state file — IngressNumberStack is retained. Re-run without --preserve-number to fully tear down."
  fi
elif [ "$DRY_RUN" = false ] && [ "$OVERALL_SUCCESS" = false ]; then
  print_warning "State file preserved — re-run cleanup to finish remaining components"
fi

if [ -d "$WORKSPACE_ROOT/$OUTPUTS_DIR" ]; then
  if [ -z "$(ls -A "$WORKSPACE_ROOT/$OUTPUTS_DIR" 2>/dev/null)" ]; then
    if [ "$DRY_RUN" = false ]; then
      rmdir "$WORKSPACE_ROOT/$OUTPUTS_DIR" 2>/dev/null || true
      print_info "Removed empty outputs directory"
    fi
  fi
fi

if [ "$DRY_RUN" = true ]; then
  print_warning "DRY RUN completed - no resources were deleted"
  echo ""
  print_info "Run without --dry-run to actually delete resources"
elif [ "$OVERALL_SUCCESS" = true ]; then
  # ───────────── Post-cleanup auto-heal sweep ─────────────
  # Every Lambda, CodeBuild project, ECS task definition, and API Gateway
  # access log in this project pre-creates its CloudWatch log group through
  # CDK with `RemovalPolicy.DESTROY`. `cdk destroy` deletes them
  # symmetrically — no orphan log groups to chase. We deliberately do NOT
  # run a prefix-wide log-group sweep here: an earlier version did, but it
  # also nuked CDK-managed groups, leaving CFN with DELETED-drift on those
  # resources and the awslogs driver silently dropping logs into the void.
  # Fix that kind of leak in the CDK code, not by best-effort sweeps here.
  # Synthetic-data output JSONs (gitignored, but still pollute the working
  # tree; the synthetic-data layer regenerates them on the next deploy
  # anyway).
  if [ -d "$WORKSPACE_ROOT/backend/synthetic-data/output" ]; then
    rm -f "$WORKSPACE_ROOT/backend/synthetic-data/output/"*.json 2>/dev/null || true
    print_info "Auto-heal: removed stale synthetic-data output JSONs"
  fi

  print_success "All telephony stacks cleaned up"
else
  print_warning "Some stacks may not have been cleaned up. Check the errors above."
  echo ""
  print_info "Re-run ./scripts/cleanup-all.sh to resume — already-cleaned components will be skipped."
  exit 1
fi
