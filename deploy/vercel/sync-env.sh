#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VERCEL_PROJECT_DIR="${VERCEL_PROJECT_DIR:-${ROOT_DIR}/apps/web}"
VERCEL_ENVIRONMENT="${VERCEL_ENVIRONMENT:-production}"
SHARED_ENV="${NEXUS_SHARED_ENV:-${ROOT_DIR}/deploy/env/env-prod}"
FRONTEND_ENV="${NEXUS_FRONTEND_ENV:-${ROOT_DIR}/deploy/env/env-prod-frontend}"

REQUIRED_VERCEL_ENV_KEYS="
NEXUS_ENV
APP_PUBLIC_URL
API_PUBLIC_URL
SUPABASE_URL
SUPABASE_ISSUER
SUPABASE_JWKS_URL
SUPABASE_AUDIENCES
NEXUS_INTERNAL_SECRET
AUTH_ALLOWED_REDIRECT_ORIGINS
STREAM_CORS_ORIGINS
FASTAPI_BASE_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
"

die() {
  echo "error: $*" >&2
  exit 1
}

env_value() {
  awk -v wanted="$1" '
    /^[[:space:]]*(#|$)/ { next }
    index($0, "=") == 0 { next }
    {
      key = substr($0, 1, index($0, "=") - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == wanted) {
        value = substr($0, index($0, "=") + 1)
        found = 1
      }
    }
    END {
      if (found) {
        print value
        exit 0
      }
      exit 1
    }
  ' "$2"
}

normalize_env_value() {
  local value="$1"
  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac
  printf "%s" "$value"
}

is_blank() {
  printf "%s\n" "$1" | grep -Eq '^[[:space:]]*$'
}

require_non_empty_keys() {
  local file="$1"
  local missing=""
  local key value

  for key in $REQUIRED_VERCEL_ENV_KEYS; do
    if ! value="$(env_value "$key" "$file")" || is_blank "$(normalize_env_value "$value")"; then
      missing="${missing} ${key}"
    fi
  done

  [ -z "$missing" ] || die "required production Vercel env keys are missing or empty:${missing}"
}

verify_pulled_vercel_env() {
  local expected_file="$1"
  local pulled_file="$2"
  local key expected actual

  for key in $REQUIRED_VERCEL_ENV_KEYS; do
    expected="$(normalize_env_value "$(env_value "$key" "$expected_file")")"
    if ! actual="$(env_value "$key" "$pulled_file")" || is_blank "$(normalize_env_value "$actual")"; then
      die "Vercel ${VERCEL_ENVIRONMENT} env verification failed: ${key} is missing or empty after pull"
    fi
    actual="$(normalize_env_value "$actual")"
    if [ "$actual" != "$expected" ]; then
      die "Vercel ${VERCEL_ENVIRONMENT} env verification failed: ${key} does not match the local env file"
    fi
  done

  echo "verified required Vercel ${VERCEL_ENVIRONMENT} env keys after pull"
}

command -v vercel >/dev/null 2>&1 || die "vercel CLI is not installed"
for file in "$SHARED_ENV" "$FRONTEND_ENV"; do
  [ -f "$file" ] || die "missing env file: $file"
done

tmp_file="$(mktemp)"
verify_file="$(mktemp)"
trap 'rm -f "$tmp_file" "$verify_file"' EXIT

{
  cat "$SHARED_ENV"
  echo
  cat "$FRONTEND_ENV"
} >"$tmp_file"

if grep -Ev '^[[:space:]]*#' "$tmp_file" | grep -Eq '[<>]|example\.com|=changeme$|=CHANGEME$'; then
  die "env files still contain placeholder values"
fi

require_non_empty_keys "$tmp_file"

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

  printf "%s\n" "$value" | vercel env add "$key" "$VERCEL_ENVIRONMENT" --no-sensitive --yes >/dev/null
  echo "synced ${key} -> Vercel ${VERCEL_ENVIRONMENT}"
done <"$tmp_file"

vercel env pull "$verify_file" --environment "$VERCEL_ENVIRONMENT" --yes >/dev/null
verify_pulled_vercel_env "$tmp_file" "$verify_file"
