#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HOST="${NEXUS_HOST:-}"
DEPLOY_USER="${NEXUS_DEPLOY_USER:-nexus}"
ENV_TARGET="${NEXUS_REMOTE_ENV_FILE:-${NEXUS_ENV_FILE:-/etc/nexus/nexus.env}}"
ENV_TARGET_DIR="$(dirname "$ENV_TARGET")"
SSH_TARGET="${NEXUS_SSH_TARGET:-${DEPLOY_USER}@${HOST}}"

SHARED_ENV="${NEXUS_SHARED_ENV:-${ROOT_DIR}/deploy/env/env-prod}"
BACKEND_ENV="${NEXUS_BACKEND_ENV:-${ROOT_DIR}/deploy/env/env-prod-backend}"
WORKER_ENV="${NEXUS_WORKER_ENV:-${ROOT_DIR}/deploy/env/env-prod-worker}"
SAFE_WORKER_ALLOWED_JOB_KINDS="ingest_web_article,ingest_epub,ingest_pdf,ingest_youtube_video,enrich_metadata,chat_run,library_intelligence_build_job,podcast_sync_subscription_job,podcast_transcribe_episode_job,podcast_reindex_semantic_job,backfill_default_library_closure_job,oracle_reading_generate"

REQUIRED_HETZNER_ENV_KEYS="
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
CADDY_SITE
CADDY_ACME_EMAIL
DATABASE_URL
POSTGRES_USER
POSTGRES_DB
POSTGRES_PASSWORD
R2_ENDPOINT_URL
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
NEXUS_KEY_ENCRYPTION_KEY
STREAM_TOKEN_SIGNING_KEY
STREAM_BASE_URL
BILLING_ENABLED
PODCASTS_ENABLED
YOUTUBE_DATA_API_KEY
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

require_cloudflare_r2_endpoint() {
  local file="$1"
  local value

  value="$(normalize_env_value "$(env_value "R2_ENDPOINT_URL" "$file" || true)")"
  R2_ENDPOINT_URL="$value" python3 - <<'PY' || die "R2_ENDPOINT_URL must be the Cloudflare R2 S3 API endpoint"
import os
import sys
from urllib.parse import urlparse

endpoint = os.environ["R2_ENDPOINT_URL"]
parsed = urlparse(endpoint)
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

  for key in SUPABASE_DATABASE_URL SUPABASE_AUTH_ADMIN_KEY SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY SERVICE_ROLE_KEY STORAGE_PROVIDER STORAGE_BUCKET; do
    if value="$(env_value "$key" "$file")" && ! is_blank "$(normalize_env_value "$value")"; then
      die "${key} must not be present in production runtime env after the R2/Hetzner Postgres cutover"
    fi
  done
}

require_safe_worker_defaults() {
  local file="$1"
  local key value

  if is_true "${NEXUS_ALLOW_WORKER_MAINTENANCE:-false}"; then
    return
  fi

  value="$(normalize_env_value "$(env_value "WORKER_ALLOWED_JOB_KINDS" "$file" || true)")"
  [ "$value" = "$SAFE_WORKER_ALLOWED_JOB_KINDS" ] || die "WORKER_ALLOWED_JOB_KINDS is not the safe production allowlist; set NEXUS_ALLOW_WORKER_MAINTENANCE=1 for a bounded maintenance sync"

  for key in PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS INGEST_RECONCILE_SCHEDULE_SECONDS SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS; do
    value="$(normalize_env_value "$(env_value "$key" "$file" || true)")"
    [ "$value" = "0" ] || die "${key} must be 0 for safe worker sync; set NEXUS_ALLOW_WORKER_MAINTENANCE=1 for a bounded maintenance sync"
  done
}

[ -n "$HOST" ] || [ -n "${NEXUS_SSH_TARGET:-}" ] || die "set NEXUS_HOST or NEXUS_SSH_TARGET"
case "$ENV_TARGET" in
  /*) ;;
  *) die "NEXUS_REMOTE_ENV_FILE must be an absolute path" ;;
esac
command -v ssh >/dev/null 2>&1 || die "ssh is not installed locally"
command -v scp >/dev/null 2>&1 || die "scp is not installed locally"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed locally"

for file in "$SHARED_ENV" "$BACKEND_ENV" "$WORKER_ENV"; do
  [ -f "$file" ] || die "missing env file: $file"
done

tmp_file="$(mktemp)"
remote_tmp="/tmp/nexus.env.$$"
trap 'rm -f "$tmp_file"' EXIT

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

require_non_empty_keys "$tmp_file"
require_prod_env "$tmp_file"
require_local_database_url "$tmp_file"
require_cloudflare_r2_endpoint "$tmp_file"
reject_legacy_runtime_keys "$tmp_file"
require_safe_worker_defaults "$tmp_file"

scp "$tmp_file" "${SSH_TARGET}:${remote_tmp}"
# shellcheck disable=SC2029
ssh "$SSH_TARGET" "trap 'rm -f \"${remote_tmp}\"' EXIT; sudo install -d -o root -g ${DEPLOY_USER} -m 0750 '${ENV_TARGET_DIR}' && sudo install -o root -g ${DEPLOY_USER} -m 0640 '${remote_tmp}' '${ENV_TARGET}'"

echo "uploaded ${ENV_TARGET}"
