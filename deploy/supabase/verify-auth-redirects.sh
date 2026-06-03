#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILES=()
PROJECT_REF=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy/supabase/verify-auth-redirects.sh [--env-file <path> ...]
       [--frontend-env-file <path>] [--project-ref <ref>]

Read-only Supabase hosted Auth redirect verification. Requires
SUPABASE_MANAGEMENT_ACCESS_TOKEN in the operator/CI environment. The token is
never read from synced runtime env files.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
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

command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
[ -n "${SUPABASE_MANAGEMENT_ACCESS_TOKEN:-}" ] || die "set SUPABASE_MANAGEMENT_ACCESS_TOKEN in the operator environment"

if [ "${#ENV_FILES[@]}" -eq 0 ]; then
  ENV_FILES=("${ROOT_DIR}/deploy/env/env-prod" "${ROOT_DIR}/deploy/env/env-prod-frontend")
fi

for file in "${ENV_FILES[@]}"; do
  [ -f "$file" ] || die "missing env file: $file"
done

tmp_env="$(mktemp)"
tmp_config="$(mktemp)"
trap 'rm -f "$tmp_env" "$tmp_config"' EXIT

for file in "${ENV_FILES[@]}"; do
  cat "$file" >>"$tmp_env"
  echo >>"$tmp_env"
done

resolved_project_ref="$(
  PROJECT_REF="$PROJECT_REF" python3 - "$tmp_env" <<'PY'
import os
import sys
from urllib.parse import urlparse

env: dict[str, str] = {}
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        continue
    key, value = stripped.split("=", 1)
    env[key.strip()] = value.strip().strip("\"'")

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)

def require_origin(name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        fail(f"{name} is required")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        fail(f"{name} must be an HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"

app_origin = require_origin("APP_PUBLIC_URL")
supabase_origin = require_origin("NEXT_PUBLIC_SUPABASE_URL")
host = urlparse(supabase_origin).hostname or ""
derived_ref = host.removesuffix(".supabase.co")
project_ref = os.environ.get("PROJECT_REF") or derived_ref
if not project_ref or "." in project_ref or "/" in project_ref:
    fail("Supabase project ref could not be derived; pass --project-ref")
if host != f"{project_ref}.supabase.co":
    fail("NEXT_PUBLIC_SUPABASE_URL does not match the Supabase project ref")

issuer = env.get("SUPABASE_ISSUER", "").strip()
jwks = env.get("SUPABASE_JWKS_URL", "").strip()
audiences = {part.strip() for part in env.get("SUPABASE_AUDIENCES", "").split(",")}
if issuer != f"{supabase_origin}/auth/v1":
    fail("SUPABASE_ISSUER does not match NEXT_PUBLIC_SUPABASE_URL")
if jwks != f"{supabase_origin}/auth/v1/.well-known/jwks.json":
    fail("SUPABASE_JWKS_URL does not match NEXT_PUBLIC_SUPABASE_URL")
if "authenticated" not in audiences:
    fail("SUPABASE_AUDIENCES must include authenticated")

origins: list[str] = []
for raw in env.get("AUTH_ALLOWED_REDIRECT_ORIGINS", "").split(","):
    value = raw.strip()
    if not value:
        continue
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        fail("AUTH_ALLOWED_REDIRECT_ORIGINS must contain only HTTPS origins")
    origin = f"{parsed.scheme}://{parsed.netloc.lower()}"
    if origin not in origins:
        origins.append(origin)

if not origins:
    fail("AUTH_ALLOWED_REDIRECT_ORIGINS is required")
if app_origin not in origins:
    fail("APP_PUBLIC_URL must be included in AUTH_ALLOWED_REDIRECT_ORIGINS")

print(project_ref)
for expected in [app_origin, *origins]:
    print(expected)
PY
)"

project_ref="$(printf '%s\n' "$resolved_project_ref" | sed -n '1p')"
app_origin="$(printf '%s\n' "$resolved_project_ref" | sed -n '2p')"
expected_origins="$(printf '%s\n' "$resolved_project_ref" | sed '1d' | awk 'NF' | sort -u)"

curl -fsS \
  -H "Authorization: Bearer ${SUPABASE_MANAGEMENT_ACCESS_TOKEN}" \
  "https://api.supabase.com/v1/projects/${project_ref}/config/auth" \
  -o "$tmp_config" || die "could not read Supabase Auth config"

APP_ORIGIN="$app_origin" EXPECTED_ORIGINS="$expected_origins" python3 - "$tmp_config" <<'PY'
import json
import os
import sys
from urllib.parse import urlparse

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)

try:
    config = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    fail("Supabase Auth config response was not readable JSON")
site_url = str(config.get("site_url") or "").rstrip("/")
raw_allow_list = config.get("uri_allow_list")
if isinstance(raw_allow_list, str):
    redirect_urls = [item.strip() for item in raw_allow_list.split(",") if item.strip()]
elif isinstance(raw_allow_list, list):
    redirect_urls = [str(item).strip() for item in raw_allow_list if str(item).strip()]
else:
    fail("Supabase Auth config did not include uri_allow_list")

origins = [line for line in os.environ["EXPECTED_ORIGINS"].splitlines() if line]
app_origin = os.environ["APP_ORIGIN"]
if site_url != app_origin:
    fail("Supabase Auth site_url does not match APP_PUBLIC_URL")

configured = set(redirect_urls)
for origin in origins:
    callback = f"{origin}/auth/callback"
    if callback not in configured:
        fail("Supabase Auth redirect allowlist is missing a configured /auth/callback URL")

for redirect_url in redirect_urls:
    if "*" in redirect_url:
        fail("Supabase Auth production redirect allowlist must not contain wildcards")
    parsed = urlparse(redirect_url)
    if parsed.path == "/auth/callback" and parsed.scheme != "https":
        fail("Supabase Auth production callback redirects must use HTTPS")

print("PASS Supabase Auth redirect config matches the app origin contract")
PY
