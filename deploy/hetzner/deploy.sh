#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DEFAULT_NEXUS_HOST="5.78.194.235"
HOST="${NEXUS_HOST:-$DEFAULT_NEXUS_HOST}"
DEPLOY_USER="${NEXUS_DEPLOY_USER:-nexus}"
DEPLOY_PATH="${NEXUS_DEPLOY_PATH:-/opt/nexus-web}"
ENV_FILE="${NEXUS_REMOTE_ENV_FILE:-${NEXUS_ENV_FILE:-/etc/nexus/nexus.env}}"
SSH_TARGET="${NEXUS_SSH_TARGET:-${DEPLOY_USER}@${HOST}}"
SYNC_ENV="${NEXUS_SYNC_ENV:-1}"

die() {
  echo "error: $*" >&2
  exit 1
}

command -v rsync >/dev/null 2>&1 || die "rsync is not installed locally"
command -v ssh >/dev/null 2>&1 || die "ssh is not installed locally"
command -v git >/dev/null 2>&1 || die "git is not installed locally"

HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
CUTOVER_SHA="${CUTOVER_SHA:-$HEAD_SHA}"
case "$CUTOVER_SHA" in
  *[!0-9a-f]*|"") die "CUTOVER_SHA must be a lowercase Git commit SHA" ;;
esac
[ "${#CUTOVER_SHA}" = "40" ] || die "CUTOVER_SHA must be a full 40-character Git SHA"
[ "$CUTOVER_SHA" = "$HEAD_SHA" ] || die "CUTOVER_SHA must equal the checked-out HEAD"
[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "production deploy requires a clean checkout"

case "$SYNC_ENV" in
  0|1) ;;
  *) die "NEXUS_SYNC_ENV must be 0 or 1" ;;
esac

if [ "$SYNC_ENV" = "1" ]; then
  NEXUS_REMOTE_ENV_FILE="$ENV_FILE" "${ROOT_DIR}/deploy/hetzner/sync-env.sh"
fi

# shellcheck disable=SC2029
ssh "$SSH_TARGET" "sudo install -d -o ${DEPLOY_USER} -g ${DEPLOY_USER} '${DEPLOY_PATH}' && test -f '${ENV_FILE}'"

rsync -az --delete \
  --exclude ".git" \
  --exclude ".agency/" \
  --exclude ".claude/" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "deploy/env/env-prod" \
  --exclude "deploy/env/env-prod-backend" \
  --exclude "deploy/env/env-prod-frontend" \
  --exclude "deploy/env/env-prod-worker" \
  --exclude ".dev-ports" \
  --exclude ".DS_Store" \
  --exclude "node_modules/" \
  --exclude "apps/web/.next/" \
  --exclude "apps/web/node_modules/" \
  --exclude "e2e/node_modules/" \
  --exclude "python/.venv/" \
  --exclude "**/__pycache__/" \
  --exclude "**/.ruff_cache/" \
  --exclude "e2e/test-results/" \
  --exclude "e2e/playwright-report/" \
  "${ROOT_DIR}/" "${SSH_TARGET}:${DEPLOY_PATH}/"

# shellcheck disable=SC2029
ssh "$SSH_TARGET" \
  "DEPLOY_PATH='${DEPLOY_PATH}' ENV_FILE='${ENV_FILE}' CUTOVER_SHA='${CUTOVER_SHA}' bash -s" <<'REMOTE'
set -euo pipefail

cd "$DEPLOY_PATH"

compose() {
  NEXUS_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -f deploy/hetzner/docker-compose.yml "$@"
}

retain_release_image() {
  local service="$1"
  local repository="$2"
  local container_id revision image_id retained_tag prior_tag

  container_id="$(compose ps --all -q "$service")"
  [ -n "$container_id" ] || return 0
  revision="$(
    docker inspect "$container_id" --format '{{range .Config.Env}}{{println .}}{{end}}' |
      sed -n 's/^CUTOVER_SHA=//p'
  )"
  case "$revision" in
    *[!0-9a-f]*|"")
      echo "error: ${service} container has no valid CUTOVER_SHA" >&2
      return 1
      ;;
  esac
  if [ "${#revision}" != "40" ]; then
    echo "error: ${service} container CUTOVER_SHA must be a full Git revision" >&2
    return 1
  fi
  image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
  retained_tag="${repository}:release-${revision}"
  docker image tag "$image_id" "$retained_tag"
  while IFS= read -r prior_tag; do
    [ "$prior_tag" = "$retained_tag" ] || docker image rm "$prior_tag" >/dev/null
  done < <(
    docker image ls \
      --filter "reference=${repository}:release-*" \
      --format '{{.Repository}}:{{.Tag}}'
  )
  echo "retained_release_image=${retained_tag}"
}

retain_release_image api nexus-api
retain_release_image worker-interactive nexus-worker-interactive
retain_release_image worker-background nexus-worker-background
compose build --pull
compose up -d postgres
for i in $(seq 1 30); do
  if compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' </dev/null >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "30" ]; then
    echo "error: postgres did not become healthy before migrations" >&2
    exit 1
  fi
  sleep 2
done
MIGRATION_TABLE="$(
  compose exec -T postgres sh -c \
    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('\''public.alembic_version'\'')"' \
    </dev/null
)"
if [ -z "$MIGRATION_TABLE" ]; then
  MIGRATION_CURRENT="base"
else
  MIGRATION_CURRENT="$(
    compose exec -T postgres sh -c \
      'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version"' \
      </dev/null
  )"
  [ -n "$MIGRATION_CURRENT" ] || {
    echo "error: alembic_version exists without a current revision" >&2
    exit 1
  }
fi
compose run -T --rm api /app/.venv/bin/python -m nexus.ops.deployment_migrations \
  --current "$MIGRATION_CURRENT" \
  --script-location /app/migrations/alembic \
  </dev/null
compose stop worker-interactive worker-background api
compose run -T --rm api sh -c 'cd /app/migrations && /app/.venv/bin/alembic upgrade head' </dev/null
compose run -T --rm --no-deps worker-background /app/.venv/bin/python /app/scripts/ensure_oracle_seed_objects.py </dev/null
ORACLE_CORPUS_OWNER_USER_ID="$(
  compose run -T --rm --no-deps worker-background /app/.venv/bin/python -c 'import os; print(os.environ.get("NEXUS_ORACLE_CORPUS_OWNER_USER_ID", "").strip())' </dev/null
)"
if [ -z "$ORACLE_CORPUS_OWNER_USER_ID" ]; then
  echo "error: set NEXUS_ORACLE_CORPUS_OWNER_USER_ID in ${ENV_FILE} for Oracle Corpus seeding" >&2
  exit 1
fi
compose run -T --rm --no-deps worker-background /app/.venv/bin/python /app/scripts/oracle/seed_corpus_library.py --owner-user "$ORACLE_CORPUS_OWNER_USER_ID" --drain </dev/null
compose run -T --rm --no-deps worker-background /app/.venv/bin/python /app/scripts/oracle/check_corpus_readiness.py </dev/null
compose up -d --remove-orphans --force-recreate --wait --wait-timeout 180
compose ps

API_HEALTH="$(compose exec -T api /app/.venv/bin/python -c \
  'import json, urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5))["data"]["cutover_sha"])')"
INTERACTIVE_WORKER_CONTRACT="$(compose exec -T worker-interactive /app/.venv/bin/python -c \
  'import os; from apps.worker.main import create_worker; from nexus.config import INTERACTIVE_WORKER_JOB_KINDS, get_settings; worker = create_worker(); assert worker.allowed_kinds == tuple(sorted(INTERACTIVE_WORKER_JOB_KINDS)); print("|".join((os.environ.get("CUTOVER_SHA", ""), str(get_settings().worker_lane), ",".join(worker.allowed_kinds))))')"
BACKGROUND_WORKER_CONTRACT="$(compose exec -T worker-background /app/.venv/bin/python -c \
  'import os; from apps.worker.main import create_worker; from nexus.config import BACKGROUND_WORKER_JOB_KINDS, get_settings; worker = create_worker(); assert worker.allowed_kinds == tuple(sorted(BACKGROUND_WORKER_JOB_KINDS)); print("|".join((os.environ.get("CUTOVER_SHA", ""), str(get_settings().worker_lane), ",".join(worker.allowed_kinds))))')"
IFS='|' read -r INTERACTIVE_WORKER_REVISION INTERACTIVE_WORKER_LANE INTERACTIVE_WORKER_KINDS <<<"$INTERACTIVE_WORKER_CONTRACT"
IFS='|' read -r BACKGROUND_WORKER_REVISION BACKGROUND_WORKER_LANE BACKGROUND_WORKER_KINDS <<<"$BACKGROUND_WORKER_CONTRACT"
[ "$API_HEALTH" = "$CUTOVER_SHA" ] || {
  echo "error: API reports ${API_HEALTH}, expected ${CUTOVER_SHA}" >&2
  exit 1
}
[ "$INTERACTIVE_WORKER_REVISION" = "$CUTOVER_SHA" ] || {
  echo "error: interactive worker reports ${INTERACTIVE_WORKER_REVISION}, expected ${CUTOVER_SHA}" >&2
  exit 1
}
[ "$BACKGROUND_WORKER_REVISION" = "$CUTOVER_SHA" ] || {
  echo "error: background worker reports ${BACKGROUND_WORKER_REVISION}, expected ${CUTOVER_SHA}" >&2
  exit 1
}
[ "$INTERACTIVE_WORKER_LANE" = "interactive" ] || {
  echo "error: interactive worker reports lane ${INTERACTIVE_WORKER_LANE}" >&2
  exit 1
}
[ "$BACKGROUND_WORKER_LANE" = "background" ] || {
  echo "error: background worker reports lane ${BACKGROUND_WORKER_LANE}" >&2
  exit 1
}
MIGRATION_HEAD="$(compose exec -T api sh -c \
  'cd /app/migrations && /app/.venv/bin/alembic current')"
echo "cutover_sha=${CUTOVER_SHA}"
echo "api_revision=${API_HEALTH}"
echo "worker_interactive_revision=${INTERACTIVE_WORKER_REVISION}"
echo "worker_interactive_kinds=${INTERACTIVE_WORKER_KINDS}"
echo "worker_background_revision=${BACKGROUND_WORKER_REVISION}"
echo "worker_background_kinds=${BACKGROUND_WORKER_KINDS}"
echo "migration_head=${MIGRATION_HEAD}"
REMOTE
