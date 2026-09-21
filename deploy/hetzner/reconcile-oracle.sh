#!/usr/bin/env bash
# Publish the Oracle corpus plate the running release expects.
#
#   deploy/hetzner/reconcile-oracle.sh
#
# The live API's /version names the manifest digest this release must publish.
# Writers stop for the publication so nothing races the corpus tables, then
# start again. Idempotent: a reconciled corpus exits early.
set -euo pipefail

readonly SSH_TARGET="nexus@5.78.194.235"
readonly -a SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15)
readonly CONFIG_FILE="/etc/nexus/current.env"
readonly COMPOSE_FILE="/etc/nexus/docker-compose.yml"
readonly -a WRITERS=(api worker-interactive worker-background)

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$#" = 0 ] || die "usage: deploy/hetzner/reconcile-oracle.sh"
for command in curl jq ssh timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed"
done

on_host() {
  timeout --foreground "$1" ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" "$2"
}

config_value() {
  on_host 30s "sudo grep -m1 '^$1=' ${CONFIG_FILE}" | sed -e 's/^[^=]*=//' -e 's/^"\(.*\)"$/\1/'
}

compose() {
  local budget="$1"
  shift
  on_host "$budget" "sudo env API_IMAGE=${API_IMAGE} WORKER_IMAGE=${WORKER_IMAGE} \
    NEXUS_CONFIG_FILE=${CONFIG_FILE} docker compose --project-name nexus \
    --env-file ${CONFIG_FILE} --file ${COMPOSE_FILE} $*"
}

oracle() {
  local budget="$1" command="$2"
  shift 2
  compose "$budget" "run --rm --no-deps --no-TTY worker-background \
    python -m nexus.ops.oracle_reconcile ${command} \
    --manifest-directory /app/scripts/oracle \
    --expected-manifest-digest ${EXPECTED_DIGEST} $*"
}

exact_publication() {
  jq -e --arg digest "$EXPECTED_DIGEST" '
    .status == "published" and .manifest_digest == $digest
    and .support_ready == true and .published == true
    and .publication.manifest_digest == $digest
    and (.errors | length) == 0
    and ((.removals.work_keys + .removals.plate_source_urls + .removals.anchor_keys) | length) == 0
  ' >/dev/null
}

CADDY_SITE="$(config_value CADDY_SITE)"
OWNER_USER="$(config_value NEXUS_ORACLE_CORPUS_OWNER_USER_ID)"
[ -n "$CADDY_SITE" ] && [ -n "$OWNER_USER" ] || die "the host config has no site or corpus owner"
EXPECTED_DIGEST="$(
  curl --fail --silent --show-error --max-time 10 "https://${CADDY_SITE}/version" |
    jq -er '.data.expected_oracle_manifest_digest'
)" || die "the running API does not name an expected Oracle manifest digest"
[[ "$EXPECTED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the expected manifest digest is malformed"

# The running containers name their own images, so the reconcile never needs a
# candidate manifest: it publishes for whatever release is already current.
API_IMAGE="$(on_host 30s "docker inspect -f '{{.Config.Image}}' nexus-api-1" | tr -d '\n')"
WORKER_IMAGE="$(
  on_host 30s "docker inspect -f '{{.Config.Image}}' nexus-worker-background-1" | tr -d '\n'
)"
readonly CADDY_SITE OWNER_USER EXPECTED_DIGEST API_IMAGE WORKER_IMAGE

if oracle 5m status --owner-user "$OWNER_USER" | exact_publication; then
  echo "Oracle corpus already publishes ${EXPECTED_DIGEST}"
  exit 0
fi

oracle 5m preflight >/dev/null
compose 5m "stop --timeout 30 ${WRITERS[*]}"
oracle 5m unpublish >/dev/null
oracle 46m reconcile-support >/dev/null
oracle 10m publish --owner-user "$OWNER_USER" >/dev/null
compose 10m "up --detach --wait --wait-timeout 240"

oracle 5m status --owner-user "$OWNER_USER" | exact_publication || \
  die "the Oracle corpus did not converge on ${EXPECTED_DIGEST}"
echo "Oracle corpus publishes ${EXPECTED_DIGEST}"
