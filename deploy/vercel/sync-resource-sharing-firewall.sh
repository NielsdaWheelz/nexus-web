#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR
readonly VERCEL_CWD="${ROOT_DIR}/apps/web"
readonly VERCEL_CLI="${VERCEL_CWD}/node_modules/.bin/vercel"
readonly DESIRED_FILE="${ROOT_DIR}/deploy/vercel/firewall/resource-sharing.json"
readonly PROJECT_FILE="${VERCEL_CWD}/.vercel/project.json"
readonly VERCEL_PROJECT_NAME="nexus-web"
readonly VERCEL_PROJECT_ID="prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"
readonly VERCEL_TEAM_ID="team_fKVvTyTsMBQ7qFjccFO17BJL"
readonly VERCEL_SCOPE="niels-erik-nandals-projects"
MODE="${1:---apply}"
STAGED_BY_SCRIPT=0

die() {
  echo "error: $*" >&2
  exit 1
}

case "$MODE" in
  --check|--apply|--remote-check) ;;
  -h|--help)
    echo "usage: deploy/vercel/sync-resource-sharing-firewall.sh [--check|--apply|--remote-check]"
    exit 0
    ;;
  *) die "unknown argument: ${MODE}" ;;
esac
[ "$#" -le 1 ] || die "expected at most one mode"

command -v jq >/dev/null 2>&1 || die "jq is required"
command -v timeout >/dev/null 2>&1 || die "timeout is required"
[ -x "$VERCEL_CLI" ] || die "run the locked apps/web dependency install first"
[ -f "$DESIRED_FILE" ] || die "desired state is missing"
if [ "$MODE" != "--check" ]; then
  [ -n "${VERCEL_TOKEN:-}" ] || die "VERCEL_TOKEN is required"
  [[ "$VERCEL_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]] || die "VERCEL_TOKEN is malformed"
fi

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
' "$DESIRED_FILE" >/dev/null || die "desired state violates the sharing WAF contract"

if [ "$MODE" = "--check" ]; then
  echo "resource-sharing firewall desired state is valid; no network request was made"
  exit 0
fi

[ -f "$PROJECT_FILE" ] || die "Vercel project is not linked"
jq -e \
  --arg id "$VERCEL_PROJECT_ID" \
  --arg org "$VERCEL_TEAM_ID" \
  --arg name "$VERCEL_PROJECT_NAME" '
  .projectId == $id and .orgId == $org and .projectName == $name
' "$PROJECT_FILE" >/dev/null || \
  die "linked Vercel project disagrees with committed production identity"
project_id="$VERCEL_PROJECT_ID"
team_id="$VERCEL_TEAM_ID"

vercel_cmd() {
  timeout --foreground 2m "$VERCEL_CLI" "$@" \
    --cwd "$VERCEL_CWD" --scope "$VERCEL_SCOPE" --non-interactive
}

discard_owned_draft_on_failure() {
  local status=$?
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
  jq -e '.hasDraft == false and .pendingChanges == 0 and (.rules | type == "array")' \
    <<<"$listing" >/dev/null || \
    die "Vercel has unpublished or malformed firewall state"
}

normalize_rule() {
  jq -cS '{name,description,active,conditionGroup,action}'
}

active_config() {
  vercel_cmd api \
    "/v1/security/firewall/config?projectId=${project_id}&teamId=${team_id}" \
    --raw
}

require_exact_active_rule() {
  local config="$1"
  local desired="$2"
  local matches remote
  matches="$(
    jq -c --arg name "$(jq -r .name <<<"$desired")" \
      '[.active.rules[]? | select(.name == $name)]' <<<"$config"
  )"
  [ "$(jq -r length <<<"$matches")" = "1" ] || \
    die "active permanent firewall rule is absent or duplicated"
  remote="$(jq -c '.[0]' <<<"$matches")"
  [ "$(normalize_rule <<<"$remote")" = "$(normalize_rule <<<"$desired")" ] || \
    die "active permanent firewall rule differs from desired state"
}

desired="$(jq -c . "$DESIRED_FILE")"
if [ "$MODE" = "--remote-check" ]; then
  config="$(active_config)"
  require_exact_active_rule "$config" "$desired"
  echo "permanent resource-sharing firewall is active"
  exit 0
fi

listing="$(list_rules)"
require_clean_draft "$listing"
matches="$(
  jq -c --arg name "$(jq -r .name <<<"$desired")" \
    '[.rules[] | select(.name == $name)]' <<<"$listing"
)"
count="$(jq -r length <<<"$matches")"
[ "$count" -le 1 ] || die "permanent firewall rule is duplicated"
if [ "$count" = "0" ]; then
  vercel_cmd firewall rules add --json "$desired" --yes >/dev/null
  STAGED_BY_SCRIPT=1
else
  rule="$(jq -c '.[0]' <<<"$matches")"
  rule_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$rule")"
  if [ "$(normalize_rule <<<"$rule")" != "$(normalize_rule <<<"$desired")" ]; then
    vercel_cmd firewall rules edit "$rule_id" --json "$desired" --yes >/dev/null
    STAGED_BY_SCRIPT=1
  fi
fi

if [ "$STAGED_BY_SCRIPT" = "1" ]; then
  vercel_cmd firewall publish --yes >/dev/null
  STAGED_BY_SCRIPT=0
fi
listing="$(list_rules)"
require_clean_draft "$listing"
config="$(active_config)"
require_exact_active_rule "$config" "$desired"
echo "permanent resource-sharing firewall applied and verified"
