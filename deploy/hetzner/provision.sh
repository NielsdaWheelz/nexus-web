#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SERVER_NAME="${HCLOUD_SERVER_NAME:-nexus-api-worker}"
SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cpx11}"
LOCATION="${HCLOUD_LOCATION:-hil}"
IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
SSH_KEY="${HCLOUD_SSH_KEY:-}"
FIREWALL_NAME="${HCLOUD_FIREWALL_NAME:-nexus-web}"
readonly HCLOUD_CONTEXT=dev-server
TAILSCALE_AUTH_KEY_FILE="${NEXUS_TAILSCALE_AUTH_KEY_FILE:-}"
CLOUD_INIT="${ROOT_DIR}/deploy/hetzner/cloud-init.yml"
FIREWALL_RULES="${ROOT_DIR}/deploy/hetzner/firewall.json"
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
server_id="$(
  hcloud --context "$HCLOUD_CONTEXT" server list --output json |
    python3 -c '
import json, sys
matches = [server["id"] for server in json.load(sys.stdin) if server["name"] == sys.argv[1]]
if len(matches) > 1:
    raise SystemExit("the server name identifies more than one host")
if matches:
    print(matches[0])
' "$SERVER_NAME"
)"
if [ -n "$server_id" ]; then
  echo "server already exists: ${SERVER_NAME}; provisioning makes no changes"
  hcloud --context "$HCLOUD_CONTEXT" server describe "$server_id"
  exit 0
fi
[ -n "$SSH_KEY" ] || die "set HCLOUD_SSH_KEY to an existing Hetzner SSH key name"
[ -f "$TAILSCALE_AUTH_KEY_FILE" ] || die "set NEXUS_TAILSCALE_AUTH_KEY_FILE to a private single-use tagged enrollment key"

ssh_public_key="$(
  hcloud --context "$HCLOUD_CONTEXT" ssh-key describe "$SSH_KEY" --output json |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["public_key"].strip())'
)"
[ -n "$ssh_public_key" ] || die "could not read public key for HCLOUD_SSH_KEY=${SSH_KEY}"

rendered_cloud_init="$(mktemp)"
TEMP_FILES+=("$rendered_cloud_init")
python3 - "$CLOUD_INIT" "$rendered_cloud_init" "$ssh_public_key" "$TAILSCALE_AUTH_KEY_FILE" <<'PY'
from pathlib import Path
import re
import stat
import sys

key_file = Path(sys.argv[4])
if stat.S_IMODE(key_file.stat().st_mode) != 0o600:
    raise SystemExit("the Tailscale enrollment key file must have mode 0600")
key = key_file.read_text().strip()
if re.fullmatch(r"tskey-auth-[A-Za-z0-9_-]+", key) is None:
    raise SystemExit("the Tailscale enrollment key has an invalid shape")
template = Path(sys.argv[1]).read_text()
rendered = template.replace("__NEXUS_SSH_PUBLIC_KEY__", sys.argv[3])
Path(sys.argv[2]).write_text(rendered.replace("__NEXUS_TAILSCALE_AUTH_KEY__", key))
PY

if ! hcloud --context "$HCLOUD_CONTEXT" firewall describe "$FIREWALL_NAME" >/dev/null 2>&1; then
  hcloud --context "$HCLOUD_CONTEXT" firewall create --name "$FIREWALL_NAME" --rules-file "$FIREWALL_RULES"
fi

observed_firewall="$(mktemp)"
TEMP_FILES+=("$observed_firewall")
hcloud --context "$HCLOUD_CONTEXT" firewall describe "$FIREWALL_NAME" --output json >"$observed_firewall"
python3 - "$FIREWALL_RULES" "$observed_firewall" <<'PY'
import json
from pathlib import Path
import sys

def boundary(rule):
    return (rule["direction"], rule["protocol"], rule.get("port"),
            sorted(rule.get("source_ips") or []), sorted(rule.get("destination_ips") or []))

desired = json.loads(Path(sys.argv[1]).read_text())
observed = json.loads(Path(sys.argv[2]).read_text())["rules"]
if sorted(map(boundary, desired)) != sorted(map(boundary, observed)):
    raise SystemExit("the existing firewall differs from the declared private boundary")
PY

hcloud --context "$HCLOUD_CONTEXT" server create \
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
echo "  verify the new host key through the Hetzner console, then:"
echo "  ssh nexus@nexus-prod cloud-init status --wait"
