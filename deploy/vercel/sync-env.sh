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
R2_S3_API_ORIGIN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
"

OPTIONAL_READABLE_VERCEL_ENV_KEYS="
AUTH_TRUSTED_PROXY_ORIGINS
SERVER_ACTION_ALLOWED_ORIGINS
NEXUS_EXTENSION_REDIRECT_ORIGINS
"

FRONTEND_ONLY_ENV_KEYS="
AUTH_ALLOWED_REDIRECT_ORIGINS
AUTH_TRUSTED_PROXY_ORIGINS
SERVER_ACTION_ALLOWED_ORIGINS
NEXUS_EXTENSION_REDIRECT_ORIGINS
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
FASTAPI_BASE_URL
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
CSP_EXTRA_CONNECT_ORIGINS
SUPABASE_DATABASE_URL
SUPABASE_AUTH_ADMIN_KEY
SUPABASE_SERVICE_KEY
SUPABASE_SERVICE_ROLE_KEY
SERVICE_ROLE_KEY
STORAGE_PROVIDER
STORAGE_BUCKET
X_API_BEARER_TOKEN
X_API_INCLUDE_USER_EXPANSIONS
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

require_cloudflare_r2_s3_api_origin() {
  local file="$1"
  local value

  value="$(normalize_env_value "$(env_value "R2_S3_API_ORIGIN" "$file" || true)")"
  R2_S3_API_ORIGIN="$value" python3 - <<'PY' || die "R2_S3_API_ORIGIN must be the Cloudflare R2 S3 API origin"
import os
import sys
from urllib.parse import urlparse

origin = os.environ["R2_S3_API_ORIGIN"]
parsed = urlparse(origin)
host = parsed.hostname or ""
if (
    parsed.scheme != "https"
    or parsed.username
    or parsed.password
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
    or not host.endswith(".r2.cloudflarestorage.com")
):
    sys.exit(1)
PY
}

require_auth_origin_contract() {
  local file="$1"
  local allowed trusted server_actions extension_origins

  allowed="$(normalize_env_value "$(env_value "AUTH_ALLOWED_REDIRECT_ORIGINS" "$file" || true)")"
  trusted="$(normalize_env_value "$(env_value "AUTH_TRUSTED_PROXY_ORIGINS" "$file" || true)")"
  server_actions="$(normalize_env_value "$(env_value "SERVER_ACTION_ALLOWED_ORIGINS" "$file" || true)")"
  extension_origins="$(normalize_env_value "$(env_value "NEXUS_EXTENSION_REDIRECT_ORIGINS" "$file" || true)")"
  AUTH_ALLOWED_REDIRECT_ORIGINS="$allowed" \
    AUTH_TRUSTED_PROXY_ORIGINS="$trusted" \
    SERVER_ACTION_ALLOWED_ORIGINS="$server_actions" \
    NEXUS_EXTENSION_REDIRECT_ORIGINS="$extension_origins" \
    python3 - <<'PY' || die "auth origin env contract is invalid"
import os
import sys
from urllib.parse import urlparse

def parse_origins(name: str) -> list[str]:
    origins: list[str] = []
    for raw_entry in os.environ.get(name, "").split(","):
        entry = raw_entry.strip()
        if not entry:
            continue
        parsed = urlparse(entry)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or not parsed.netloc
        ):
            sys.exit(1)
        origins.append(f"{parsed.scheme}://{parsed.netloc.lower()}")
    return origins

if not parse_origins("AUTH_ALLOWED_REDIRECT_ORIGINS"):
    sys.exit(1)
trusted = parse_origins("AUTH_TRUSTED_PROXY_ORIGINS")
parse_origins("NEXUS_EXTENSION_REDIRECT_ORIGINS")
if trusted and not os.environ.get("SERVER_ACTION_ALLOWED_ORIGINS", "").strip():
    sys.exit(1)
PY
}

require_server_action_allowed_origins() {
  local file="$1"
  local value

  value="$(normalize_env_value "$(env_value "SERVER_ACTION_ALLOWED_ORIGINS" "$file" || true)")"
  SERVER_ACTION_ALLOWED_ORIGINS="$value" python3 - <<'PY' || die "SERVER_ACTION_ALLOWED_ORIGINS must contain only Next.js domain patterns"
import os
import re
import sys

value = os.environ["SERVER_ACTION_ALLOWED_ORIGINS"]
label_re = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")

for raw_entry in value.split(","):
    entry = raw_entry.strip().lower()
    if not entry:
        continue
    domain = entry[2:] if entry.startswith("*.") else entry
    labels = domain.split(".")
    if (
        entry == "*"
        or "://" in entry
        or "/" in domain
        or ":" in domain
        or "*" in domain
        or domain.startswith(".")
        or domain.endswith(".")
        or "localhost" in domain
        or "127.0.0.1" in domain
        or len(labels) < 2
        or not all(label_re.fullmatch(label) for label in labels)
        or (entry.startswith("*.") and len(labels) < 3)
    ):
        sys.exit(1)
PY
}

reject_frontend_only_keys_from_shared_env() {
  local file="$1"
  local key value

  for key in $FRONTEND_ONLY_ENV_KEYS; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} must live in env-prod-frontend, not env-prod"
    fi
  done
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

  for key in $OPTIONAL_READABLE_VERCEL_ENV_KEYS; do
    expected="$(normalize_env_value "$(env_value "$key" "$expected_file" || true)")"
    if is_blank "$expected"; then
      continue
    fi
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
command -v python3 >/dev/null 2>&1 || die "python3 is not installed locally"
for file in "$SHARED_ENV" "$FRONTEND_ENV"; do
  [ -f "$file" ] || die "missing env file: $file"
done

reject_frontend_only_keys_from_shared_env "$SHARED_ENV"

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
require_cloudflare_r2_s3_api_origin "$tmp_file"
require_auth_origin_contract "$tmp_file"
require_server_action_allowed_origins "$tmp_file"
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
