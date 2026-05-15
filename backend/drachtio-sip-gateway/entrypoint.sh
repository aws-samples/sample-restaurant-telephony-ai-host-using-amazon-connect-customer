#!/bin/bash
#
# Container entrypoint. Responsibilities:
#   1. Resolve the task's primary ENI IPv4 and its Availability Zone (AZ)
#      via the ECS Container Metadata Endpoint (v4). Fall back to
#      Instance Metadata Service (IMDS) v2 for non-Fargate dev runs on EC2.
#   2. Resolve the public-facing Network Load Balancer (NLB) IPv4 for the
#      SAME AZ the task is in. NLB cross-zone is OFF — each AZ has its
#      own public IP, and return RTP from the caller has to land on the
#      NLB IP in the same AZ the task runs in so the UDP flow makes a
#      complete round-trip.  Mapping: resolve NLB DNS (AAAA records
#      round-robin across AZs), then for each public IPv4 look up its
#      ENI and pick the one whose SubnetId is in the task's AZ.
#   3. Substitute ${LOCAL_IP} into /etc/rtpengine/rtpengine.conf with
#      the private!public syntax ("bind on private, advertise public in
#      SDP") and ${DRACHTIO_SECRET} into /etc/drachtio.conf.xml.
#   4. Spawn drachtio-server, rtpengine, and the Node.js app as children.
#      drachtio's --external-ip is the NLB public IP so Contact and Via
#      headers advertise a routable address back to Chime.
#   5. If any of the three exits, kill the whole process group so ECS
#      replaces the task.
#
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ----------------------------------------------------------------------
# 1. Resolve local IP + AZ.
# ----------------------------------------------------------------------

local_ip=""
local_az=""

if [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
  meta_json=$(curl --silent --max-time 2 "$ECS_CONTAINER_METADATA_URI_V4/task" || true)
  local_ip=$(echo "$meta_json" | jq -r '.Containers[0].Networks[0].IPv4Addresses[0] // empty' 2>/dev/null || true)
  local_az=$(echo "$meta_json" | jq -r '.AvailabilityZone // empty' 2>/dev/null || true)
fi

if [ -z "$local_ip" ]; then
  token=$(curl --silent --max-time 2 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)
  if [ -n "$token" ]; then
    local_ip=$(curl --silent --max-time 2 \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || true)
    local_az=$(curl --silent --max-time 2 \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/placement/availability-zone 2>/dev/null || true)
  fi
fi

if [ -z "$local_ip" ]; then
  log "WARN: could not discover local IP; binding 0.0.0.0"
  local_ip="0.0.0.0"
fi

log "local_ip=$local_ip local_az=${local_az:-unknown}"

# ----------------------------------------------------------------------
# 2. Resolve the public IP we advertise to Chime (r7).
#
# Under r7 (design §19) the Fargate task's own ENI gets an auto-assigned
# public IP and Chime sends RTP directly to it. The task advertises this
# IP in the SDP `c=` line, so Chime's RTP leg bypasses the NLB entirely.
#
# Priority order:
#   (a) $PUBLIC_IP_OVERRIDE — explicit override for dev/debugging.
#   (b) ECS task metadata v4 → ec2:DescribeTasks → DescribeNetworkInterfaces
#       on the task's own ENI. This is the canonical r7 path once the
#       service is deployed with assignPublicIp=true.
#   (c) IMDS v2 public-ipv4 lookup — works on EC2 (non-Fargate dev runs).
#   (d) Legacy r6 fallback: per-AZ NLB public IP. Kept so this image can
#       run unchanged in the r6 private-subnet layout during the staged
#       cutover (tasks 11.2 → 11.5 → 11.7). Once task 11.10 strips the
#       NLB UDP listeners this branch is still harmless (nothing points
#       at it) but can be deleted post-stabilization.
#   (e) Last resort: $SIP_EXT_HOST (hostname) or $local_ip.
# ----------------------------------------------------------------------

public_ip="${PUBLIC_IP_OVERRIDE:-${NLB_PUBLIC_IP:-}}"

# (b) Task's own ENI public IP via ECS metadata + ec2:DescribeNetworkInterfaces.
if [ -z "$public_ip" ] && [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
  task_meta=$(curl --silent --max-time 2 "$ECS_CONTAINER_METADATA_URI_V4/task" || true)
  task_arn=$(echo "$task_meta" | jq -r '.TaskARN // empty' 2>/dev/null || true)
  cluster_arn=$(echo "$task_meta" | jq -r '.Cluster // empty' 2>/dev/null || true)

  if [ -n "$task_arn" ] && [ -n "$cluster_arn" ]; then
    log "resolving task's own ENI public IP via ecs:DescribeTasks ($task_arn)"

    eni_id=$(aws ecs describe-tasks \
      --region "${AWS_REGION:-us-east-1}" \
      --cluster "$cluster_arn" \
      --tasks "$task_arn" \
      --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value | [0]' \
      --output text 2>/dev/null || true)

    if [ -n "$eni_id" ] && [ "$eni_id" != "None" ]; then
      task_public_ip=$(aws ec2 describe-network-interfaces \
        --region "${AWS_REGION:-us-east-1}" \
        --network-interface-ids "$eni_id" \
        --query 'NetworkInterfaces[0].Association.PublicIp' \
        --output text 2>/dev/null || true)

      if [ -n "$task_public_ip" ] && [ "$task_public_ip" != "None" ]; then
        public_ip="$task_public_ip"
        log "task-own public IP (eni=$eni_id) = $public_ip"
      else
        log "WARN: task ENI $eni_id has no public IP association (not r7-mode)"
      fi
    else
      log "WARN: could not extract networkInterfaceId from ecs:DescribeTasks"
    fi
  else
    log "WARN: ECS metadata missing TaskARN or Cluster — skipping task-ENI lookup"
  fi
fi

# (c) IMDS v2 — covers EC2 dev/test runs. Fargate's IMDS doesn't expose
# public-ipv4 normally, but the call is harmless when it fails.
if [ -z "$public_ip" ]; then
  token=$(curl --silent --max-time 2 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)
  if [ -n "$token" ]; then
    imds_pub=$(curl --silent --max-time 2 \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
    if [ -n "$imds_pub" ] && [[ "$imds_pub" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      public_ip="$imds_pub"
      log "task-own public IP from IMDS = $public_ip"
    fi
  fi
fi

# (d) Legacy r6 fallback — per-AZ NLB public IP. Kept as a safety net
# during the r7 staged cutover so this image works unchanged in the
# still-private-subnet + NLB-UDP layout. Delete post-11.10.
if [ -z "$public_ip" ] && [ -n "${SIP_EXT_HOST:-}" ] && [ -n "$local_az" ]; then
  log "falling back to NLB per-AZ EIP (r6 legacy path)"
  nlb_public_ip=$(aws ec2 describe-network-interfaces \
    --region "${AWS_REGION:-us-east-1}" \
    --filters "Name=interface-type,Values=network_load_balancer" \
              "Name=availability-zone,Values=$local_az" \
    --query 'NetworkInterfaces[0].Association.PublicIp' \
    --output text 2>/dev/null || true)
  if [ -n "$nlb_public_ip" ] && [ "$nlb_public_ip" != "None" ]; then
    public_ip="$nlb_public_ip"
    log "NLB public IP (legacy r6 fallback) for AZ=$local_az = $public_ip"
  fi
fi

# (e) Last resort: dig the NLB DNS name, then the hostname, then the
# private IP. Each is less useful than the previous — dig may not be
# AZ-aligned; hostnames don't work in SDP c=; private IPs are unreachable
# from Chime.
if [ -z "$public_ip" ] && [ -n "${SIP_EXT_HOST:-}" ]; then
  log "falling back to dig on NLB DNS ($SIP_EXT_HOST)"
  public_ip=$(dig +short +time=2 +tries=2 "$SIP_EXT_HOST" 2>/dev/null | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  if [ -n "$public_ip" ]; then
    log "WARN: using dig fallback $public_ip — may not be in task AZ=$local_az"
  fi
fi

if [ -z "$public_ip" ]; then
  public_ip="${SIP_EXT_HOST:-$local_ip}"
  log "WARN: no public IP resolved; using $public_ip (may be a hostname, may be private)"
fi

log "public_ip=$public_ip (advertised in SIP Contact and SDP c=/o=)"

# ----------------------------------------------------------------------
# 3. Substitute into config files.
# ----------------------------------------------------------------------

DRACHTIO_SECRET="${DRACHTIO_SECRET:-}"
if [ -z "$DRACHTIO_SECRET" ]; then
  log "ERROR: DRACHTIO_SECRET environment variable is required."
  log "  In Fargate this is injected by the SipGatewayStack task definition."
  log "  For local dev, generate one ahead of time, for example:"
  log "    export DRACHTIO_SECRET=\"\$(openssl rand -hex 16)\""
  exit 1
fi

# rtpengine is no longer used (the Node bridge speaks RTP directly
# with Chime), but we still keep this sed to keep the rtpengine.conf
# file syntactically valid if a future retry wants to enable it.
sed -i "s|\${LOCAL_IP}|$local_ip!$public_ip|g" /etc/rtpengine/rtpengine.conf 2>/dev/null || true
sed -i "s|\${DRACHTIO_SECRET}|$DRACHTIO_SECRET|g" /etc/drachtio.conf.xml

# ----------------------------------------------------------------------
# 4. Launch the child processes.
# ----------------------------------------------------------------------

export LOCAL_IP="$local_ip"
export PUBLIC_IP="$public_ip"
export DRACHTIO_ADMIN_PORT=9022
export DRACHTIO_SECRET

log "starting drachtio-server..."
# Drachtio's --external-ip populates the host portion of the SIP Contact,
# Via, and Record-Route headers on the 200 OK. Chime VC sends follow-up
# SIP (ACK, BYE, re-INVITE) directly to that Contact host, so it MUST be
# routable back to this task via a path the task SG permits.
#
# r7 corrigendum (design §19.6 + task 11.14): the task SG's TCP/5060
# ingress is locked to the NLB SG (invariant R28). If we advertise the
# task's own public IP in Contact, Chime's ACK is a direct TCP connect
# to <task-pub-ip>:5060 — blocked at the SG — and the dialog dies at
# ~32s with "never received ACK for final response". So Contact uses
# the NLB's public IP and SIP reaches the task via NLB → TCP/5060
# target group, the same path as the INVITE.
#
# Drachtio requires an IPv4 dotted-decimal literal for --external-ip
# (it rejects DNS names with "invalid format for externalIp"), so we
# resolve SIP_EXT_HOST (NLB DNS) to one of the NLB's public EIPs at
# container start. NLB cross-zone=true (post-task-11.10) means either
# AZ's EIP routes TCP/5060 to any healthy task, so picking the first
# A record is fine. EIPs are stable for an NLB's lifetime.
#
# Media (SDP c=) keeps using $public_ip (the task's own ENI public IP)
# via PUBLIC_IP → call-handler.js. That path is UDP 16000-16048 and is
# locked to Chime VC source CIDRs (R31), not the NLB SG — two different
# perimeters for two different L4 planes.
sip_contact_host="${SIP_EXT_HOST:-$public_ip}"
# If SIP_EXT_HOST is a DNS name, resolve it to an IPv4 for drachtio.
if [[ ! "$sip_contact_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  resolved_ip=$(getent hosts "$sip_contact_host" 2>/dev/null | awk '{print $1}' | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  if [ -z "$resolved_ip" ]; then
    resolved_ip=$(dig +short +time=2 +tries=2 "$sip_contact_host" 2>/dev/null | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  fi
  if [ -n "$resolved_ip" ]; then
    log "resolved SIP_EXT_HOST=$sip_contact_host -> $resolved_ip for drachtio --external-ip"
    sip_contact_host="$resolved_ip"
  else
    log "WARN: could not resolve $sip_contact_host to an IPv4; falling back to task pub IP $public_ip (ACK/BYE may not route back!)"
    sip_contact_host="$public_ip"
  fi
fi
log "drachtio --external-ip=$sip_contact_host (SDP c= uses $public_ip)"
drachtio \
  -f /etc/drachtio.conf.xml \
  --contact "sip:*:5060;transport=tcp" \
  --external-ip "$sip_contact_host" \
  --stdout &
drachtio_pid=$!

log "starting node app..."
node /app/src/index.js &
node_pid=$!

log "children running: drachtio=$drachtio_pid node=$node_pid"

wait -n "$drachtio_pid" "$node_pid"
exit_code=$?
log "a child exited with $exit_code; killing remaining children"
kill 0 2>/dev/null || true
exit "$exit_code"
