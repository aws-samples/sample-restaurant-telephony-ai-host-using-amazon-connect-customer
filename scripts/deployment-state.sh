#!/bin/bash

################################################################################
# Deployment State Manager
#
# Tracks deployment state for idempotent operations
# Uses Node.js for JSON manipulation (no Python dependency)
#
# Ported verbatim from reference-project/deployment-state.sh, with component
# keys updated to track this feature's thirteen layers:
#   tel-ddb, tel-location, tel-lambdas, tel-apigw, tel-gateway,
#   tel-network, tel-agent-ecr, tel-agent-build, tel-agent-runtime,
#   tel-sip-gateway, tel-ingress-number, tel-ingress, tel-synthetic-data
################################################################################

STATE_FILE=".deployment-state.json"
# Resolve to absolute path so it works from any subdirectory.
# Reference resolves relative to this file's own dir; we want the workspace root,
# which is the parent dir of scripts/ — walk one level up.
STATE_FILE_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/$STATE_FILE"

# Initialize state file if it doesn't exist
init_state() {
  if [ ! -f "$STATE_FILE_ABS" ]; then
    cat > "$STATE_FILE_ABS" <<EOF
{
  "version": "1.0",
  "last_updated": "",
  "components": {
    "tel-ddb": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-location": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-lambdas": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-apigw": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-gateway": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-network": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-agent-ecr": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-agent-build": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-agent-runtime": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-sip-gateway": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-ingress-number": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-ingress": {
      "deployed": false,
      "timestamp": ""
    },
    "tel-synthetic-data": {
      "deployed": false,
      "timestamp": ""
    }
  }
}
EOF
  fi
}

# Update component state
update_state() {
  local component=$1
  local deployed=$2
  local extra_data=$3

  init_state

  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('$STATE_FILE_ABS', 'utf8'));
state.last_updated = '$timestamp';
if (!state.components['$component']) {
  state.components['$component'] = { deployed: false, timestamp: '' };
}
state.components['$component'].deployed = ('$deployed'.toLowerCase() === 'true');
state.components['$component'].timestamp = '$timestamp';
if ('$extra_data') {
  Object.assign(state.components['$component'], JSON.parse('$extra_data'));
}
fs.writeFileSync('$STATE_FILE_ABS', JSON.stringify(state, null, 2));
"
}

# Check if component is deployed
is_deployed() {
  local component=$1

  if [ ! -f "$STATE_FILE_ABS" ]; then
    echo "false"
    return
  fi

  node -e "
try {
  const state = JSON.parse(require('fs').readFileSync('$STATE_FILE_ABS', 'utf8'));
  const c = state.components['$component'];
  console.log((c && c.deployed) ? 'true' : 'false');
} catch(e) { console.log('false'); }
"
}

# Get component data
get_state_data() {
  local component=$1
  local key=$2

  if [ ! -f "$STATE_FILE_ABS" ]; then
    echo ""
    return
  fi

  node -e "
try {
  const state = JSON.parse(require('fs').readFileSync('$STATE_FILE_ABS', 'utf8'));
  console.log(state.components['$component']['$key'] || '');
} catch(e) { console.log(''); }
"
}

# Check if CloudFormation stack exists
stack_exists() {
  local stack_name=$1
  local region=${2:-us-east-1}

  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$region" \
    --query 'Stacks[0].StackName' \
    --output text 2>/dev/null || echo ""
}

# Export functions
export -f init_state
export -f update_state
export -f is_deployed
export -f get_state_data
export -f stack_exists
