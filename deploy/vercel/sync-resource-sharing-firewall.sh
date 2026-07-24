#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERCEL_CWD="${VERCEL_CWD:-${ROOT_DIR}/apps/web}"
RATE_FILE="${NEXUS_FIREWALL_DESIRED_FILE:-${ROOT_DIR}/deploy/vercel/firewall/resource-sharing.json}"
MAINTENANCE_FILE="${NEXUS_MAINTENANCE_FIREWALL_DESIRED_FILE:-${ROOT_DIR}/deploy/vercel/firewall/resource-sharing-maintenance.json}"
PROJECT_FILE="${VERCEL_CWD}/.vercel/project.json"
MODE="apply"
STAGED_BY_SCRIPT=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy/vercel/sync-resource-sharing-firewall.sh [mode]

Modes:
  --check                Validate both checked-in rules without network access.
  --apply                Apply/publish/read back the permanent rate-limit rule.
  --remote-check         Read back the active permanent rule without mutation.
  --maintenance-apply    Apply/publish the temporary maintenance gate first.
  --maintenance-check    Verify the active maintenance gate and permanent limit.
  --maintenance-remove   Remove/publish the temporary maintenance gate.
  --maintenance-absent   Verify the maintenance gate is not active.

Remote modes require an authenticated Vercel CLI and a linked VERCEL_CWD.
Maintenance apply/check require NEXUS_RELEASE_SMOKE_IP as one exact public IP.
EOF
}

case "${1:---apply}" in
  --check) MODE="local-check" ;;
  --apply) MODE="apply" ;;
  --remote-check) MODE="remote-check" ;;
  --maintenance-apply) MODE="maintenance-apply" ;;
  --maintenance-check) MODE="maintenance-check" ;;
  --maintenance-remove) MODE="maintenance-remove" ;;
  --maintenance-absent) MODE="maintenance-absent" ;;
  -h|--help)
    usage
    exit 0
    ;;
  *) die "unknown argument: ${1:-}" ;;
esac

command -v jq >/dev/null 2>&1 || die "jq is required"
[ -f "$RATE_FILE" ] || die "desired state not found: ${RATE_FILE}"
[ -f "$MAINTENANCE_FILE" ] || die "desired state not found: ${MAINTENANCE_FILE}"

jq -e '
  keys == ["action", "active", "conditionGroup", "description", "name"]
  and .name == "Nexus public resource sharing"
  and .active == true
  and .conditionGroup == [{
    "conditions": [{
      "type": "path",
      "op": "re",
      "value": "^/api/public/resource-share(?:/.*)?$"
    }]
  }]
  and .action == {
    "mitigate": {
      "action": "rate_limit",
      "rateLimit": {
        "algo": "fixed_window",
        "window": 60,
        "limit": 120,
        "keys": ["ip"],
        "action": "deny"
      },
      "redirect": null,
      "actionDuration": null
    }
  }
' "$RATE_FILE" >/dev/null || die "permanent desired state violates the sharing WAF contract"

jq -e '
  keys == ["action", "active", "conditionGroup", "description", "name"]
  and .name == "Nexus cutover maintenance gate"
  and .active == true
  and .conditionGroup == [{
    "conditions": [
      {"type":"path","op":"re","value":"^/.*$"},
      {
        "type":"ip_address",
        "op":"neq",
        "value":"__NEXUS_RELEASE_SMOKE_IP__"
      }
    ]
  }]
  and .action == {
    "mitigate": {
      "action": "deny",
      "rateLimit": null,
      "redirect": null,
      "actionDuration": null
    }
  }
' "$MAINTENANCE_FILE" >/dev/null || die "maintenance desired state violates the cutover gate contract"

if [ "$MODE" = "local-check" ]; then
  echo "resource-sharing firewall desired states are locally valid; no network requests were made"
  exit 0
fi

command -v vercel >/dev/null 2>&1 || die "vercel CLI is required"
[ -f "$PROJECT_FILE" ] || die "VERCEL_CWD is not linked: ${VERCEL_CWD}"
project_id="$(jq -er '.projectId' "$PROJECT_FILE")"
team_id="$(jq -er '.orgId' "$PROJECT_FILE")"

vercel_cmd() {
  vercel "$@" --cwd "$VERCEL_CWD" --non-interactive
}

discard_owned_draft_on_failure() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$STAGED_BY_SCRIPT" = "1" ]; then
    echo "discarding unpublished firewall draft created by failed sync" >&2
    vercel_cmd firewall discard --yes >/dev/null || true
  fi
  exit "$status"
}
trap discard_owned_draft_on_failure EXIT

list_rules() {
  vercel_cmd firewall rules list --expand --json
}

require_clean_draft() {
  local listing="$1"
  [ "$(jq -r '.hasDraft' <<<"$listing")" = "false" ] || \
    die "unpublished Vercel firewall changes already exist; inspect or discard them first"
  [ "$(jq -r '.pendingChanges' <<<"$listing")" = "0" ] || \
    die "unpublished Vercel firewall changes already exist"
}

normalize_rule() {
  jq -cS '{
    name,
    description,
    active,
    conditionGroup,
    action
  }'
}

active_config() {
  vercel_cmd api \
    "/v1/security/firewall/config?projectId=${project_id}&teamId=${team_id}" \
    --raw
}

active_rules() {
  local config="$1"
  jq -c '.active.rules // []' <<<"$config"
}

active_named_rule() {
  local config="$1"
  local name="$2"
  local count
  count="$(
    active_rules "$config" |
      jq --arg name "$name" '[.[] | select(.name == $name)] | length'
  )"
  [ "$count" -le 1 ] || die "multiple active firewall rules named ${name}"
  active_rules "$config" | jq -c --arg name "$name" '.[] | select(.name == $name)'
}

require_exact_active_rule() {
  local config="$1"
  local desired="$2"
  local name
  local remote
  name="$(jq -r '.name' <<<"$desired")"
  remote="$(active_named_rule "$config" "$name")"
  [ -n "$remote" ] || die "active firewall rule is missing: ${name}"
  [ "$(normalize_rule <<<"$remote")" = "$(normalize_rule <<<"$desired")" ] || \
    die "active firewall rule differs from desired state: ${name}"
}

release_ip=""
maintenance_desired=""
if [ "$MODE" = "maintenance-apply" ] || [ "$MODE" = "maintenance-check" ]; then
  command -v python3 >/dev/null 2>&1 || die "python3 is required to validate release IP"
  release_ip="${NEXUS_RELEASE_SMOKE_IP:-}"
  [ -n "$release_ip" ] || die "NEXUS_RELEASE_SMOKE_IP is required"
  python3 -c \
    'import ipaddress,sys; ip=ipaddress.ip_address(sys.argv[1]); assert ip.is_global' \
    "$release_ip" 2>/dev/null || die "NEXUS_RELEASE_SMOKE_IP must be one public IP literal"
  maintenance_desired="$(
    jq -c --arg ip "$release_ip" '
      (.conditionGroup[0].conditions[1].value) = $ip
    ' "$MAINTENANCE_FILE"
  )"
fi
rate_desired="$(jq -c '.' "$RATE_FILE")"

if [ "$MODE" = "remote-check" ]; then
  config="$(active_config)"
  require_exact_active_rule "$config" "$rate_desired"
  echo "permanent resource-sharing firewall is active (configuration version $(jq -r '.active.version // \"unknown\"' <<<"$config"))"
  exit 0
fi

if [ "$MODE" = "maintenance-check" ]; then
  config="$(active_config)"
  require_exact_active_rule "$config" "$maintenance_desired"
  first_name="$(active_rules "$config" | jq -r '.[0].name // empty')"
  [ "$first_name" = "Nexus cutover maintenance gate" ] || \
    die "maintenance gate is not the first active custom rule"
  echo "maintenance gate is active and first (configuration version $(jq -r '.active.version // \"unknown\"' <<<"$config"))"
  exit 0
fi

if [ "$MODE" = "maintenance-absent" ]; then
  config="$(active_config)"
  require_exact_active_rule "$config" "$rate_desired"
  [ -z "$(active_named_rule "$config" "Nexus cutover maintenance gate")" ] || \
    die "maintenance gate is still active"
  echo "maintenance gate is absent and permanent rate limit is active"
  exit 0
fi

listing="$(list_rules)"
require_clean_draft "$listing"

stage_rule() {
  local desired="$1"
  local name
  local matches
  local count
  local rule_id
  name="$(jq -r '.name' <<<"$desired")"
  matches="$(jq -c --arg name "$name" '[.rules[] | select(.name == $name)]' <<<"$listing")"
  count="$(jq -r 'length' <<<"$matches")"
  [ "$count" -le 1 ] || die "multiple firewall rules named ${name}"
  if [ "$count" = "0" ]; then
    vercel_cmd firewall rules add --json "$desired" --yes >/dev/null
  else
    rule_id="$(jq -r '.[0].id' <<<"$matches")"
    [ -n "$rule_id" ] && [ "$rule_id" != "null" ] || die "rule ${name} has no id"
    if [ "$(normalize_rule <<<"$(jq -c '.[0]' <<<"$matches")")" = \
      "$(normalize_rule <<<"$desired")" ]; then
      return
    fi
    vercel_cmd firewall rules edit "$rule_id" --json "$desired" --yes >/dev/null
  fi
  STAGED_BY_SCRIPT=1
  listing="$(list_rules)"
}

publish_and_read_back() {
  if [ "$STAGED_BY_SCRIPT" = "1" ]; then
    vercel_cmd firewall publish --yes >/dev/null
    STAGED_BY_SCRIPT=0
  fi
  listing="$(list_rules)"
  require_clean_draft "$listing"
}

if [ "$MODE" = "maintenance-remove" ]; then
  matches="$(
    jq -c '[.rules[] | select(.name == "Nexus cutover maintenance gate")]' <<<"$listing"
  )"
  count="$(jq -r 'length' <<<"$matches")"
  [ "$count" -le 1 ] || die "multiple maintenance gate rules exist"
  if [ "$count" = "1" ]; then
    rule_id="$(jq -r '.[0].id' <<<"$matches")"
    vercel_cmd firewall rules remove "$rule_id" --yes >/dev/null
    STAGED_BY_SCRIPT=1
  fi
  publish_and_read_back
  config="$(active_config)"
  [ -z "$(active_named_rule "$config" "Nexus cutover maintenance gate")" ] || \
    die "maintenance gate remained active after removal"
  echo "maintenance gate removed (configuration version $(jq -r '.active.version // \"unknown\"' <<<"$config"))"
  exit 0
fi

if [ "$MODE" = "apply" ]; then
  stage_rule "$rate_desired"
  publish_and_read_back
  config="$(active_config)"
  require_exact_active_rule "$config" "$rate_desired"
  echo "permanent resource-sharing firewall applied (configuration version $(jq -r '.active.version // \"unknown\"' <<<"$config"))"
  exit 0
fi

stage_rule "$maintenance_desired"
maintenance_id="$(
  jq -er '.rules[] | select(.name == "Nexus cutover maintenance gate") | .id' <<<"$listing"
)"
vercel_cmd firewall rules reorder "$maintenance_id" --first --yes >/dev/null
STAGED_BY_SCRIPT=1
publish_and_read_back
config="$(active_config)"
require_exact_active_rule "$config" "$maintenance_desired"
[ "$(active_rules "$config" | jq -r '.[0].name // empty')" = \
  "Nexus cutover maintenance gate" ] || die "maintenance gate is not first"
echo "maintenance gate applied (configuration version $(jq -r '.active.version // \"unknown\"' <<<"$config"))"
