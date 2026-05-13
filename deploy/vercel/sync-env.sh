#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VERCEL_PROJECT_DIR="${VERCEL_PROJECT_DIR:-${ROOT_DIR}/apps/web}"
VERCEL_ENVIRONMENT="${VERCEL_ENVIRONMENT:-production}"
SHARED_ENV="${NEXUS_SHARED_ENV:-${ROOT_DIR}/deploy/env/env-prod}"
FRONTEND_ENV="${NEXUS_FRONTEND_ENV:-${ROOT_DIR}/deploy/env/env-prod-frontend}"

die() {
  echo "error: $*" >&2
  exit 1
}

command -v vercel >/dev/null 2>&1 || die "vercel CLI is not installed"
for file in "$SHARED_ENV" "$FRONTEND_ENV"; do
  [ -f "$file" ] || die "missing env file: $file"
done

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

{
  cat "$SHARED_ENV"
  echo
  cat "$FRONTEND_ENV"
} >"$tmp_file"

if grep -Eq '<[^>]+>|example\.com|=changeme$|=CHANGEME$' "$tmp_file"; then
  die "env files still contain placeholder values"
fi

cd "$VERCEL_PROJECT_DIR"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ""|\#*) continue ;;
  esac

  key="${line%%=*}"
  value="${line#*=}"

  if [ -z "$key" ] || [ "$key" = "$line" ]; then
    continue
  fi

  vercel env rm "$key" "$VERCEL_ENVIRONMENT" --yes >/dev/null 2>&1 || true
  if [ -z "$value" ]; then
    echo "removed ${key} from Vercel ${VERCEL_ENVIRONMENT}"
    continue
  fi

  printf "%s" "$value" | vercel env add "$key" "$VERCEL_ENVIRONMENT" >/dev/null
  echo "synced ${key} -> Vercel ${VERCEL_ENVIRONMENT}"
done <"$tmp_file"
