#!/usr/bin/env bash
################################################################################
# deployment-state.sh — Component state tracking for Connect AI Host deploy
#
# Shared by deploy-all.sh and cleanup-all.sh. Sources into the calling script.
# Uses node -e JSON manipulation (no Python dependency).
################################################################################

STATE_FILE="${WORKSPACE_ROOT}/.deployment-state.json"

# Component keys used in this project (cn = connect prefix)
COMPONENT_KEYS=(
  "cn-ddb"
  "cn-location"
  "cn-lambdas"
  "cn-apigw"
  "cn-instance"
  "cn-gateway"
  "cn-ai-agent"
  "cn-telephony"
  "cn-synthetic-data"
)

init_state() {
  if [ ! -f "$STATE_FILE" ]; then
    local json='{"version":"1.0","last_updated":"","components":{'
    local first=true
    for key in "${COMPONENT_KEYS[@]}"; do
      if [ "$first" = true ]; then first=false; else json+=","; fi
      json+="\"$key\":{\"deployed\":false,\"timestamp\":\"\",\"prefix\":\"\"}"
    done
    json+="}}"
    echo "$json" | node -e "
      const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      d.last_updated=new Date().toISOString();
      require('fs').writeFileSync('${STATE_FILE}',JSON.stringify(d,null,2));
    "
  fi
}

update_state() {
  local component=$1
  local deployed=$2
  local extra=${3:-"{}"}
  node -e "
    const fs=require('fs');
    const d=JSON.parse(fs.readFileSync('${STATE_FILE}','utf8'));
    const extra=JSON.parse('${extra}');
    d.components['$component']=Object.assign(d.components['$component']||{},{
      deployed:$deployed,
      timestamp:new Date().toISOString(),
      ...extra
    });
    d.last_updated=new Date().toISOString();
    fs.writeFileSync('${STATE_FILE}',JSON.stringify(d,null,2));
  "
}

is_deployed() {
  local component=$1
  node -e "
    const d=JSON.parse(require('fs').readFileSync('${STATE_FILE}','utf8'));
    console.log((d.components['$component']||{}).deployed||false);
  "
}

get_state_data() {
  local component=$1
  local key=$2
  local default_val=${3:-""}
  node -e "
    const d=JSON.parse(require('fs').readFileSync('${STATE_FILE}','utf8'));
    const v=(d.components['$component']||{})['$key']||'$default_val';
    console.log(v);
  "
}

stack_exists() {
  local stack_name=$1
  aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null | \
    grep -qv "DELETE_COMPLETE" && return 0 || return 1
}
