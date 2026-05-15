#!/usr/bin/env bash

################################################################################
# End-to-End Deploy Test - Telephony Voice Ordering Agent
#
# Exercises AC1 from requirements.md: deploy-all.sh exits 0 and the final line
# of stdout matches:
#     ^Your telephony agent is live at \+[1-9]\d{1,14} — dial to test\.$
# (em-dash is U+2014).
#
# This test DOES NOT dial the provisioned phone number — manual dialing is AC2 /
# AC3 and requires a human caller. Canary-driven outbound dialing would be
# task 7.4 (optional, not implemented).
#
# WARNING: This test provisions real AWS resources and incurs cost. It requires
# AWS credentials in the environment and takes ~15-20 minutes to complete
# (CodeBuild ARM64 image build dominates).  Cleanup runs unconditionally on
# exit regardless of test pass/fail.
################################################################################

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/e2e-deploy-$$.log"

# Generate a throwaway prefix (5-digit epoch suffix -> under 20-char limit).
# `test-` prefix + 5 chars = 10 chars, well within the ^[a-z][a-z0-9-]{1,19}$
# regex enforced by both deploy-all.sh and every CfnParameter.
PREFIX="test-$(date +%s | tail -c 6)"

print_warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }

print_warn "This test provisions real AWS resources (~15-20 minutes, non-trivial cost)"
print_warn "Cleanup runs on exit — but a hard-kill (SIGKILL / lost network) may orphan resources"
print_info "Throwaway deployment prefix: ${PREFIX}"
print_info "Log file: ${LOG_FILE}"

# Ensure cleanup ALWAYS runs on exit, even on Ctrl-C / assertion failure.
cleanup() {
  local rc=$?
  echo ""
  print_info "Running cleanup-all.sh with --force --ignore-missing-resources"
  "${WORKSPACE_ROOT}/scripts/cleanup-all.sh" --force --ignore-missing-resources \
    >/dev/null 2>&1 || true
  if [ $rc -eq 0 ]; then
    print_success "E2E deploy test PASSED (final-line regex matched AC1)"
  else
    print_error "E2E deploy test FAILED (exit code ${rc})"
    print_info "See ${LOG_FILE} for the full deploy log"
  fi
  exit $rc
}
trap cleanup EXIT

# Run deploy-all.sh. Skip preflight (caller is assumed to have already verified
# the environment; re-running preflight inside the test just adds noise).
print_info "Starting deploy-all.sh..."
"${WORKSPACE_ROOT}/scripts/deploy-all.sh" \
  --deploymentPrefix "${PREFIX}" \
  --skip-preflight 2>&1 | tee "${LOG_FILE}"
DEPLOY_RC=${PIPESTATUS[0]}

if [ "${DEPLOY_RC}" -ne 0 ]; then
  print_error "deploy-all.sh exited with code ${DEPLOY_RC}"
  exit 1
fi

# AC1: the LAST line of stdout (not an intermediate one) must match the regex.
FINAL_LINE=$(tail -n 1 "${LOG_FILE}" | tr -d '\r')

# grep -P for Perl-compatible regex (U+2014 em-dash matches literally as one
# UTF-8 codepoint in the pattern; LC_ALL is already UTF-8 in CloudShell/macOS).
if printf '%s\n' "${FINAL_LINE}" | grep -Pq '^Your telephony agent is live at \+[1-9]\d{1,14} — dial to test\.$'; then
  print_success "AC1 regex matched: '${FINAL_LINE}'"
  exit 0
else
  print_error "AC1 regex did NOT match final line"
  print_info "Final line: '${FINAL_LINE}'"
  print_info "Expected regex: ^Your telephony agent is live at \\+[1-9]\\d{1,14} — dial to test\\.\$"
  exit 1
fi
