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
compose stop worker api
compose run -T --rm api sh -c 'cd /app/migrations && /app/.venv/bin/alembic upgrade head' </dev/null
compose run -T --rm --no-deps worker /app/.venv/bin/python /app/scripts/ensure_oracle_seed_objects.py </dev/null
ORACLE_CORPUS_OWNER_USER_ID="$(
  compose run -T --rm --no-deps worker /app/.venv/bin/python -c 'import os; print(os.environ.get("NEXUS_ORACLE_CORPUS_OWNER_USER_ID", "").strip())' </dev/null
)"
if [ -z "$ORACLE_CORPUS_OWNER_USER_ID" ]; then
  echo "error: set NEXUS_ORACLE_CORPUS_OWNER_USER_ID in ${ENV_FILE} for Oracle Corpus seeding" >&2
  exit 1
fi
compose run -T --rm --no-deps worker /app/.venv/bin/python /app/scripts/oracle/seed_corpus_library.py --owner-user "$ORACLE_CORPUS_OWNER_USER_ID" --drain </dev/null
compose run -T --rm --no-deps worker /app/.venv/bin/python /app/scripts/oracle/check_corpus_readiness.py </dev/null
compose up -d --remove-orphans --force-recreate
compose ps

API_HEALTH="$(compose exec -T api /app/.venv/bin/python -c \
  'import json, urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5))["data"]["cutover_sha"])')"
WORKER_REVISION="$(compose exec -T worker /app/.venv/bin/python -c \
  'import os; print(os.environ.get("CUTOVER_SHA", ""))')"
[ "$API_HEALTH" = "$CUTOVER_SHA" ] || {
  echo "error: API reports ${API_HEALTH}, expected ${CUTOVER_SHA}" >&2
  exit 1
}
[ "$WORKER_REVISION" = "$CUTOVER_SHA" ] || {
  echo "error: worker reports ${WORKER_REVISION}, expected ${CUTOVER_SHA}" >&2
  exit 1
}
MIGRATION_HEAD="$(compose exec -T api sh -c \
  'cd /app/migrations && /app/.venv/bin/alembic current')"
echo "cutover_sha=${CUTOVER_SHA}"
echo "api_revision=${API_HEALTH}"
echo "worker_revision=${WORKER_REVISION}"
echo "migration_head=${MIGRATION_HEAD}"
REMOTE
