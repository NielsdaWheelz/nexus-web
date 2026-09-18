#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR
readonly SSH_TARGET="nexus@5.78.194.235"
readonly -a SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)

BACKUP_ENV="${NEXUS_BACKUP_ENV:-${ROOT_DIR}/deploy/env/env-prod-backup}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$#" = 1 ] || die "usage: deploy/hetzner/sync-backup-env.sh <never-published-source-sha>"
SOURCE_SHA="$1"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex characters"

for command in git scp ssh timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed locally"
done

[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "backup config publication requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "backup config publication SHA must equal checked-out HEAD"
timeout --foreground 2m git -C "$ROOT_DIR" fetch --quiet origin main
[ "$(git -C "$ROOT_DIR" rev-parse origin/main)" = "$SOURCE_SHA" ] || \
  die "backup config publication SHA must equal origin/main"
[ -f "$BACKUP_ENV" ] || die "missing backup env file: $BACKUP_ENV"

remote_directory=""
cleanup() {
  if [[ "$remote_directory" =~ ^/tmp/nexus-backup-config\.[A-Za-z0-9]{8}$ ]]; then
    timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
      rm -r -- "$remote_directory" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

remote_directory="$(
  timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    mktemp -d /tmp/nexus-backup-config.XXXXXXXX
)"
[[ "$remote_directory" =~ ^/tmp/nexus-backup-config\.[A-Za-z0-9]{8}$ ]] || \
  die "host returned an invalid backup config transfer path"
timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  mkdir -p -- "${remote_directory}/python/nexus"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "$BACKUP_ENV" "${SSH_TARGET}:${remote_directory}/source.env"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "${ROOT_DIR}/deploy/hetzner/release.py" \
  "${SSH_TARGET}:${remote_directory}/release.py"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "${ROOT_DIR}/python/nexus/__init__.py" \
  "${ROOT_DIR}/python/nexus/release_artifact.py" \
  "${SSH_TARGET}:${remote_directory}/python/nexus/"

timeout --foreground 3m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  timeout --foreground 2m sudo env PYTHONDONTWRITEBYTECODE=1 \
  "PYTHONPATH=${remote_directory}/python" \
  python3 -B "${remote_directory}/release.py" publish-backup-config \
    --source "${remote_directory}/source.env" \
    --next-source-sha "$SOURCE_SHA"
