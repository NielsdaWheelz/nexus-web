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

SHARED_ENV="${NEXUS_SHARED_ENV:-${ROOT_DIR}/deploy/env/env-prod}"
BACKEND_ENV="${NEXUS_BACKEND_ENV:-${ROOT_DIR}/deploy/env/env-prod-backend}"
WORKER_ENV="${NEXUS_WORKER_ENV:-${ROOT_DIR}/deploy/env/env-prod-worker}"

REQUIRED_HETZNER_ENV_KEYS="
NEXUS_ENV
APP_PUBLIC_URL
SUPABASE_ISSUER
SUPABASE_JWKS_URL
SUPABASE_AUDIENCES
NEXUS_INTERNAL_SECRET
STREAM_CORS_ORIGINS
CADDY_SITE
CADDY_ACME_EMAIL
DATABASE_URL
POSTGRES_USER
POSTGRES_DB
POSTGRES_PASSWORD
R2_S3_API_ORIGIN
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
STREAM_TOKEN_SIGNING_KEY
STREAM_BASE_URL
NEXUS_ORACLE_CORPUS_OWNER_USER_ID
BILLING_ENABLED
PODCASTS_ENABLED
YOUTUBE_DATA_API_KEY
X_API_BEARER_TOKEN
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
MOONSHOT_API_KEY
NEXUS_FABLE_RETENTION_ACCEPTED_AT
POSTGRES_IMAGE
CADDY_IMAGE
"

die() {
  echo "error: $*" >&2
  exit 1
}

require_digest_image() {
  local key="$1"
  local file="$2"
  local value

  value="$(normalize_env_value "$(env_value "$key" "$file" || true)")"
  [[ "$value" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || \
    die "${key} must be an immutable image reference by sha256 digest"
}

require_duplicate_free_env() {
  local file="$1"

  awk '
    /^[[:space:]]*(#|$)/ { next }
    index($0, "=") == 0 { exit 2 }
    {
      key = substr($0, 1, index($0, "=") - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key !~ /^[A-Z][A-Z0-9_]*$/ || seen[key]++) { exit 3 }
    }
  ' "$file" || die "production env must contain only valid, globally unique keys"
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

is_true() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

require_non_empty_keys() {
  local file="$1"
  local missing=""
  local key value billing_enabled podcasts_enabled

  for key in $REQUIRED_HETZNER_ENV_KEYS; do
    if ! value="$(env_value "$key" "$file")" || is_blank "$(normalize_env_value "$value")"; then
      missing="${missing} ${key}"
    fi
  done

  billing_enabled="$(normalize_env_value "$(env_value "BILLING_ENABLED" "$file" || true)")"
  if is_true "$billing_enabled"; then
    for key in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PLUS_PRICE_ID STRIPE_AI_PLUS_PRICE_ID STRIPE_AI_PRO_PRICE_ID; do
      if ! value="$(env_value "$key" "$file")" || is_blank "$(normalize_env_value "$value")"; then
        missing="${missing} ${key}"
      fi
    done
  fi

  podcasts_enabled="$(normalize_env_value "$(env_value "PODCASTS_ENABLED" "$file" || true)")"
  if is_true "$podcasts_enabled"; then
    for key in PODCAST_INDEX_API_KEY PODCAST_INDEX_API_SECRET; do
      if ! value="$(env_value "$key" "$file")" || is_blank "$(normalize_env_value "$value")"; then
        missing="${missing} ${key}"
      fi
    done
  fi

  email_ingest_enabled="$(normalize_env_value "$(env_value "EMAIL_INGEST_ENABLED" "$file" || true)")"
  if is_true "$email_ingest_enabled"; then
    for key in EMAIL_INGEST_HMAC_SECRET EMAIL_INGEST_ADDRESS_SLUG EMAIL_INGEST_DOMAIN EMAIL_INGEST_OWNER_USER_ID; do
      if ! value="$(env_value "$key" "$file")" || is_blank "$(normalize_env_value "$value")"; then
        missing="${missing} ${key}"
      fi
    done
  fi

  [ -z "$missing" ] || die "required production Hetzner env keys are missing or empty:${missing}"
}

require_prod_env() {
  local file="$1"
  local value

  value="$(normalize_env_value "$(env_value "NEXUS_ENV" "$file" || true)")"
  [ "$value" = "prod" ] || die "NEXUS_ENV must be prod for Hetzner production sync"
}

require_local_database_url() {
  local file="$1"
  local db_name db_password db_user db_url_host db_url_name db_url_password db_url_port db_url_scheme db_url_user parsed value

  db_user="$(normalize_env_value "$(env_value "POSTGRES_USER" "$file" || true)")"
  db_password="$(normalize_env_value "$(env_value "POSTGRES_PASSWORD" "$file" || true)")"
  db_name="$(normalize_env_value "$(env_value "POSTGRES_DB" "$file" || true)")"
  value="$(normalize_env_value "$(env_value "DATABASE_URL" "$file" || true)")"

  parsed="$(
    DATABASE_URL="$value" python3 - <<'PY'
import os
import sys
from urllib.parse import unquote, urlparse

url = os.environ["DATABASE_URL"]
parsed = urlparse(url)
try:
    port = str(parsed.port or "")
except ValueError:
    sys.exit(1)

values = [
    parsed.scheme,
    unquote(parsed.username or ""),
    unquote(parsed.password or ""),
    parsed.hostname or "",
    port,
    unquote(parsed.path[1:] if parsed.path.startswith("/") else parsed.path),
]
if any("\t" in value or "\n" in value for value in values):
    sys.exit(1)
print("\t".join(values))
PY
  )" || die "DATABASE_URL must be a valid URL"

  IFS=$'\t' read -r db_url_scheme db_url_user db_url_password db_url_host db_url_port db_url_name <<<"$parsed"

  [ "$db_url_scheme" = "postgresql+psycopg" ] || die "DATABASE_URL must use the postgresql+psycopg scheme"
  [ "$db_url_user" = "$db_user" ] || die "DATABASE_URL user must match POSTGRES_USER"
  [ "$db_url_password" = "$db_password" ] || die "DATABASE_URL password must match POSTGRES_PASSWORD"
  [ "$db_url_host" = "postgres" ] || die "DATABASE_URL host must be postgres"
  [ "$db_url_port" = "5432" ] || die "DATABASE_URL port must be 5432"
  [ "$db_url_name" = "$db_name" ] || die "DATABASE_URL database name must match POSTGRES_DB"
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

reject_legacy_runtime_keys() {
  local file="$1"
  local key value

  for key in R2_ENDPOINT_URL CSP_EXTRA_CONNECT_ORIGINS SUPABASE_DATABASE_URL SUPABASE_AUTH_ADMIN_KEY SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY SERVICE_ROLE_KEY STORAGE_PROVIDER STORAGE_BUCKET AUTH_ALLOWED_REDIRECT_ORIGINS AUTH_TRUSTED_PROXY_ORIGINS SERVER_ACTION_ALLOWED_ORIGINS NEXUS_EXTENSION_REDIRECT_ORIGINS NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY FASTAPI_BASE_URL; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} must not be present in production runtime env after the R2/Hetzner Postgres cutover"
    fi
  done
}

reject_removed_x_env_keys() {
  local file="$1"
  local value

  if value="$(env_value "X_API_INCLUDE_USER_EXPANSIONS" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
    die "X_API_INCLUDE_USER_EXPANSIONS was removed; X ingest always requests provider author expansions"
  fi
}

reject_removed_llm_env_keys() {
  local file="$1"
  local key value

  if value="$(env_value "NEXUS_KEY_ENCRYPTION_KEY" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
    die "NEXUS_KEY_ENCRYPTION_KEY was removed by the LLM provider-runtime cutover; BYOK API-key encryption no longer exists, so this key can never be set"
  fi

  for key in CLOUDFLARE_AI_API_TOKEN CLOUDFLARE_AI_ACCOUNT_ID; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} was removed by the LLM provider-runtime cutover; Cloudflare is no longer an LLM provider"
    fi
  done
}

reject_removed_podcast_env_keys() {
  local file="$1"
  local key

  for key in PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS PODCAST_ACTIVE_POLL_LIMIT PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS PODCAST_SYNC_RUNNING_LEASE_SECONDS; do
    if env_value "$key" "$file" >/dev/null; then
      die "${key} was removed by the Podcast freshness hard cut"
    fi
  done
}

require_worker_defaults() {
  local file="$1"
  local key value

  for key in WORKER_LANE WORKER_ALLOWED_JOB_KINDS NEXUS_ALLOW_WORKER_MAINTENANCE; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} is invocation-owned and must not be stored in production runtime env"
    fi
  done

  for key in SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS; do
    value="$(normalize_env_value "$(env_value "$key" "$file" || true)")"
    [ "$value" = "0" ] || die "${key} must be 0 in the normal production worker env"
  done

  for key in PODCAST_REFRESH_DUE_SCHEDULE_SECONDS PODCAST_REFRESH_DUE_LIMIT; do
    value="$(normalize_env_value "$(env_value "$key" "$file" || true)")"
    case "$value" in
      ""|0|*[!0-9]*) die "${key} must be a canonical positive integer" ;;
      0*) die "${key} must be a canonical positive integer" ;;
    esac
  done

  value="$(normalize_env_value "$(env_value "INGEST_RECONCILE_SCHEDULE_SECONDS" "$file" || true)")"
  [ "$value" = "600" ] || die "INGEST_RECONCILE_SCHEDULE_SECONDS must be 600"
}

[ "$#" = 1 ] || die "usage: deploy/hetzner/sync-env.sh <never-published-source-sha>"
SOURCE_SHA="$1"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex characters"

for command in git scp ssh timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed locally"
done

[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "config publication requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "config publication SHA must equal checked-out HEAD"
timeout --foreground 2m git -C "$ROOT_DIR" fetch --quiet origin main
[ "$(git -C "$ROOT_DIR" rev-parse origin/main)" = "$SOURCE_SHA" ] || \
  die "config publication SHA must equal origin/main"

for file in "$SHARED_ENV" "$BACKEND_ENV" "$WORKER_ENV"; do
  [ -f "$file" ] || die "missing env file: $file"
done

tmp_file="$(mktemp)"
remote_directory=""

cleanup() {
  rm -f -- "$tmp_file"
  if [[ "$remote_directory" =~ ^/tmp/nexus-config\.[A-Za-z0-9]{8}$ ]]; then
    timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
      rm -r -- "$remote_directory" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

{
  echo "# Generated by deploy/hetzner/sync-env.sh"
  echo "# Source files:"
  echo "# - ${SHARED_ENV#"$ROOT_DIR"/}"
  echo "# - ${BACKEND_ENV#"$ROOT_DIR"/}"
  echo "# - ${WORKER_ENV#"$ROOT_DIR"/}"
  echo
  cat "$SHARED_ENV"
  echo
  cat "$BACKEND_ENV"
  echo
  cat "$WORKER_ENV"
} >"$tmp_file"

if grep -Ev '^[[:space:]]*#' "$tmp_file" | grep -Eq '[<>]|example\.com|=changeme$|=CHANGEME$'; then
  die "env files still contain placeholder values"
fi

require_duplicate_free_env "$tmp_file"
require_non_empty_keys "$tmp_file"
require_prod_env "$tmp_file"
require_local_database_url "$tmp_file"
require_cloudflare_r2_s3_api_origin "$tmp_file"
require_digest_image POSTGRES_IMAGE "$tmp_file"
require_digest_image CADDY_IMAGE "$tmp_file"
reject_legacy_runtime_keys "$tmp_file"
reject_removed_x_env_keys "$tmp_file"
reject_removed_llm_env_keys "$tmp_file"
reject_removed_podcast_env_keys "$tmp_file"
require_worker_defaults "$tmp_file"

remote_directory="$(
  timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    mktemp -d /tmp/nexus-config.XXXXXXXX
)"
[[ "$remote_directory" =~ ^/tmp/nexus-config\.[A-Za-z0-9]{8}$ ]] || \
  die "host returned an invalid config transfer path"
timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  mkdir -p -- "${remote_directory}/python/nexus"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "$tmp_file" "${SSH_TARGET}:${remote_directory}/source.env"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "${ROOT_DIR}/deploy/hetzner/release.py" \
  "${SSH_TARGET}:${remote_directory}/release.py"
timeout --foreground 2m scp "${SSH_OPTIONS[@]}" \
  "${ROOT_DIR}/python/nexus/__init__.py" \
  "${ROOT_DIR}/python/nexus/release_artifact.py" \
  "${SSH_TARGET}:${remote_directory}/python/nexus/"

result="$(
  timeout --foreground 3m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 2m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${remote_directory}/python" \
    python3 -B "${remote_directory}/release.py" publish-config \
      --source "${remote_directory}/source.env" \
      --next-source-sha "$SOURCE_SHA"
)"

printf '%s\n' "$result"
