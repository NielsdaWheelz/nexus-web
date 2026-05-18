#!/usr/bin/env bash
set -euo pipefail

APP_URL="${NEXUS_SMOKE_APP_URL:-}"
API_URL="${NEXUS_SMOKE_API_URL:-}"
SUPABASE_URL="${NEXUS_SMOKE_SUPABASE_URL:-}"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy/smoke/auth-smoke.sh --app-url <url> --api-url <url> \
         --supabase-url <url>

Post-deploy auth smoke check for the production cutover. Exits nonzero on the
first failed check. It makes only safe GET requests and never logs cookie or
token values.

Checks:
  - Anonymous protected page redirects 307 to /login with a preserved next.
  - A valid-shaped expired auth cookie on a protected page prompts a redirect
    with no timeout (the MIDDLEWARE_INVOCATION_TIMEOUT incident reproduction).
  - Public pages return 200.
  - Anonymous and expired-cookie BFF routes return JSON 401 E_UNAUTHENTICATED.
  - /docs is not reachable in production.
  - The API health endpoint returns 200.

Required (flag or env):
  --app-url        NEXUS_SMOKE_APP_URL        Production frontend/BFF base URL
  --api-url        NEXUS_SMOKE_API_URL        Production FastAPI base URL
  --supabase-url   NEXUS_SMOKE_SUPABASE_URL   Production Supabase project URL,
                                              the deployed NEXT_PUBLIC_SUPABASE_URL.
                                              Its project ref names the auth
                                              cookie the boundary parser reads,
                                              so the crafted expired cookie is
                                              one the deployed app interprets.

Local tools:
  curl and python3 are required.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$APP_URL" ] || die "set --app-url or NEXUS_SMOKE_APP_URL"
[ -n "$API_URL" ] || die "set --api-url or NEXUS_SMOKE_API_URL"
[ -n "$SUPABASE_URL" ] || die "set --supabase-url or NEXUS_SMOKE_SUPABASE_URL"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"

APP_URL="${APP_URL%/}"
API_URL="${API_URL%/}"

# A protected page that exists in apps/web/src/app/(authenticated).
PROTECTED_PATH="/browse"
# Routes that must stay reachable without an auth cookie.
PUBLIC_PATHS="/login /terms /privacy /android"
# A BFF route under /api/* that the middleware passes through to the proxy.
BFF_PATH="/api/me"
# Per-request budget. The incident was a 25s Edge timeout; a healthy redirect
# decision is local and well under this.
REQUEST_TIMEOUT_SECONDS=15

failed=0

fail() {
  echo "FAIL $*"
  failed=1
}

pass() {
  echo "PASS $*"
}

# A valid-shaped Supabase SSR auth cookie whose access token is long expired.
# The cookie name is derived from the production Supabase project ref so the
# deployed boundary parser actually interprets it; it carries a refresh_token
# so the parser classifies it `refreshable` — the worst-case path that drove
# the original MIDDLEWARE_INVOCATION_TIMEOUT.
build_expired_cookie() {
  python3 - "$SUPABASE_URL" <<'PY'
import base64
import json
import sys
from urllib.parse import urlparse

host = urlparse(sys.argv[1]).hostname or ""
project_ref = host.split(".")[0]
if not project_ref:
    sys.stderr.write("error: --supabase-url has no project ref host\n")
    sys.exit(1)
session = {
    "access_token": "smoke.expired.token",
    "token_type": "bearer",
    "expires_at": 1000000000,  # 2001 — far in the past
    "refresh_token": "smoke-expired-refresh-token",
}
payload = base64.urlsafe_b64encode(json.dumps(session).encode()).decode().rstrip("=")
print(f"sb-{project_ref}-auth-token=base64-{payload}")
PY
}

# Print the HTTP status of an unauthenticated GET, not following redirects.
http_status() {
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time "$REQUEST_TIMEOUT_SECONDS" \
    "$1"
}

# Print "<status>\t<location>" for a GET, not following redirects. Sends an
# optional Cookie header when a second argument is given.
http_status_and_location() {
  local url="$1"
  local cookie="${2:-}"
  if [ -n "$cookie" ]; then
    curl -sS -o /dev/null -w '%{http_code}\t%{redirect_url}' \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -H "Cookie: ${cookie}" \
      "$url"
  else
    curl -sS -o /dev/null -w '%{http_code}\t%{redirect_url}' \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      "$url"
  fi
}

# Print the response body of a GET. Sends an optional Cookie header when a
# second argument is given.
http_body() {
  local url="$1"
  local cookie="${2:-}"
  if [ -n "$cookie" ]; then
    curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" -H "Cookie: ${cookie}" "$url"
  else
    curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" "$url"
  fi
}

# Assert the redirect lands on /login carrying the requested path as `next`.
assert_login_redirect_with_next() {
  local label="$1"
  local status="$2"
  local location="$3"
  local expected_next="$4"

  if [ "$status" != "307" ]; then
    fail "${label}: expected 307, got ${status}"
    return
  fi
  case "$location" in
    */login\?*next=*) ;;
    *)
      fail "${label}: redirect target is not /login?next=... (${location})"
      return
      ;;
  esac
  if ! printf '%s' "$location" \
    | python3 -c 'import sys, urllib.parse as u; q = u.parse_qs(u.urlparse(sys.stdin.read()).query); sys.exit(0 if u.unquote(q.get("next", [""])[0]) == sys.argv[1] else 1)' \
    "$expected_next"; then
    fail "${label}: redirect did not preserve next=${expected_next} (${location})"
    return
  fi
  pass "$label"
}

# Assert the body is the BFF JSON envelope for an unauthenticated request.
assert_bff_unauthenticated() {
  local label="$1"
  local status="$2"
  local body="$3"

  if [ "$status" != "401" ]; then
    fail "${label}: expected 401, got ${status}"
    return
  fi
  if ! printf '%s' "$body" \
    | python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("error", {}).get("code") == "E_UNAUTHENTICATED" else 1)' \
    2>/dev/null; then
    fail "${label}: body is not JSON 401 E_UNAUTHENTICATED"
    return
  fi
  pass "$label"
}

echo "Auth production smoke check"
echo "  app: ${APP_URL}"
echo "  api: ${API_URL}"
echo

expired_cookie="$(build_expired_cookie)"

# Anonymous protected page: prompt 307 to /login with preserved next.
IFS=$'\t' read -r status location < <(http_status_and_location "${APP_URL}${PROTECTED_PATH}")
assert_login_redirect_with_next \
  "anonymous protected page redirects to /login" \
  "$status" "$location" "$PROTECTED_PATH"

# Valid-shaped expired cookie on a protected page: prompt redirect, no timeout.
# curl --max-time fails the request on a hang, so reaching a 3xx is the check.
IFS=$'\t' read -r status location < <(
  http_status_and_location "${APP_URL}${PROTECTED_PATH}" "$expired_cookie"
)
case "$status" in
  301|302|303|307|308)
    pass "expired-cookie protected page redirects without timeout (${status})"
    ;;
  *)
    fail "expired-cookie protected page did not redirect (${status})"
    ;;
esac

# Public pages return 200.
for path in $PUBLIC_PATHS; do
  status="$(http_status "${APP_URL}${path}")"
  if [ "$status" = "200" ]; then
    pass "public page ${path} returns 200"
  else
    fail "public page ${path}: expected 200, got ${status}"
  fi
done

# Anonymous BFF route returns JSON 401 E_UNAUTHENTICATED.
status="$(http_status "${APP_URL}${BFF_PATH}")"
body="$(http_body "${APP_URL}${BFF_PATH}")"
assert_bff_unauthenticated \
  "anonymous BFF route ${BFF_PATH} returns 401 E_UNAUTHENTICATED" \
  "$status" "$body"

# Expired-cookie BFF route returns JSON 401 E_UNAUTHENTICATED.
status="$(http_status_and_location "${APP_URL}${BFF_PATH}" "$expired_cookie" | cut -f1)"
body="$(http_body "${APP_URL}${BFF_PATH}" "$expired_cookie")"
assert_bff_unauthenticated \
  "expired-cookie BFF route ${BFF_PATH} returns 401 E_UNAUTHENTICATED" \
  "$status" "$body"

# /docs is not reachable in production.
status="$(http_status "${API_URL}/docs")"
if [ "$status" = "404" ]; then
  pass "/docs is not reachable in production (404)"
else
  fail "/docs is reachable in production (${status})"
fi

# The API health endpoint returns 200.
status="$(http_status "${API_URL}/health")"
if [ "$status" = "200" ]; then
  pass "API health endpoint returns 200"
else
  fail "API health endpoint: expected 200, got ${status}"
fi

echo
if [ "$failed" = "0" ]; then
  echo "PASS auth production smoke check passed"
  exit 0
fi
echo "FAIL auth production smoke check failed"
exit 1
