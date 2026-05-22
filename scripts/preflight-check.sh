#!/bin/bash
# Preflight for telephony-voice-ordering-agent.
#
# Validates developer-machine prerequisites per tasks.md task 1.4:
#   - Node.js major version >= 24 (accepts v24.x, v25.x, ...)
#   - npm present
#   - aws CLI v2 present (warn-only — only needed at deploy time)
#   - git present
#   - AWS credentials reachable (only when aws CLI present)
#   - CDK bootstrap >= v6 in the current region; auto-offer to fix
#   - Bedrock Nova 2 Sonic model access granted (warn-only if missing)
#   - NFR4 assertion: python/pip/poetry/uv/etc. are NOT required at the dev layer.
#
# Exits 0 on success. Exits 1 on any hard failure (unfixed bootstrap counts).

set +e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
AWS_CREDS_OK=false
AWS_CLI_OK=false
CDK_AVAILABLE=false

fail() { echo -e "${RED}❌ $1${NC}"; [ -n "${2-}" ] && echo -e "   ${YELLOW}→ $2${NC}"; FAIL=$((FAIL+1)); }
pass() { echo -e "${GREEN}✅ $1${NC}"; PASS=$((PASS+1)); }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# Node >= 24
if command -v node >/dev/null 2>&1; then
  NV=$(node --version | sed 's/v//')
  NM=$(echo "$NV" | cut -d. -f1)
  if [ "$NM" -ge 24 ] 2>/dev/null; then
    pass "Node.js $NV (>= 24)"
  else
    fail "Node.js $NV" "need >= 24.x"
  fi
else
  fail "Node.js not found" "install from https://nodejs.org (>= 24)"
fi

# npm
if command -v npm >/dev/null 2>&1; then
  pass "npm $(npm --version)"
else
  fail "npm not found"
fi

# npx (for `npx cdk bootstrap` auto-fix below)
if command -v npx >/dev/null 2>&1; then
  CDK_AVAILABLE=true
fi

# aws v2 (warn-only in sandbox / non-deploy contexts)
if command -v aws >/dev/null 2>&1; then
  AV=$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)
  case "$AV" in
    2.*) pass "AWS CLI $AV"; AWS_CLI_OK=true ;;
    *)   warn "AWS CLI $AV (v2 required for deploy; v1 detected)" ;;
  esac
else
  warn "AWS CLI not found (required at deploy time; not for local synth)"
fi

# git
if command -v git >/dev/null 2>&1; then
  pass "git $(git --version | awk '{print $3}')"
else
  fail "git not found"
fi

# AWS credentials (only when aws CLI is present)
if [ "$AWS_CLI_OK" = true ]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  if [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "None" ]; then
    pass "AWS credentials resolve to account $ACCOUNT_ID"
    AWS_CREDS_OK=true
  else
    warn "AWS credentials not configured (skip if running local synth only)"
  fi
fi

# CDK Bootstrap — mirrors reference-project/preflight-check.sh.
# The SSM parameter is the real source of truth CDK deploy checks (not the
# CloudFormation stack). Minimum required version is 6 (stable since CDK v2).
if [ "$CDK_AVAILABLE" = true ] && [ "$AWS_CREDS_OK" = true ]; then
  REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
  echo -e "${BLUE}🔎 CDK Bootstrap check (region: $REGION)${NC}"

  MIN_BOOTSTRAP_VERSION=6
  BOOTSTRAP_VERSION=$(aws ssm get-parameter \
    --name /cdk-bootstrap/hnb659fds/version \
    --region "$REGION" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || echo "")

  if [ -n "$BOOTSTRAP_VERSION" ] && [ "$BOOTSTRAP_VERSION" -ge "$MIN_BOOTSTRAP_VERSION" ] 2>/dev/null; then
    pass "CDK bootstrapped in $REGION (version $BOOTSTRAP_VERSION)"
  else
    # Diagnose the failure mode for a clear message
    STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" --query 'Stacks[0].StackName' --output text 2>/dev/null || echo "")

    if [ -n "$STACK_EXISTS" ] && [ -z "$BOOTSTRAP_VERSION" ]; then
      echo ""
      fail "CDK Bootstrap is outdated"
      echo ""
      echo -e "   ${YELLOW}What happened:${NC} Your account was bootstrapped with an older version of CDK"
      echo -e "   that doesn't include the version tracking CDK needs to deploy."
      echo ""
      echo -e "   ${YELLOW}How to fix:${NC} Re-run the bootstrap command to update it."
      echo -e "   This is safe — it updates the existing setup without affecting your resources."
      echo ""
    elif [ -n "$BOOTSTRAP_VERSION" ] && [ "$BOOTSTRAP_VERSION" -lt "$MIN_BOOTSTRAP_VERSION" ] 2>/dev/null; then
      echo ""
      fail "CDK Bootstrap version too old (v${BOOTSTRAP_VERSION}, need v${MIN_BOOTSTRAP_VERSION}+)"
      echo ""
      echo -e "   ${YELLOW}What happened:${NC} Your bootstrap version ($BOOTSTRAP_VERSION) is older than what CDK requires ($MIN_BOOTSTRAP_VERSION)."
      echo ""
      echo -e "   ${YELLOW}How to fix:${NC} Re-run the bootstrap command to update it."
      echo -e "   This is safe — it updates the existing setup without affecting your resources."
      echo ""
    else
      echo ""
      fail "CDK not bootstrapped in $REGION"
      echo ""
      echo -e "   ${YELLOW}What is this?${NC} CDK bootstrap creates a small set of resources in your account"
      echo -e "   (an S3 bucket and IAM roles) that CDK needs to deploy CloudFormation stacks."
      echo -e "   This is a one-time setup per account/region."
      echo ""
    fi

    # Offer to auto-fix
    echo -ne "   ${CYAN}Would you like to fix this now? (y/n): ${NC}"
    read -r FIX_BOOTSTRAP

    if [[ "$FIX_BOOTSTRAP" =~ ^[Yy]$ ]]; then
      echo ""
      info "Running: npx cdk bootstrap aws://$ACCOUNT_ID/$REGION"
      echo ""
      if npx cdk bootstrap "aws://$ACCOUNT_ID/$REGION"; then
        # Auto-fix succeeded — decrement FAIL since we already counted it
        FAIL=$((FAIL-1))
        pass "CDK bootstrapped successfully in $REGION"
      else
        fail "Bootstrap failed" "try running manually: npx cdk bootstrap aws://$ACCOUNT_ID/$REGION"
      fi
    fi
  fi
elif [ "$CDK_AVAILABLE" = true ] && [ "$AWS_CREDS_OK" = false ]; then
  warn "Skipping CDK Bootstrap check — AWS credentials not configured"
fi

# Bedrock Nova 2 Sonic access (warn-only — the agent needs it at runtime,
# not at deploy time, so we do not block).
if [ "$AWS_CLI_OK" = true ] && [ "$AWS_CREDS_OK" = true ]; then
  REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
  if aws bedrock list-foundation-models \
        --region "$REGION" \
        --query "modelSummaries[?contains(modelId, 'nova-sonic')].modelId" \
        --output text 2>/dev/null | grep -q "nova-sonic"; then
    pass "Bedrock Nova 2 Sonic access granted in $REGION"
  else
    warn "Bedrock Nova 2 Sonic access not granted in $REGION — request it in the Bedrock console before dialing"
  fi
fi

# Bedrock AgentCore Runtime supported AZs in this account. The service only
# runs in a subset of AZs per region and the ID-to-letter mapping is
# randomized per account. We probe and warn if fewer than 2 supported AZs
# are reachable. deploy-all.sh also enforces this as a hard error (exit 6).
if [ "$AWS_CLI_OK" = true ] && [ "$AWS_CREDS_OK" = true ]; then
  REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
  SUPPORTED_AZ_IDS="use1-az1 use1-az2 use1-az4"  # us-east-1 as of 2026-05
  MATCHED_AZS=$(aws ec2 describe-availability-zones \
    --region "$REGION" \
    --filters Name=zone-type,Values=availability-zone \
    --query 'AvailabilityZones[].[ZoneName,ZoneId]' \
    --output text 2>/dev/null \
    | awk -v supported="$SUPPORTED_AZ_IDS" '
        BEGIN { split(supported, arr, " "); for (i in arr) s[arr[i]] = 1 }
        { if ($2 in s) print $1 "=" $2 }
      ')
  MATCHED_COUNT=$(echo "$MATCHED_AZS" | grep -c '=' || echo 0)
  if [ "$MATCHED_COUNT" -ge 2 ]; then
    pass "Bedrock AgentCore Runtime-supported AZs available in $REGION ($(echo "$MATCHED_AZS" | tr '\n' ' '))"
  else
    warn "Only $MATCHED_COUNT Bedrock AgentCore-supported AZ(s) available in $REGION for this account"
    warn "Need at least 2 of ($SUPPORTED_AZ_IDS). deploy-all.sh will exit 6 if this holds at deploy time."
  fi
fi

# NFR4: assert we do not require python/pip/poetry/uv/etc.
info "NFR4: this workflow does NOT require python, pip, pip3, poetry, uv, pyenv, conda, openssl, uuidgen, portaudio, libsrtp, ffmpeg at the dev layer. All Python work runs inside CodeBuild at deploy time."

# CloudShell node_modules guidance
info "Each new-module CDK dir has its own node_modules — safe_npm_install cleans other dirs between deploys to stay under CloudShell's 1 GB home-dir limit. If you're NOT on CloudShell, ignore."

echo ""
echo -e "Passed: ${GREEN}$PASS${NC}   Failed: ${RED}$FAIL${NC}"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
