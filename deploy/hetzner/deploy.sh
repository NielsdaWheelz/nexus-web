#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HOST="${NEXUS_HOST:-}"
DEPLOY_USER="${NEXUS_DEPLOY_USER:-nexus}"
DEPLOY_PATH="${NEXUS_DEPLOY_PATH:-/opt/nexus-web}"
ENV_FILE="${NEXUS_REMOTE_ENV_FILE:-${NEXUS_ENV_FILE:-/etc/nexus/nexus.env}}"
SSH_TARGET="${NEXUS_SSH_TARGET:-${DEPLOY_USER}@${HOST}}"
SYNC_ENV="${NEXUS_SYNC_ENV:-1}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ -n "$HOST" ] || [ -n "${NEXUS_SSH_TARGET:-}" ] || die "set NEXUS_HOST or NEXUS_SSH_TARGET"
command -v rsync >/dev/null 2>&1 || die "rsync is not installed locally"
command -v ssh >/dev/null 2>&1 || die "ssh is not installed locally"

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
  --exclude ".git/" \
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
  "DEPLOY_PATH='${DEPLOY_PATH}' ENV_FILE='${ENV_FILE}' bash -s" <<'REMOTE'
set -euo pipefail

cd "$DEPLOY_PATH"

compose() {
  NEXUS_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -f deploy/hetzner/docker-compose.yml "$@"
}

compose build --pull
compose up -d postgres
for i in $(seq 1 30); do
  if compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
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
compose up -d --remove-orphans
compose ps
REMOTE
