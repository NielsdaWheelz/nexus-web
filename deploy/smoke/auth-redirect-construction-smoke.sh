#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE=""
APP_URL="${NEXUS_SMOKE_APP_URL:-}"
API_URL="${NEXUS_SMOKE_API_URL:-}"
SUPABASE_URL="${NEXUS_SMOKE_SUPABASE_URL:-}"
MAILBOX_URL="${NEXUS_SMOKE_MAILBOX_URL:-}"
EMAIL_DOMAIN="${NEXUS_SMOKE_EMAIL_DOMAIN:-}"
PROJECT_REF=""
ENV_FILES=()

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy/smoke/auth-redirect-construction-smoke.sh --mode <staging|prod-readonly> \
       [--env-file deploy/env/env-prod] [--frontend-env-file deploy/env/env-prod-frontend] \
       [--project-ref <supabase-project-ref>]

Explicit deployed auth-origin smoke. `prod-readonly` verifies hosted Supabase
Auth redirect config, checks the smoke URLs match the same env contract, then
runs the safe auth HTTP smoke. It does not mutate production users. `staging`
runs the same read-only gates, then drives the deployed app with Playwright,
submits the real email-change flow, reads a controlled mailbox, and asserts the
confirmation link targets the app `/auth/callback`.

Production canary mutation is intentionally not implicit. Add isolated
production canary accounts and reversible mailbox automation before enabling
prod-canary mutation.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      [ $# -ge 2 ] || die "--mode requires staging, prod-readonly, or prod-canary"
      MODE="$2"
      shift 2
      ;;
    --app-url)
      [ $# -ge 2 ] || die "--app-url requires a URL"
      APP_URL="$2"
      shift 2
      ;;
    --api-url)
      [ $# -ge 2 ] || die "--api-url requires a URL"
      API_URL="$2"
      shift 2
      ;;
    --supabase-url)
      [ $# -ge 2 ] || die "--supabase-url requires a URL"
      SUPABASE_URL="$2"
      shift 2
      ;;
    --mailbox-url)
      [ $# -ge 2 ] || die "--mailbox-url requires a URL"
      MAILBOX_URL="$2"
      shift 2
      ;;
    --email-domain)
      [ $# -ge 2 ] || die "--email-domain requires a domain"
      EMAIL_DOMAIN="$2"
      shift 2
      ;;
    --env-file|--frontend-env-file)
      [ $# -ge 2 ] || die "$1 requires a path"
      ENV_FILES+=("$2")
      shift 2
      ;;
    --project-ref)
      [ $# -ge 2 ] || die "--project-ref requires a value"
      PROJECT_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$MODE" ] || die "set --mode explicitly"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"

if [ "${#ENV_FILES[@]}" -eq 0 ]; then
  ENV_FILES=("${ROOT_DIR}/deploy/env/env-prod" "${ROOT_DIR}/deploy/env/env-prod-frontend")
fi

for file in "${ENV_FILES[@]}"; do
  [ -f "$file" ] || die "missing env file: $file"
done

verify_args=()
for file in "${ENV_FILES[@]}"; do
  verify_args+=(--env-file "$file")
done
[ -z "$PROJECT_REF" ] || verify_args+=(--project-ref "$PROJECT_REF")

require_smoke_urls_match_env() {
  APP_URL="$APP_URL" API_URL="$API_URL" SUPABASE_URL="$SUPABASE_URL" python3 - "${ENV_FILES[@]}" <<'PY'
import os
import sys
from urllib.parse import urlparse

env: dict[str, str] = {}
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)

def origin(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        fail("smoke URLs must be absolute HTTP(S) URLs")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"

checks = [
    ("--app-url", os.environ["APP_URL"], "APP_PUBLIC_URL"),
    ("--api-url", os.environ["API_URL"], "FASTAPI_BASE_URL"),
    ("--supabase-url", os.environ["SUPABASE_URL"], "NEXT_PUBLIC_SUPABASE_URL"),
]
for arg_name, actual_value, env_name in checks:
    expected_value = env.get(env_name, "").strip()
    if not expected_value:
        fail(f"{env_name} is required for redirect-construction smoke")
    if origin(actual_value) != origin(expected_value):
        fail(f"{arg_name} must match {env_name} from the verified env files")
PY
}

case "$MODE" in
  staging)
    [ -n "$APP_URL" ] || die "set --app-url or NEXUS_SMOKE_APP_URL"
    [ -n "$API_URL" ] || die "set --api-url or NEXUS_SMOKE_API_URL"
    [ -n "$SUPABASE_URL" ] || die "set --supabase-url or NEXUS_SMOKE_SUPABASE_URL"
    [ -n "$MAILBOX_URL" ] || die "set --mailbox-url or NEXUS_SMOKE_MAILBOX_URL"
    [ -n "$EMAIL_DOMAIN" ] || die "set --email-domain or NEXUS_SMOKE_EMAIL_DOMAIN"
    "${ROOT_DIR}/deploy/supabase/verify-auth-redirects.sh" "${verify_args[@]}"
    require_smoke_urls_match_env
    "${ROOT_DIR}/deploy/smoke/auth-smoke.sh" \
      --app-url "$APP_URL" \
      --api-url "$API_URL" \
      --supabase-url "$SUPABASE_URL"
    (
      cd "${ROOT_DIR}/e2e"
      NEXUS_SMOKE_APP_URL="$APP_URL" \
        E2E_MAILBOX_URL="$MAILBOX_URL" \
        NEXUS_SMOKE_EMAIL_DOMAIN="$EMAIL_DOMAIN" \
        bunx playwright test --config playwright.deployed.config.ts
    )
    echo "PASS staging redirect-construction smoke passed"
    ;;
  prod-readonly)
    [ -n "$APP_URL" ] || die "set --app-url or NEXUS_SMOKE_APP_URL"
    [ -n "$API_URL" ] || die "set --api-url or NEXUS_SMOKE_API_URL"
    [ -n "$SUPABASE_URL" ] || die "set --supabase-url or NEXUS_SMOKE_SUPABASE_URL"
    "${ROOT_DIR}/deploy/supabase/verify-auth-redirects.sh" "${verify_args[@]}"
    require_smoke_urls_match_env
    "${ROOT_DIR}/deploy/smoke/auth-smoke.sh" \
      --app-url "$APP_URL" \
      --api-url "$API_URL" \
      --supabase-url "$SUPABASE_URL"
    echo "PASS production read-only auth-origin/provider smoke passed"
    ;;
  prod-canary)
    die "prod-canary requires isolated production canary accounts and reversible mailbox automation; use prod-readonly until that infrastructure exists"
    ;;
  *)
    die "unknown mode: ${MODE}"
    ;;
esac
