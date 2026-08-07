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

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

if [ "$#" = 1 ]; then
  readonly SOURCE_SHA="$1"
  readonly REPAIR_SOURCE_SHA=""
elif [ "$#" = 3 ] && [ "$2" = "--repair-source-sha" ]; then
  readonly SOURCE_SHA="$1"
  readonly REPAIR_SOURCE_SHA="$3"
else
  die "usage: deploy/hetzner/reconcile-oracle.sh <source-sha> [--repair-source-sha <repair-sha>]"
fi
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || \
  die "source SHA must be 40 lowercase hex characters"
if [ -n "$REPAIR_SOURCE_SHA" ]; then
  [[ "$REPAIR_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || \
    die "repair source SHA must be 40 lowercase hex characters"
  [ "$REPAIR_SOURCE_SHA" != "$SOURCE_SHA" ] || \
    die "repair source SHA must differ from the Oracle target"
fi

readonly EXECUTION_SOURCE_SHA="${REPAIR_SOURCE_SHA:-$SOURCE_SHA}"
readonly REMOTE_BUNDLE="/opt/nexus/releases/${EXECUTION_SOURCE_SHA}"
readonly REMOTE_CONTROLLER="${REMOTE_BUNDLE}/release.py"

for command in ssh timeout; do
  require_command "$command"
done

run_reconcile() {
  local -a arguments=(reconcile-oracle --source-sha "$SOURCE_SHA")
  if [ -n "$REPAIR_SOURCE_SHA" ]; then
    arguments+=(--execution-source-sha "$REPAIR_SOURCE_SHA")
  fi
  timeout --foreground 91m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 90m sudo env \
    "PYTHONDONTWRITEBYTECODE=1" \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" "${arguments[@]}"
}

if [ -z "$REPAIR_SOURCE_SHA" ]; then
  run_reconcile
  exit 0
fi

bundle_installed=false
if timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  sudo test -x "$REMOTE_CONTROLLER"; then
  bundle_installed=true
else
  installed_probe_status="$?"
  [ "$installed_probe_status" = 1 ] || \
    die "could not determine whether the immutable repair bundle is installed"
fi

TEMPORARY=""
REMOTE_TEMPORARY=""
cleanup() {
  if [[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-release\.[A-Za-z0-9]{8}$ ]]; then
    timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
      rm -r -- "$REMOTE_TEMPORARY" >/dev/null 2>&1 || true
  fi
  if [[ "$TEMPORARY" =~ ^/tmp/[^/]+$ ]] && [ -d "$TEMPORARY" ]; then
    rm -r -- "$TEMPORARY"
  fi
}
trap cleanup EXIT

repair_source="$REMOTE_BUNDLE"
if [ "$bundle_installed" = false ]; then
  for command in mktemp scp; do
    require_command "$command"
  done
  TEMPORARY="$(mktemp -d)"
  readonly BUNDLE="${TEMPORARY}/bundle"
  mkdir "$BUNDLE"
  "${ROOT_DIR}/deploy/hetzner/fetch-release-bundle.sh" \
    "$REPAIR_SOURCE_SHA" "$BUNDLE" >/dev/null

  REMOTE_TEMPORARY="$(timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    mktemp -d /tmp/nexus-release.XXXXXXXX)"
  [[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-release\.[A-Za-z0-9]{8}$ ]] || \
    die "host returned an invalid repair transfer directory"
  timeout --foreground 5m scp "${SSH_OPTIONS[@]}" -r \
    "${BUNDLE}/." "${SSH_TARGET}:${REMOTE_TEMPORARY}/"
  repair_source="$REMOTE_TEMPORARY"
fi

timeout --foreground 26m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  timeout --foreground 25m sudo env \
  "PYTHONDONTWRITEBYTECODE=1" \
  "PYTHONPATH=${repair_source}/python" \
  python3 -B "${repair_source}/release.py" install-oracle-repair-bundle \
    --source "$repair_source" \
    --target-source-sha "$SOURCE_SHA" >/dev/null
run_reconcile
