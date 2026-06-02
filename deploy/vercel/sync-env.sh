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
SUPABASE_ISSUER
SUPABASE_JWKS_URL
SUPABASE_AUDIENCES
NEXUS_INTERNAL_SECRET
AUTH_ALLOWED_REDIRECT_ORIGINS
STREAM_CORS_ORIGINS
FASTAPI_BASE_URL
CSP_EXTRA_CONNECT_ORIGINS
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
"

SENSITIVE_VERCEL_ENV_KEYS="
NEXUS_INTERNAL_SECRET
"

FORBIDDEN_VERCEL_ENV_KEYS="
DATABASE_URL
POSTGRES_USER
POSTGRES_DB
POSTGRES_PASSWORD
R2_ENDPOINT_URL
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
SUPABASE_DATABASE_URL
SUPABASE_AUTH_ADMIN_KEY
SUPABASE_SERVICE_KEY
SUPABASE_SERVICE_ROLE_KEY
SERVICE_ROLE_KEY
STORAGE_PROVIDER
STORAGE_BUCKET
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

is_sensitive_vercel_key() {
  local candidate="$1"
  local key

  for key in $SENSITIVE_VERCEL_ENV_KEYS; do
    [ "$candidate" = "$key" ] && return 0
  done
  return 1
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

require_prod_env() {
  local file="$1"
  local value

  value="$(normalize_env_value "$(env_value "NEXUS_ENV" "$file" || true)")"
  [ "$value" = "prod" ] || die "NEXUS_ENV must be prod for Vercel production sync"
}

reject_backend_runtime_keys() {
  local file="$1"
  local key value

  for key in $FORBIDDEN_VERCEL_ENV_KEYS; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} must not be present in Vercel frontend env"
    fi
  done
}

remove_forbidden_vercel_keys() {
  local key

  for key in $FORBIDDEN_VERCEL_ENV_KEYS; do
    if vercel env rm "$key" "$VERCEL_ENVIRONMENT" --yes >/dev/null 2>&1; then
      echo "removed forbidden ${key} from Vercel ${VERCEL_ENVIRONMENT}"
    else
      echo "confirmed forbidden ${key} is absent from Vercel ${VERCEL_ENVIRONMENT}"
    fi
  done
}

verify_pulled_vercel_env() {
  local expected_file="$1"
  local pulled_file="$2"
  local key expected actual

  for key in $REQUIRED_VERCEL_ENV_KEYS; do
    if is_sensitive_vercel_key "$key"; then
      continue
    fi
    expected="$(normalize_env_value "$(env_value "$key" "$expected_file")")"
    if ! actual="$(env_value "$key" "$pulled_file")" || is_blank "$(normalize_env_value "$actual")"; then
      die "Vercel ${VERCEL_ENVIRONMENT} env verification failed: ${key} is missing or empty after pull"
    fi
    actual="$(normalize_env_value "$actual")"
    if [ "$actual" != "$expected" ]; then
      die "Vercel ${VERCEL_ENVIRONMENT} env verification failed: ${key} does not match the local env file"
    fi
  done

  for key in $FORBIDDEN_VERCEL_ENV_KEYS; do
    if actual="$(env_value "$key" "$pulled_file")" && ! is_blank "$(normalize_env_value "$actual")"; then
      die "Vercel ${VERCEL_ENVIRONMENT} env verification failed: forbidden ${key} is still present after sync"
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
require_prod_env "$tmp_file"
reject_backend_runtime_keys "$tmp_file"

cd "$VERCEL_PROJECT_DIR"

remove_forbidden_vercel_keys

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

  if is_sensitive_vercel_key "$key"; then
    printf "%s\n" "$value" | vercel env add "$key" "$VERCEL_ENVIRONMENT" --yes >/dev/null
  else
    printf "%s\n" "$value" | vercel env add "$key" "$VERCEL_ENVIRONMENT" --no-sensitive --yes >/dev/null
  fi
  echo "synced ${key} -> Vercel ${VERCEL_ENVIRONMENT}"
done <"$tmp_file"

vercel env pull "$verify_file" --environment "$VERCEL_ENVIRONMENT" --yes >/dev/null
verify_pulled_vercel_env "$tmp_file" "$verify_file"
