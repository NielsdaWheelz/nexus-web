#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HOST="${NEXUS_HOST:-}"
DEPLOY_USER="${NEXUS_DEPLOY_USER:-nexus}"
DEPLOY_PATH="${NEXUS_DEPLOY_PATH:-/opt/nexus-web}"
ENV_FILE="${NEXUS_ENV_FILE:-/etc/nexus/nexus.env}"
SSH_TARGET="${NEXUS_SSH_TARGET:-${DEPLOY_USER}@${HOST}}"
SYNC_ENV="${NEXUS_SYNC_ENV:-0}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ -n "$HOST" ] || [ -n "${NEXUS_SSH_TARGET:-}" ] || die "set NEXUS_HOST or NEXUS_SSH_TARGET"
command -v rsync >/dev/null 2>&1 || die "rsync is not installed locally"
command -v ssh >/dev/null 2>&1 || die "ssh is not installed locally"

if [ "$SYNC_ENV" = "1" ]; then
  "${ROOT_DIR}/deploy/hetzner/sync-env.sh"
fi

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

ssh "$SSH_TARGET" \
  "DEPLOY_PATH='${DEPLOY_PATH}' ENV_FILE='${ENV_FILE}' bash -s" <<'REMOTE'
set -euo pipefail

cd "$DEPLOY_PATH"

compose() {
  docker compose --env-file "$ENV_FILE" -f deploy/hetzner/docker-compose.yml "$@"
}

compose build --pull
compose run -T --rm --no-deps api sh -c 'cd /app/migrations && /app/.venv/bin/alembic upgrade head'
compose up -d --remove-orphans
compose ps
REMOTE
