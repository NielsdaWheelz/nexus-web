#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIFECYCLE_FILE="${R2_LIFECYCLE_FILE:-${ROOT_DIR}/deploy/cloudflare/r2-lifecycle.example.json}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "set CLOUDFLARE_ACCOUNT_ID"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "set CLOUDFLARE_API_TOKEN"
[ -n "${R2_BUCKET:-}" ] || die "set R2_BUCKET"
[ -f "$LIFECYCLE_FILE" ] || die "lifecycle file not found: $LIFECYCLE_FILE"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"

python3 -m json.tool "$LIFECYCLE_FILE" >/dev/null

curl -fsS \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/lifecycle" \
  -X PUT \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${LIFECYCLE_FILE}" >/dev/null

echo "applied R2 lifecycle rules from ${LIFECYCLE_FILE}"
