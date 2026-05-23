#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SERVER_NAME="${HCLOUD_SERVER_NAME:-nexus-api-worker}"
SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cpx11}"
LOCATION="${HCLOUD_LOCATION:-hil}"
IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
SSH_KEY="${HCLOUD_SSH_KEY:-}"
FIREWALL_NAME="${HCLOUD_FIREWALL_NAME:-nexus-web}"
SSH_ALLOWED_IPS="${HCLOUD_SSH_ALLOWED_IPS:-}"
CLOUD_INIT="${ROOT_DIR}/deploy/hetzner/cloud-init.yml"
TEMP_FILES=()

cleanup() {
  if [ "${#TEMP_FILES[@]}" -gt 0 ]; then
    rm -f "${TEMP_FILES[@]}"
  fi
}
trap cleanup EXIT

die() {
  echo "error: $*" >&2
  exit 1
}

command -v hcloud >/dev/null 2>&1 || die "hcloud CLI is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is required to render cloud-init"
[ -n "$SSH_KEY" ] || die "set HCLOUD_SSH_KEY to an existing Hetzner SSH key name"
[ -n "$SSH_ALLOWED_IPS" ] || die "set HCLOUD_SSH_ALLOWED_IPS to comma-separated SSH source CIDRs, e.g. '<your-ip>/32'"

ssh_public_key="$(
  hcloud ssh-key describe "$SSH_KEY" --output json |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["public_key"].strip())'
)"
[ -n "$ssh_public_key" ] || die "could not read public key for HCLOUD_SSH_KEY=${SSH_KEY}"

rendered_cloud_init="$(mktemp)"
TEMP_FILES+=("$rendered_cloud_init")
python3 - "$CLOUD_INIT" "$rendered_cloud_init" "$ssh_public_key" <<'PY'
from pathlib import Path
import sys

template = Path(sys.argv[1]).read_text()
Path(sys.argv[2]).write_text(template.replace("__NEXUS_SSH_PUBLIC_KEY__", sys.argv[3]))
PY

if hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
  echo "server already exists: ${SERVER_NAME}"
  hcloud server describe "$SERVER_NAME"
  exit 0
fi

if ! hcloud firewall describe "$FIREWALL_NAME" >/dev/null 2>&1; then
  rules_file="$(mktemp)"
  TEMP_FILES+=("$rules_file")

  IFS=',' read -r -a ssh_sources <<<"$SSH_ALLOWED_IPS"
  {
    echo '['
    for i in "${!ssh_sources[@]}"; do
      source="$(echo "${ssh_sources[$i]}" | xargs)"
      [ -n "$source" ] || continue
      [ "$i" -gt 0 ] && echo ','
      printf '{"direction":"in","protocol":"tcp","port":"22","source_ips":["%s"]}' "$source"
    done
    echo ',{"direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]}'
    echo ',{"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]}'
    echo ']'
  } >"$rules_file"

  hcloud firewall create --name "$FIREWALL_NAME" --rules-file "$rules_file"
fi

hcloud server create \
  --name "$SERVER_NAME" \
  --type "$SERVER_TYPE" \
  --image "$IMAGE" \
  --location "$LOCATION" \
  --ssh-key "$SSH_KEY" \
  --firewall "$FIREWALL_NAME" \
  --enable-protection delete \
  --enable-protection rebuild \
  --user-data-from-file "$rendered_cloud_init" \
  --label app=nexus \
  --label role=api-worker

echo
echo "server created. wait for cloud-init to finish before deploying:"
echo "  ssh nexus@<server-ip> cloud-init status --wait"
