#!/usr/bin/env bash
# Fetch/install one immutable candidate bundle, then stop after its bounded
# existing-VPS Codex capacity qualification: one v2 qualification wrapper
# containing the v4 three-turn dawn_write/Terra-medium canary.
# This script never calls apply.
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

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$#" = 1 ] || die "usage: deploy/hetzner/prove-codex-capacity.sh <source-sha>"
readonly SOURCE_SHA="$1"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex characters"

for command in git scp ssh timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed"
done
[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "capacity qualification requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "source SHA must equal checked-out HEAD"
[ -x "${ROOT_DIR}/deploy/hetzner/fetch-release-bundle.sh" ] || \
  die "immutable release bundle resolver is not executable"

TEMPORARY="$(mktemp -d)"
readonly TEMPORARY
readonly BUNDLE="${TEMPORARY}/bundle"
readonly REMOTE_BUNDLE="/opt/nexus/releases/${SOURCE_SHA}"
readonly REMOTE_CONTROLLER="${REMOTE_BUNDLE}/release.py"
REMOTE_TEMPORARY=""

cleanup() {
  if [[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-capacity\.[A-Za-z0-9]{8}$ ]]; then
    timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
      rm -r -- "$REMOTE_TEMPORARY" >/dev/null 2>&1 || true
  fi
  rm -r -- "$TEMPORARY"
}
trap cleanup EXIT

mkdir "$BUNDLE"
"${ROOT_DIR}/deploy/hetzner/fetch-release-bundle.sh" "$SOURCE_SHA" "$BUNDLE" >/dev/null

REMOTE_TEMPORARY="$(timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  mktemp -d /tmp/nexus-capacity.XXXXXXXX)"
[[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-capacity\.[A-Za-z0-9]{8}$ ]] || \
  die "host returned an invalid transfer directory"
timeout --foreground 5m scp "${SSH_OPTIONS[@]}" -r \
  "${BUNDLE}/." "${SSH_TARGET}:${REMOTE_TEMPORARY}/"
timeout --foreground 3m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  timeout --foreground 2m sudo env PYTHONDONTWRITEBYTECODE=1 \
  "PYTHONPATH=${REMOTE_TEMPORARY}/python" \
  python3 -B "${REMOTE_TEMPORARY}/release.py" install-bundle \
    --source "$REMOTE_TEMPORARY" >/dev/null

# The installed controller owns candidate identity, AppArmor preparation,
# cgroup/service observation, sanitized evidence, and the named v4 canary.
# Full target-set and MCP coverage belong to the protected nightly. Do not append
# deployment, migration, or frontend commands after this call.
timeout --foreground 12m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  timeout --foreground 11m sudo env PYTHONDONTWRITEBYTECODE=1 \
  "PYTHONPATH=${REMOTE_BUNDLE}/python" \
  python3 -B "$REMOTE_CONTROLLER" qualify-codex-capacity \
    --source-sha "$SOURCE_SHA"
