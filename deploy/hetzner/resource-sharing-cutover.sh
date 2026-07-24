#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy/hetzner/resource-sharing-cutover.sh MODE

Modes:
  --check    Validate scripts and desired state without network requests.
  --prepare  Gate production, prove the gate, stop writers, verify a backup,
             then publish/read back the permanent public-share rate limit.
  --release  Re-verify prepared state, push the exact commit, wait for that
             Vercel deployment, deploy Hetzner, smoke, and reopen.
  --rollback Restore the verified pre-cutover backup and exact recorded
             Git/Vercel revisions after a failed closed-gate release.

Required in prepare/release/rollback:
  APP_URL, CUTOVER_SHA, NEXUS_RELEASE_SMOKE_IP
  NEXUS_ORDINARY_PROBE_SSH_TARGET, NEXUS_CUTOVER_STATE_FILE
  API_URL, VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID

Optional:
  VERCEL_CWD
  NEXUS_RUN_WAF_SMOKE
  NEXUS_SSH_TARGET, NEXUS_DEPLOY_PATH, NEXUS_REMOTE_ENV_FILE
  NEXUS_CUTOVER_BACKUP_PATH, NEXUS_CUTOVER_EVIDENCE_FILE
  NEXUS_SMOKE_MEDIA_KIND (web_article, epub, or pdf; default pdf)
  NEXUS_SYNC_ENV, NEXUS_CUTOVER_PUSH_REMOTE (default origin)
  NEXUS_CUTOVER_PUSH_BRANCH (default main)

The ordinary probe SSH host must egress through an IP other than
NEXUS_RELEASE_SMOKE_IP and have curl installed. On failure the maintenance gate
and stopped writers are deliberately left in place. Run --prepare before the
cutover commit is pushed; --release owns the exact validated push.
EOF
}

case "${1:-}" in
  --prepare) MODE="prepare" ;;
  --release) MODE="release" ;;
  --rollback) MODE="rollback" ;;
  --check) MODE="check" ;;
  -h|--help)
    usage
    exit 0
    ;;
  "") usage; die "choose --prepare, --release, --rollback, or --check" ;;
  *) die "unknown argument: $1" ;;
esac

for command_name in bash curl git jq scp ssh tar; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

bash -n \
  "${ROOT_DIR}/deploy/hetzner/deploy.sh" \
  "${ROOT_DIR}/deploy/smoke/resource-sharing-cutover.sh" \
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh"
"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --check >/dev/null
"${ROOT_DIR}/deploy/smoke/resource-sharing-cutover.sh" --check >/dev/null
if [ "$MODE" = "check" ]; then
  echo "resource-sharing cutover orchestration is locally valid; no network requests were made"
  exit 0
fi

for variable in \
  APP_URL CUTOVER_SHA NEXUS_RELEASE_SMOKE_IP \
  NEXUS_ORDINARY_PROBE_SSH_TARGET NEXUS_CUTOVER_STATE_FILE \
  API_URL VERCEL_TOKEN VERCEL_PROJECT_ID VERCEL_TEAM_ID; do
  [ -n "${!variable:-}" ] || die "${variable} is required"
done

HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[ "$CUTOVER_SHA" = "$HEAD_SHA" ] || die "CUTOVER_SHA must equal the checked-out HEAD"
[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "cutover requires a clean checkout"
case "$CUTOVER_SHA" in
  *[!0-9a-f]*|"") die "CUTOVER_SHA must be a lowercase Git commit SHA" ;;
esac
[ "${#CUTOVER_SHA}" = "40" ] || die "CUTOVER_SHA must be a full 40-character Git SHA"

APP_URL="${APP_URL%/}"
NEXUS_SSH_TARGET="${NEXUS_SSH_TARGET:-${NEXUS_DEPLOY_USER:-nexus}@${NEXUS_HOST:-5.78.194.235}}"
NEXUS_DEPLOY_PATH="${NEXUS_DEPLOY_PATH:-/opt/nexus-web}"
NEXUS_REMOTE_ENV_FILE="${NEXUS_REMOTE_ENV_FILE:-${NEXUS_ENV_FILE:-/etc/nexus/nexus.env}}"
NEXUS_SMOKE_MEDIA_KIND="${NEXUS_SMOKE_MEDIA_KIND:-pdf}"
case "$NEXUS_SMOKE_MEDIA_KIND" in
  web_article|epub|pdf) ;;
  *) die "NEXUS_SMOKE_MEDIA_KIND must be web_article, epub, or pdf" ;;
esac
if [ -z "${NEXUS_CUTOVER_BACKUP_PATH:-}" ]; then
  NEXUS_CUTOVER_BACKUP_PATH="/var/backups/nexus/resource-sharing-${CUTOVER_SHA}.dump"
fi
case "$NEXUS_CUTOVER_BACKUP_PATH" in
  /*) ;;
  *) die "NEXUS_CUTOVER_BACKUP_PATH must be an absolute remote path" ;;
esac
case "$NEXUS_CUTOVER_BACKUP_PATH" in
  "$NEXUS_DEPLOY_PATH"|"$NEXUS_DEPLOY_PATH"/*)
    die "NEXUS_CUTOVER_BACKUP_PATH must be outside NEXUS_DEPLOY_PATH"
    ;;
esac

expected_migration_head="$(
  cd "${ROOT_DIR}/migrations"
  ../python/.venv/bin/alembic heads | awk 'NF { print $1 }'
)"
[ -n "$expected_migration_head" ] || die "could not resolve the local migration head"
[ "$(printf '%s\n' "$expected_migration_head" | wc -l | tr -d ' ')" = "1" ] || \
  die "cutover requires exactly one Alembic head"

ordinary_probe() {
  local expected_status="$1"
  local phase="$2"
  local status
  status="$(
    ssh "$NEXUS_ORDINARY_PROBE_SSH_TARGET" sh -s -- \
      "${APP_URL}/s" <<'REMOTE'
set -euo pipefail
command -v curl >/dev/null 2>&1
curl --silent --show-error --output /dev/null --write-out "%{http_code}" "$1"
REMOTE
  )"
  [ "$status" = "$expected_status" ] || \
    die "${phase} ordinary-source probe expected ${expected_status}, got ${status}"
}

ready_deployment_for_sha() {
  local sha="$1"
  local deployment_args=(
    --fail-with-body
    --silent
    --show-error
    --get
    --header "Authorization: Bearer ${VERCEL_TOKEN}"
    --data-urlencode "projectId=${VERCEL_PROJECT_ID}"
    --data-urlencode "teamId=${VERCEL_TEAM_ID}"
    --data-urlencode "target=production"
    --data-urlencode "state=READY"
    --data-urlencode "limit=100"
  )
  curl "${deployment_args[@]}" "https://api.vercel.com/v6/deployments" |
    jq -cer --arg sha "$sha" '
      first(
        .deployments[]
        | select((
            .gitSource.sha
            // .meta.githubCommitSha
            // .meta.gitlabCommitSha
            // ""
          ) == $sha)
        | {
            id: .uid,
            url: .url,
            sha: $sha
          }
      )
    '
}

write_cutover_state() {
  local value="$1"
  local state_dir
  local temporary
  state_dir="$(dirname "$NEXUS_CUTOVER_STATE_FILE")"
  install -d -m 0700 "$state_dir"
  temporary="$(mktemp "${state_dir}/resource-sharing-state.XXXXXX")"
  chmod 0600 "$temporary"
  printf '%s\n' "$value" >"$temporary"
  mv -- "$temporary" "$NEXUS_CUTOVER_STATE_FILE"
}

verify_prepared_remote() {
  local backup_path="$1"
  local backup_sha256="$2"
  local backup_size="$3"
  local migration_head_before="$4"
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" \
    "$backup_path" \
    "$backup_sha256" \
    "$backup_size" \
    "$migration_head_before" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
backup_path="$4"
expected_sha256="$5"
expected_size="$6"
expected_migration_head="$7"
cd "$deploy_path"
compose() {
  CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -f deploy/hetzner/docker-compose.yml "$@"
}
for service in api worker; do
  [ -z "$(compose ps -q "$service")" ] || {
    echo "${service} restarted after cutover preparation" >&2
    exit 1
  }
done
[ -f "$backup_path" ] || {
  echo "prepared backup is missing" >&2
  exit 1
}
[ "$(wc -c <"$backup_path" | tr -d ' ')" = "$expected_size" ] || {
  echo "prepared backup size changed" >&2
  exit 1
}
[ "$(sha256sum "$backup_path" | awk '{print $1}')" = "$expected_sha256" ] || {
  echo "prepared backup digest changed" >&2
  exit 1
}
actual_migration_head="$(
  if [ "$expected_migration_head" = "-" ]; then
    printf '%s' "-"
  else
    compose exec -T postgres sh -c \
      'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version"'
  fi
)"
if [ "$expected_migration_head" != "-" ]; then
  [ "$actual_migration_head" = "$expected_migration_head" ] || {
    echo "database changed after cutover preparation" >&2
    exit 1
  }
fi
REMOTE
}

case "$NEXUS_CUTOVER_STATE_FILE" in
  /*) ;;
  *) die "NEXUS_CUTOVER_STATE_FILE must be an absolute local path" ;;
esac

export APP_URL CUTOVER_SHA
export NEXUS_RELEASE_SMOKE_IP NEXUS_SSH_TARGET NEXUS_DEPLOY_PATH
export NEXUS_REMOTE_ENV_FILE
export VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-}"
export VERCEL_CWD="${VERCEL_CWD:-${ROOT_DIR}/apps/web}"
VERCEL_PROJECT_FILE="${VERCEL_CWD}/.vercel/project.json"
[ -f "$VERCEL_PROJECT_FILE" ] || die "VERCEL_CWD is not linked: ${VERCEL_CWD}"
linked_project_id="$(jq -er '.projectId' "$VERCEL_PROJECT_FILE")"
linked_team_id="$(jq -er '.orgId' "$VERCEL_PROJECT_FILE")"
[ "$linked_project_id" = "$VERCEL_PROJECT_ID" ] || \
  die "VERCEL_PROJECT_ID does not match the project linked by VERCEL_CWD"
[ "$linked_team_id" = "$VERCEL_TEAM_ID" ] || \
  die "VERCEL_TEAM_ID does not match the team linked by VERCEL_CWD"
if [ -n "${NEXUS_RUN_WAF_SMOKE:-}" ]; then
  export NEXUS_RUN_WAF_SMOKE
fi

DEPLOYED_NEW_RUNTIME=0
GATE_MAY_BE_OPEN=0
ACTIVE_REMOTE_FIXTURE=""
ACTIVE_LOCAL_FIXTURE=""
SMOKE_EVIDENCE_FILE=""
POST_OPEN_EVIDENCE_FILE=""
REMOTE_FIXTURE_PATH="/tmp/nexus-resource-sharing-smoke-${CUTOVER_SHA}.json"
CONTAINER_FIXTURE_PATH="/tmp/nexus-resource-sharing-smoke-${CUTOVER_SHA}.json"

stop_deployed_writers() {
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" <<'REMOTE'
set -euo pipefail
cd "$1"
CUTOVER_SHA="$3" NEXUS_ENV_FILE="$2" \
  docker compose --env-file "$2" -f deploy/hetzner/docker-compose.yml \
  stop worker api
for service in worker api; do
  [ -z "$(
    CUTOVER_SHA="$3" NEXUS_ENV_FILE="$2" \
      docker compose --env-file "$2" -f deploy/hetzner/docker-compose.yml \
      ps -q "$service"
  )" ] || {
    echo "${service} remained running after emergency stop" >&2
    exit 1
  }
done
REMOTE
}

revoke_active_fixture() {
  [ -n "$ACTIVE_REMOTE_FIXTURE" ] || return 0
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" \
    "$ACTIVE_REMOTE_FIXTURE" \
    "$CONTAINER_FIXTURE_PATH" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
cd "$deploy_path"
compose() {
  CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -f deploy/hetzner/docker-compose.yml "$@"
}
[ -f "$4" ]
compose cp "$4" "api:$5" >/dev/null
compose exec -T api \
  python -m nexus.ops.resource_sharing_smoke_fixture revoke --input "$5" \
  </dev/null
  rm -f -- "$4"
REMOTE
  ACTIVE_REMOTE_FIXTURE=""
}

create_active_fixture() {
  local local_path="$1"
  ACTIVE_REMOTE_FIXTURE="$REMOTE_FIXTURE_PATH"
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" \
    "$NEXUS_SMOKE_MEDIA_KIND" \
    "$ACTIVE_REMOTE_FIXTURE" \
    "$CONTAINER_FIXTURE_PATH" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
kind="$4"
host_path="$5"
container_path="$6"
cd "$deploy_path"
compose() {
  CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -f deploy/hetzner/docker-compose.yml "$@"
}
[ ! -e "$host_path" ] || {
  echo "refusing to overwrite existing smoke fixture" >&2
  exit 1
}
partial_path="${host_path}.partial"
created=0
cleanup() {
  status=$?
  rm -f -- "$partial_path"
  if [ "$created" = "1" ]; then
    compose exec -T api \
      python -m nexus.ops.resource_sharing_smoke_fixture \
      revoke --input "$container_path" </dev/null >/dev/null 2>&1 || true
  fi
  compose exec -T api rm -f -- "$container_path" </dev/null >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
compose exec -T api \
  python -m nexus.ops.resource_sharing_smoke_fixture \
  create --kind "$kind" --output "$container_path" </dev/null
created=1
umask 077
compose cp "api:$container_path" "$partial_path" >/dev/null
sudo chown "$(id -un):$(id -gn)" "$partial_path"
chmod 0600 "$partial_path"
mv -- "$partial_path" "$host_path"
compose exec -T api rm -f -- "$container_path" </dev/null
created=0
trap - EXIT
REMOTE
  ACTIVE_LOCAL_FIXTURE="$local_path"
  scp -q "${NEXUS_SSH_TARGET}:${ACTIVE_REMOTE_FIXTURE}" "$ACTIVE_LOCAL_FIXTURE"
  chmod 0600 "$ACTIVE_LOCAL_FIXTURE"
}

run_fixture_smoke() {
  local evidence_file="$1"
  local run_waf="$2"
  local merged_evidence_file
  local revoked_evidence_file
  local fixture_file
  fixture_file="$(mktemp)"
  chmod 0600 "$fixture_file"
  create_active_fixture "$fixture_file"
  NEXUS_SMOKE_FIXTURE_FILE="$fixture_file" \
  NEXUS_RUN_WAF_SMOKE="$run_waf" \
  NEXUS_CUTOVER_EVIDENCE_FILE="$evidence_file" \
    "${ROOT_DIR}/deploy/smoke/resource-sharing-cutover.sh"
  if [ "$run_waf" = "1" ]; then
    echo "waiting for a fresh WAF window before the closed-gate revoked-token probe" >&2
    sleep 61
  fi
  revoke_active_fixture
  revoked_evidence_file="$(mktemp)"
  NEXUS_SMOKE_FIXTURE_FILE="$fixture_file" \
  NEXUS_CUTOVER_EVIDENCE_FILE="$revoked_evidence_file" \
    "${ROOT_DIR}/deploy/smoke/resource-sharing-cutover.sh" --revoked
  merged_evidence_file="$(mktemp)"
  jq -s '.[0] + .[1]' "$evidence_file" "$revoked_evidence_file" \
    >"$merged_evidence_file"
  mv -- "$merged_evidence_file" "$evidence_file"
  rm -f -- "$revoked_evidence_file" "$fixture_file"
  ACTIVE_LOCAL_FIXTURE=""
}

release_failure_cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$MODE" = "release" ]; then
    failure_guidance="release failed closed; inspect the operator state before reopening"
    if [ "$GATE_MAY_BE_OPEN" = "1" ]; then
      echo "release failed after the gate may have opened; restoring maintenance" >&2
      "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" \
        --maintenance-apply >/dev/null 2>&1 || \
        echo "error: failed to restore the maintenance gate" >&2
      "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" \
        --maintenance-check >/dev/null 2>&1 || \
        echo "error: restored maintenance gate could not be verified" >&2
    fi
    if [ -n "$ACTIVE_REMOTE_FIXTURE" ]; then
      revoke_active_fixture >/dev/null 2>&1 || \
        echo "error: failed to revoke the active smoke fixture" >&2
    fi
    if [ "$DEPLOYED_NEW_RUNTIME" = "1" ]; then
      echo "release failed after deploy; stopping the new api and worker" >&2
      stop_deployed_writers >/dev/null 2>&1 || \
        echo "error: failed to stop the deployed api and worker" >&2
    fi
    if [ -f "$NEXUS_CUTOVER_STATE_FILE" ]; then
      if jq -e '.rollback.git_sha and .rollback.vercel_deployment_id' \
        "$NEXUS_CUTOVER_STATE_FILE" >/dev/null 2>&1; then
        if [ "$GATE_MAY_BE_OPEN" = "1" ]; then
          failed_phase="forward_fix_required"
          failure_guidance="traffic may have reopened; rollback is forbidden and the gated recovery must be a forward fix"
        else
          failed_phase="failed_closed"
          failure_guidance="release remains gated; inspect state and run --rollback before reopening"
        fi
        failed_state="$(
          jq \
            --arg phase "$failed_phase" \
            --arg failed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '.phase = $phase | .failed_at = $failed_at' \
            "$NEXUS_CUTOVER_STATE_FILE"
        )"
      else
        failed_state="$(
          jq \
            --arg failed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '.release_attempt_failed_at = $failed_at' \
            "$NEXUS_CUTOVER_STATE_FILE"
        )"
        failure_guidance="release failed before mutation; prepared gate and stopped writers remain intact"
      fi
      write_cutover_state "$failed_state" || \
        echo "error: failed to record closed-gate release failure" >&2
    fi
    echo "$failure_guidance" >&2
  fi
  if [ -n "$ACTIVE_LOCAL_FIXTURE" ]; then
    rm -f -- "$ACTIVE_LOCAL_FIXTURE"
  fi
  if [ -n "$SMOKE_EVIDENCE_FILE" ]; then
    rm -f -- "$SMOKE_EVIDENCE_FILE"
  fi
  if [ -n "$POST_OPEN_EVIDENCE_FILE" ]; then
    rm -f -- "$POST_OPEN_EVIDENCE_FILE"
  fi
  exit "$status"
}
trap release_failure_cleanup EXIT

if [ "$MODE" = "prepare" ]; then
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-apply
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-check
  gate_closed_at="$(date +%s)"
  ordinary_probe "403" "closed-gate"

  backup_evidence="$(
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" \
    "$NEXUS_CUTOVER_BACKUP_PATH" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
backup_path="$4"
cd "$deploy_path"

compose() {
  CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" \
    -f deploy/hetzner/docker-compose.yml "$@"
}

compose stop worker api
[ -z "$(compose ps -q worker)" ] || {
  echo "worker remained running after stop" >&2
  exit 1
}
[ -z "$(compose ps -q api)" ] || {
  echo "api remained running after stop" >&2
  exit 1
}
compose up -d postgres
for attempt in $(seq 1 30); do
  if compose exec -T postgres sh -c \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' </dev/null >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" != "30" ] || {
    echo "postgres did not become ready for backup" >&2
    exit 1
  }
  sleep 2
done

backup_dir="$(dirname "$backup_path")"
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$backup_dir"
[ ! -e "$backup_path" ] || {
  echo "refusing to overwrite existing backup: $backup_path" >&2
  exit 1
}
partial_path="${backup_path}.partial"
trap 'rm -f -- "$partial_path"' EXIT
umask 077
compose exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  </dev/null >"$partial_path"
[ -s "$partial_path" ] || {
  echo "pg_dump produced an empty backup" >&2
  exit 1
}
compose exec -T postgres \
  pg_restore --file=/dev/null --no-owner --no-acl \
  </dev/null <"$partial_path" >/dev/null
mv -- "$partial_path" "$backup_path"
trap - EXIT
migration_head_before="$(
  compose exec -T postgres sh -c \
    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version"'
)"
printf '{"path":"%s","sha256":"%s","size_bytes":%s,"migration_head_before":"%s"}\n' \
  "$backup_path" \
  "$(sha256sum "$backup_path" | awk '{print $1}')" \
  "$(wc -c <"$backup_path" | tr -d ' ')" \
  "$migration_head_before"
REMOTE
)"
jq -e '
  (.path | type == "string" and startswith("/"))
  and (.sha256 | test("^[0-9a-f]{64}$"))
  and (.size_bytes | type == "number" and . > 0)
  and .migration_head_before == "0188"
' <<<"$backup_evidence" >/dev/null || die "remote backup evidence is invalid"

  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --apply
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --remote-check
  umask 077
  prepared_state="$(
    jq -cn \
    --arg phase "prepared" \
    --arg cutover_sha "$CUTOVER_SHA" \
    --argjson gate_closed_at "$gate_closed_at" \
    --arg expected_migration_head "$expected_migration_head" \
    --argjson database_backup "$backup_evidence" \
    '{
      phase:$phase,
      cutover_sha:$cutover_sha,
      gate_closed_at:$gate_closed_at,
      expected_migration_head:$expected_migration_head,
      database_backup:$database_backup
    }'
  )"
  write_cutover_state "$prepared_state"
  echo "prepared cutover ${CUTOVER_SHA}; gate remains closed and writers remain stopped"
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  [ -f "$NEXUS_CUTOVER_STATE_FILE" ] || die "cutover state file is missing"
  jq -e \
    --arg cutover_sha "$CUTOVER_SHA" '
      (
        .phase == "release_ready"
        or .phase == "failed_closed"
        or .phase == "rollback_failed_closed"
      )
      and .cutover_sha == $cutover_sha
      and (.database_backup.path | type == "string" and startswith("/"))
      and (.database_backup.sha256 | test("^[0-9a-f]{64}$"))
      and (.database_backup.size_bytes | type == "number" and . > 0)
      and .database_backup.migration_head_before == "0188"
      and (.rollback.git_sha | test("^[0-9a-f]{40}$"))
      and (.rollback.vercel_deployment_id | type == "string" and length > 0)
      and .rollback.vercel_revision == .rollback.git_sha
    ' "$NEXUS_CUTOVER_STATE_FILE" >/dev/null || \
    die "cutover state has no verified rollback identity"

  rollback_sha="$(jq -er '.rollback.git_sha' "$NEXUS_CUTOVER_STATE_FILE")"
  rollback_deployment_id="$(
    jq -er '.rollback.vercel_deployment_id' "$NEXUS_CUTOVER_STATE_FILE"
  )"
  backup_path="$(jq -er '.database_backup.path' "$NEXUS_CUTOVER_STATE_FILE")"
  backup_sha256="$(jq -er '.database_backup.sha256' "$NEXUS_CUTOVER_STATE_FILE")"
  backup_size="$(jq -er '.database_backup.size_bytes' "$NEXUS_CUTOVER_STATE_FILE")"
  ROLLBACK_PARENT=""
  ROLLBACK_GATE_MAY_BE_OPEN=0
  # shellcheck disable=SC2329
  rollback_failure_cleanup() {
    local status=$?
    trap - EXIT
    if [ "$status" -ne 0 ]; then
      if [ "$ROLLBACK_GATE_MAY_BE_OPEN" = "1" ]; then
        "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" \
          --maintenance-apply >/dev/null 2>&1 || \
          echo "error: failed to restore maintenance during rollback failure" >&2
        "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" \
          --maintenance-check >/dev/null 2>&1 || \
          echo "error: rollback maintenance restore could not be verified" >&2
      fi
      stop_deployed_writers >/dev/null 2>&1 || \
        echo "error: failed to stop writers after rollback failure" >&2
      rollback_failed_state="$(
        jq \
          --arg phase "rollback_failed_closed" \
          --arg failed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '.phase = $phase | .rollback_failed_at = $failed_at' \
          "$NEXUS_CUTOVER_STATE_FILE"
      )"
      write_cutover_state "$rollback_failed_state" || \
        echo "error: failed to record rollback failure" >&2
      echo "rollback failed closed; fix the cause and rerun --rollback" >&2
    fi
    if [ -n "$ROLLBACK_PARENT" ]; then
      rm -rf -- "$ROLLBACK_PARENT"
    fi
    exit "$status"
  }
  trap rollback_failure_cleanup EXIT

  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-check
  ordinary_probe "403" "rollback-preflight"
  stop_deployed_writers
  verify_prepared_remote \
    "$backup_path" "$backup_sha256" "$backup_size" "-"

  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" \
    "$backup_path" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
backup_path="$4"
cd "$deploy_path"
compose() {
  CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -f deploy/hetzner/docker-compose.yml "$@"
}
compose up -d postgres
for attempt in $(seq 1 30); do
  if compose exec -T postgres sh -c \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' </dev/null >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" != "30" ] || {
    echo "postgres did not become ready for rollback" >&2
    exit 1
  }
  sleep 2
done
compose exec -T postgres sh -c '
  set -e
  case "$POSTGRES_DB" in
    ""|postgres|template0|template1)
      echo "refusing unsafe rollback database target" >&2
      exit 1
      ;;
  esac
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -v database_name="$POSTGRES_DB" \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database_name' AND pid <> pg_backend_pid()"
  dropdb --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
' </dev/null
compose exec -T postgres sh -c \
  'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  </dev/null <"$backup_path"
restored_head="$(
  compose exec -T postgres sh -c \
    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version"'
)"
[ "$restored_head" = "0188" ] || {
  echo "restored database did not return to 0188" >&2
  exit 1
}
REMOTE

  ROLLBACK_PARENT="$(mktemp -d)"
  rollback_tree="${ROLLBACK_PARENT}/source"
  mkdir "$rollback_tree"
  git -C "$ROOT_DIR" archive "$rollback_sha" | tar -x -C "$rollback_tree"
  NEXUS_SYNC_ENV=0 \
  NEXUS_SSH_TARGET="$NEXUS_SSH_TARGET" \
  NEXUS_DEPLOY_PATH="$NEXUS_DEPLOY_PATH" \
  NEXUS_REMOTE_ENV_FILE="$NEXUS_REMOTE_ENV_FILE" \
    "${rollback_tree}/deploy/hetzner/deploy.sh"
  rm -rf -- "$ROLLBACK_PARENT"
  ROLLBACK_PARENT=""

  vercel rollback "$rollback_deployment_id" \
    --cwd "$VERCEL_CWD" \
    --token "$VERCEL_TOKEN" \
    --timeout 15m \
    --yes \
    --non-interactive

  rollback_web_status="$(
    curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
      "${APP_URL}/s"
  )"
  [ "$rollback_web_status" = "307" ] || \
    die "rollback web revision did not restore the pre-cutover /s contract"
  curl --fail --silent --show-error "${API_URL}/health" >/dev/null
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$rollback_sha" <<'REMOTE'
set -euo pipefail
cd "$1"
compose() {
  NEXUS_ENV_FILE="$2" \
    docker compose --env-file "$2" -f deploy/hetzner/docker-compose.yml "$@"
}
for service in api worker; do
  [ -n "$(compose ps -q "$service")" ] || {
    echo "rolled-back ${service} is not running" >&2
    exit 1
  }
done
printf '%s\n' "$3" >.nexus-deployed-sha
REMOTE

  ROLLBACK_GATE_MAY_BE_OPEN=1
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-remove
  "${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-absent
  ordinary_probe "307" "rollback-reopened"
  rolled_back_state="$(
    jq \
      --arg phase "rolled_back" \
      --arg rolled_back_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.phase = $phase | .rolled_back_at = $rolled_back_at' \
      "$NEXUS_CUTOVER_STATE_FILE"
  )"
  write_cutover_state "$rolled_back_state"
  ROLLBACK_GATE_MAY_BE_OPEN=0
  trap - EXIT
  echo "rolled back to ${rollback_sha}; production reopened on the recorded revision"
  exit 0
fi

[ -f "$NEXUS_CUTOVER_STATE_FILE" ] || die "prepared cutover state file is missing"
jq -e \
  --arg cutover_sha "$CUTOVER_SHA" \
  --arg expected_migration_head "$expected_migration_head" '
    .phase == "prepared"
    and .cutover_sha == $cutover_sha
    and .expected_migration_head == $expected_migration_head
    and (.gate_closed_at | type == "number" and . > 0)
    and (.database_backup.path | type == "string" and startswith("/"))
    and (.database_backup.sha256 | test("^[0-9a-f]{64}$"))
    and (.database_backup.size_bytes | type == "number" and . > 0)
    and .database_backup.migration_head_before == "0188"
  ' "$NEXUS_CUTOVER_STATE_FILE" >/dev/null || die "prepared cutover state is invalid"
gate_closed_at="$(jq -er '.gate_closed_at' "$NEXUS_CUTOVER_STATE_FILE")"
backup_evidence="$(jq -c '.database_backup' "$NEXUS_CUTOVER_STATE_FILE")"
backup_path="$(jq -er '.database_backup.path' "$NEXUS_CUTOVER_STATE_FILE")"
backup_sha256="$(jq -er '.database_backup.sha256' "$NEXUS_CUTOVER_STATE_FILE")"
backup_size="$(jq -er '.database_backup.size_bytes' "$NEXUS_CUTOVER_STATE_FILE")"
backup_migration_head="$(
  jq -er '.database_backup.migration_head_before' "$NEXUS_CUTOVER_STATE_FILE"
)"

"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-check
"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --remote-check
ordinary_probe "403" "release-preflight"
verify_prepared_remote \
  "$backup_path" \
  "$backup_sha256" \
  "$backup_size" \
  "$backup_migration_head"

push_remote="${NEXUS_CUTOVER_PUSH_REMOTE:-origin}"
push_branch="${NEXUS_CUTOVER_PUSH_BRANCH:-main}"
remote_sha="$(
  git -C "$ROOT_DIR" ls-remote --heads "$push_remote" "refs/heads/${push_branch}" |
    awk 'NR == 1 { print $1 }'
)"
[ -n "$remote_sha" ] || die "could not resolve ${push_remote}/${push_branch}"
git -C "$ROOT_DIR" fetch --no-tags "$push_remote" "$remote_sha"
git -C "$ROOT_DIR" merge-base --is-ancestor "$remote_sha" "$CUTOVER_SHA" || \
  die "CUTOVER_SHA is not a fast-forward of ${push_remote}/${push_branch}"
rollback_deployment="$(ready_deployment_for_sha "$remote_sha")"
rollback_deployment_id="$(jq -er '.id' <<<"$rollback_deployment")"
rollback_deployment_url="$(jq -er '.url' <<<"$rollback_deployment")"
release_ready_state="$(
  jq \
    --arg phase "release_ready" \
    --arg git_sha "$remote_sha" \
    --arg vercel_deployment_id "$rollback_deployment_id" \
    --arg vercel_deployment_url "$rollback_deployment_url" \
    --arg vercel_revision "$remote_sha" \
    '.phase = $phase
      | .rollback = {
          git_sha: $git_sha,
          vercel_deployment_id: $vercel_deployment_id,
          vercel_deployment_url: $vercel_deployment_url,
          vercel_revision: $vercel_revision
        }' \
    "$NEXUS_CUTOVER_STATE_FILE"
)"
write_cutover_state "$release_ready_state"
if [ "$remote_sha" != "$CUTOVER_SHA" ]; then
  git -C "$ROOT_DIR" push --porcelain \
    "$push_remote" "${CUTOVER_SHA}:refs/heads/${push_branch}"
fi

deployment_deadline="$((SECONDS + ${NEXUS_VERCEL_WAIT_SECONDS:-900}))"
vercel_deployment_id=""
while [ "$SECONDS" -lt "$deployment_deadline" ]; do
  deployment_args=(
    --fail-with-body
    --silent
    --show-error
    --get
    --header "Authorization: Bearer ${VERCEL_TOKEN}"
    --data-urlencode "projectId=${VERCEL_PROJECT_ID}"
    --data-urlencode "target=production"
    --data-urlencode "limit=20"
  )
  if [ -n "${VERCEL_TEAM_ID:-}" ]; then
    deployment_args+=(--data-urlencode "teamId=${VERCEL_TEAM_ID}")
  fi
  deployments="$(curl "${deployment_args[@]}" "https://api.vercel.com/v6/deployments")"
  vercel_deployment_id="$(
    jq -r --arg sha "$CUTOVER_SHA" '
      .deployments[]
      | select((
          .gitSource.sha
          // .meta.githubCommitSha
          // .meta.gitlabCommitSha
          // ""
        ) == $sha and .state == "READY")
      | .uid
    ' <<<"$deployments" | head -n 1
  )"
  [ -z "$vercel_deployment_id" ] || break
  sleep 10
done
[ -n "$vercel_deployment_id" ] || \
  die "Vercel did not report CUTOVER_SHA ready before the wait deadline"

DEPLOYED_NEW_RUNTIME=1
CUTOVER_SHA="$CUTOVER_SHA" \
NEXUS_SSH_TARGET="$NEXUS_SSH_TARGET" \
NEXUS_DEPLOY_PATH="$NEXUS_DEPLOY_PATH" \
NEXUS_REMOTE_ENV_FILE="$NEXUS_REMOTE_ENV_FILE" \
NEXUS_SYNC_ENV="${NEXUS_SYNC_ENV:-1}" \
  "${ROOT_DIR}/deploy/hetzner/deploy.sh"

migration_head="$(
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "$NEXUS_DEPLOY_PATH" \
    "$NEXUS_REMOTE_ENV_FILE" \
    "$CUTOVER_SHA" <<'REMOTE'
set -euo pipefail
cd "$1"
CUTOVER_SHA="$3" NEXUS_ENV_FILE="$2" \
  docker compose --env-file "$2" -f deploy/hetzner/docker-compose.yml \
  exec -T api sh -c 'cd /app/migrations && /app/.venv/bin/alembic current' |
  awk 'NF { print $1 }'
REMOTE
)"
[ "$migration_head" = "$expected_migration_head" ] || \
  die "deployed migration head ${migration_head:-unknown} differs from ${expected_migration_head}"

export API_URL VERCEL_TOKEN VERCEL_PROJECT_ID
SMOKE_EVIDENCE_FILE="$(mktemp)"
POST_OPEN_EVIDENCE_FILE="$(mktemp)"
run_fixture_smoke "$SMOKE_EVIDENCE_FILE" "${NEXUS_RUN_WAF_SMOKE:-0}"

"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-check
"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --remote-check

GATE_MAY_BE_OPEN=1
"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-remove
"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --maintenance-absent
ordinary_probe "200" "reopened"
gate_opened_at="$(date +%s)"
run_fixture_smoke "$POST_OPEN_EVIDENCE_FILE" "0"

evidence="$(
  jq \
    --argjson backup "$backup_evidence" \
    --argjson rollback "$(jq -c '.rollback' "$NEXUS_CUTOVER_STATE_FILE")" \
    --argjson post_open_smoke "$(cat "$POST_OPEN_EVIDENCE_FILE")" \
    --arg migration_head "$migration_head" \
    --argjson opening_seconds "$((gate_opened_at - gate_closed_at))" \
    '. + {
      phase: "released",
      database_backup: $backup,
      rollback: $rollback,
      migration_head: $migration_head,
      ordinary_gate_probe: "passed",
      maintenance_gate: "removed",
      post_open_smoke: $post_open_smoke,
      opening_seconds: $opening_seconds
    }' "$SMOKE_EVIDENCE_FILE"
)"
printf '%s\n' "$evidence" >"$NEXUS_CUTOVER_STATE_FILE"
if [ -n "${NEXUS_CUTOVER_EVIDENCE_FILE:-}" ]; then
  printf '%s\n' "$evidence" >"$NEXUS_CUTOVER_EVIDENCE_FILE"
fi
printf '%s\n' "$evidence"
rm -f -- "$SMOKE_EVIDENCE_FILE" "$POST_OPEN_EVIDENCE_FILE"
SMOKE_EVIDENCE_FILE=""
POST_OPEN_EVIDENCE_FILE=""
