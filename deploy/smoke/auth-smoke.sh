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

Post-release auth smoke check. Exits nonzero on the
first failed check. It makes bounded read-only checks plus the one explicit
session-resolver POST and never logs cookie or token values.

Checks:
  - Anonymous default protected page redirects 307 to /login without next.
  - Anonymous non-default protected page redirects 307 to /login with preserved next.
  - A future-expiry invalid auth cookie enters the canonical recovery surface
    once, then terminally clears through POST /auth/session/resolve.
  - Closed-membership public pages return 200.
  - Google and GitHub OAuth initiation target the exact Supabase authorize
    endpoint and app callback.
  - Anonymous and terminal-cookie BFF routes return JSON 401 E_UNAUTHENTICATED.
  - Every session-dependent response is private no-store. Rendered App Router
    pages carry Next's framework RSC Vary set; route handlers carry Vary: Cookie.
  - /docs is not reachable in production.
  - The API readiness endpoint returns 200.

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
SUPABASE_PROJECT_REF="$(python3 - "$SUPABASE_URL" <<'PY'
import sys
from urllib.parse import urlparse

host = urlparse(sys.argv[1]).hostname or ""
project_ref = host.removesuffix(".supabase.co")
if not project_ref or "." in project_ref or "/" in project_ref:
    raise SystemExit(1)
print(project_ref)
PY
)" || die "--supabase-url must be a Supabase project origin"
AUTH_COOKIE_PREFIX="sb-${SUPABASE_PROJECT_REF}-auth-token"

# A protected page that exists in apps/web/src/app/(authenticated).
PROTECTED_PATH="/browse"
DEFAULT_PROTECTED_PATH="/lectern"
# Routes that must stay reachable without an auth cookie.
PUBLIC_PATHS="/login /forgot-password /auth/invite /auth/recovery /terms /privacy /android"
# A BFF route under /api/* that the middleware passes through to the proxy.
BFF_PATH="/api/me"
# Per-request budget. The incident was a 25s Edge timeout; a healthy redirect
# decision is local and well under this.
REQUEST_TIMEOUT_SECONDS=15

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

failed=0

fail() {
  echo "FAIL $*"
  failed=1
}

pass() {
  echo "PASS $*"
}

# A future-expiry cookie with an invalid access token exercises the exact
# active-shaped corruption path without exposing a real credential.
build_invalid_cookie() {
  python3 - "$SUPABASE_PROJECT_REF" <<'PY'
import base64
import json
import sys

session = {
    "access_token": "smoke.invalid.token",
    "token_type": "bearer",
    "expires_at": 4102444800,
    "refresh_token": "smoke-invalid-refresh-token",
}
payload = base64.urlsafe_b64encode(json.dumps(session).encode()).decode().rstrip("=")
print(f"sb-{sys.argv[1]}-auth-token=base64-{payload}")
PY
}

# Build the wrong-project cookie at runtime so the smoke script contains no
# encoded credential-shaped fixture for secret scanners to mistake for a key.
build_stale_project_cookie() {
  python3 - <<'PY'
import base64
import json

payload = base64.urlsafe_b64encode(
    json.dumps({"access_token": "stale"}, separators=(",", ":")).encode()
).decode().rstrip("=")
print(f"sb-stale-project-auth-token=base64-{payload}")
PY
}

assert_session_cache_headers() {
  local label="$1"
  local headers="$2"
  local vary_contract="${3:-cookie}"
  if ! VARY_CONTRACT="$vary_contract" python3 - "$headers" <<'PY'
import os
import sys

headers: dict[str, list[str]] = {}
for line in open(sys.argv[1], encoding="iso-8859-1"):
    if ":" not in line:
        continue
    key, value = line.split(":", 1)
    headers.setdefault(key.lower(), []).append(value.strip())

directives: dict[str, str | None] = {}
for value in headers.get("cache-control", []):
    for raw_directive in value.split(","):
        name, separator, argument = raw_directive.strip().partition("=")
        if not name:
            raise SystemExit(1)
        directives[name.lower()] = argument.strip().strip('"') if separator else None

valid_cache = (
    {"private", "no-store"}.issubset(directives)
    and "public" not in directives
    and "s-maxage" not in directives
)
if "max-age" in directives:
    try:
        valid_cache = valid_cache and int(directives["max-age"] or "") <= 0
    except ValueError:
        valid_cache = False

vary = {
    token.strip().lower()
    for token in ",".join(headers.get("vary", [])).split(",")
    if token.strip()
}
if os.environ["VARY_CONTRACT"] == "cookie":
    valid_vary = "cookie" in vary
elif os.environ["VARY_CONTRACT"] == "rendered-page":
    valid_vary = {
        "rsc",
        "next-router-state-tree",
        "next-router-prefetch",
        "next-router-segment-prefetch",
    }.issubset(vary)
else:
    raise SystemExit(1)

valid = (
    valid_cache
    and headers.get("pragma") == ["no-cache"]
    and headers.get("expires") == ["0"]
    and valid_vary
)
raise SystemExit(0 if valid else 1)
PY
  then
    fail "${label}: session response is missing canonical private no-store headers"
    return
  fi
  pass "${label}: canonical private no-store headers"
}

request_with_capture() {
  local method="$1"
  local url="$2"
  local cookie="${3:-}"
  local headers="$4"
  local body="$5"
  local status
  local -a arguments=(
    -sS
    -o "$body"
    -D "$headers"
    -w '%{http_code}'
    --max-time "$REQUEST_TIMEOUT_SECONDS"
    -X "$method"
  )
  if [ -n "$cookie" ]; then
    arguments+=(-H "Cookie: ${cookie}")
  fi
  if [ "$method" = "POST" ]; then
    arguments+=(-H "Origin: ${APP_URL}" -H 'X-Nexus-Session: Resolve')
  fi
  status="$(curl "${arguments[@]}" "$url")"
  printf '%s' "$status"
}

header_value() {
  local headers="$1"
  local name="$2"
  python3 - "$headers" "$name" <<'PY'
import sys

name = sys.argv[2].lower()
for line in open(sys.argv[1], encoding="iso-8859-1"):
    if ":" not in line:
        continue
    key, value = line.split(":", 1)
    if key.lower() == name:
        print(value.strip())
        break
PY
}

assert_exact_recovery_redirect() {
  local label="$1"
  local status="$2"
  local location="$3"
  local expected_next="$4"
  if [ "$status" != "307" ] || ! LOCATION="$location" EXPECTED_NEXT="$expected_next" APP_URL="$APP_URL" python3 - <<'PY'
import os
from urllib.parse import parse_qs, urlparse

parsed = urlparse(os.environ["LOCATION"])
app = urlparse(os.environ["APP_URL"])
same_origin = (
    (parsed.scheme == app.scheme and parsed.netloc == app.netloc)
    or (parsed.scheme == "" and parsed.netloc == "")
)
valid = (
    same_origin
    and parsed.path == "/auth/session/recover"
    and parse_qs(parsed.query) == {"next": [os.environ["EXPECTED_NEXT"]]}
)
raise SystemExit(0 if valid else 1)
PY
  then
    fail "${label}: expected exact /auth/session/recover location (${location})"
    return
  fi
  pass "$label"
}

resolve_app_location() {
  local location="$1"
  APP_URL="$APP_URL" LOCATION="$location" python3 - <<'PY'
import os
from urllib.parse import urlparse

app = urlparse(os.environ["APP_URL"])
location = urlparse(os.environ["LOCATION"])
if location.scheme in {"http", "https"} and location.netloc:
    if (location.scheme, location.netloc) != (app.scheme, app.netloc):
        raise SystemExit("redirect left the application origin")
    print(os.environ["LOCATION"])
elif location.path.startswith("/"):
    print(f"{app.scheme}://{app.netloc}{location.path}"
          + (f"?{location.query}" if location.query else ""))
else:
    raise SystemExit("redirect location is not an absolute or root-relative URL")
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
    curl -sS -o /dev/null -w '%{http_code}\t%{redirect_url}\n' \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -H "Cookie: ${cookie}" \
      "$url"
  else
    curl -sS -o /dev/null -w '%{http_code}\t%{redirect_url}\n' \
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

# Assert the redirect lands on /login without a redundant default `next`.
assert_login_redirect_without_next() {
  local label="$1"
  local status="$2"
  local location="$3"

  if [ "$status" != "307" ]; then
    fail "${label}: expected 307, got ${status}"
    return
  fi
  if ! printf '%s' "$location" \
    | python3 -c 'import sys, urllib.parse as u; parsed = u.urlparse(sys.stdin.read()); q = u.parse_qs(parsed.query); sys.exit(0 if parsed.path == "/login" and "next" not in q else 1)'; then
    fail "${label}: redirect target is not /login without next (${location})"
    return
  fi
  pass "$label"
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

assert_oauth_start() {
  local provider="$1"
  local status="$2"
  local location="$3"

  if [ "$status" != "307" ]; then
    fail "${provider} OAuth start: expected 307, got ${status}"
    return
  fi
  if ! LOCATION="$location" PROVIDER="$provider" APP_URL="$APP_URL" SUPABASE_URL="$SUPABASE_URL" \
    python3 - <<'PY'
import os
import sys
from urllib.parse import parse_qs, urlparse

location = urlparse(os.environ["LOCATION"])
supabase = urlparse(os.environ["SUPABASE_URL"])
query = parse_qs(location.query)
redirect_to = urlparse(query.get("redirect_to", [""])[0])
app = urlparse(os.environ["APP_URL"])
valid = (
    location.scheme == supabase.scheme
    and location.netloc == supabase.netloc
    and location.path == "/auth/v1/authorize"
    and query.get("provider") == [os.environ["PROVIDER"]]
    and redirect_to.scheme == app.scheme
    and redirect_to.netloc == app.netloc
    and redirect_to.path == "/auth/callback"
)
sys.exit(0 if valid else 1)
PY
  then
    fail "${provider} OAuth start did not target the exact provider callback contract"
    return
  fi
  pass "${provider} OAuth start targets the exact provider callback contract"
}

echo "Auth production smoke check"
echo "  app: ${APP_URL}"
echo "  api: ${API_URL}"
echo

invalid_cookie="$(build_invalid_cookie)"

# Anonymous default protected page: prompt 307 to /login without default next.
IFS=$'\t' read -r status location < <(http_status_and_location "${APP_URL}${DEFAULT_PROTECTED_PATH}")
assert_login_redirect_without_next \
  "anonymous default protected page redirects to /login" \
  "$status" "$location"

# Anonymous non-default protected page: prompt 307 to /login with preserved next.
IFS=$'\t' read -r status location < <(http_status_and_location "${APP_URL}${PROTECTED_PATH}")
assert_login_redirect_with_next \
  "anonymous non-default protected page redirects to /login" \
  "$status" "$location" "$PROTECTED_PATH"

# A future-expiry invalid cookie must converge through one canonical recovery
# entry and one resolver POST. No generic redirect/401 can satisfy this proof.
invalid_page_headers="${temporary}/invalid-page.headers"
invalid_page_body="${temporary}/invalid-page.body"
status="$(request_with_capture GET "${APP_URL}${PROTECTED_PATH}" "$invalid_cookie" "$invalid_page_headers" "$invalid_page_body")"
location="$(header_value "$invalid_page_headers" Location)"
assert_exact_recovery_redirect "invalid cookie enters canonical recovery" "$status" "$location" "$PROTECTED_PATH"
assert_session_cache_headers "invalid-cookie protected page" "$invalid_page_headers" "rendered-page"

recovery_headers="${temporary}/recovery.headers"
recovery_body="${temporary}/recovery.body"
recovery_url="$(resolve_app_location "$location")"
status="$(request_with_capture GET "$recovery_url" "$invalid_cookie" "$recovery_headers" "$recovery_body")"
if [ "$status" != "200" ] || [ -n "$(header_value "$recovery_headers" Set-Cookie)" ]; then
  fail "recovery surface must be a non-mutating 200"
else
  pass "recovery surface is non-mutating"
fi
assert_session_cache_headers "recovery surface" "$recovery_headers" "rendered-page"

resolve_headers="${temporary}/resolve.headers"
resolve_body="${temporary}/resolve.body"
status="$(request_with_capture POST "${APP_URL}/auth/session/resolve" "$invalid_cookie" "$resolve_headers" "$resolve_body")"
if [ "$status" != "401" ] || [ -n "$(header_value "$resolve_headers" Location)" ]; then
  fail "invalid cookie resolver must terminally return 401 without redirect"
elif ! python3 - "$resolve_headers" "$AUTH_COOKIE_PREFIX" <<'PY'
import sys

prefix = "set-cookie: " + sys.argv[2].lower()
cookies = [
    line.lower()
    for line in open(sys.argv[1], encoding="iso-8859-1")
    if line.lower().startswith(prefix)
]
raise SystemExit(0 if cookies and all("max-age=0" in cookie for cookie in cookies) else 1)
PY
then
  fail "terminal resolver did not expire every emitted auth cookie"
else
  pass "invalid cookie resolves once and terminally clears cookies"
fi
assert_session_cache_headers "terminal resolver" "$resolve_headers"

# Public pages return 200.
for path in $PUBLIC_PATHS; do
  status="$(http_status "${APP_URL}${path}")"
  if [ "$status" = "200" ]; then
    pass "public page ${path} returns 200"
  else
    fail "public page ${path}: expected 200, got ${status}"
  fi
done

for provider in google github; do
  IFS=$'\t' read -r status location < <(
    http_status_and_location "${APP_URL}/auth/oauth?provider=${provider}"
  )
  assert_oauth_start "$provider" "$status" "$location"
done

# Anonymous BFF route returns JSON 401 E_UNAUTHENTICATED.
status="$(http_status "${APP_URL}${BFF_PATH}")"
body="$(http_body "${APP_URL}${BFF_PATH}")"
assert_bff_unauthenticated \
  "anonymous BFF route ${BFF_PATH} returns 401 E_UNAUTHENTICATED" \
  "$status" "$body"

# Terminal-cookie BFF route returns JSON 401 E_UNAUTHENTICATED and is private.
bff_headers="${temporary}/bff.headers"
bff_body="${temporary}/bff.body"
status="$(request_with_capture GET "${APP_URL}${BFF_PATH}" "$invalid_cookie" "$bff_headers" "$bff_body")"
body="$(<"$bff_body")"
assert_bff_unauthenticated \
  "terminal-cookie BFF route ${BFF_PATH} returns 401 E_UNAUTHENTICATED" \
  "$status" "$body"
assert_session_cache_headers "terminal-cookie BFF route" "$bff_headers"

# A stale cookie for another Supabase project is not a session and must neither
# enter recovery nor mutate the current project's cookies.
stale_cookie="$(build_stale_project_cookie)"
stale_headers="${temporary}/stale.headers"
stale_body="${temporary}/stale.body"
status="$(request_with_capture GET "${APP_URL}${PROTECTED_PATH}" "$stale_cookie" "$stale_headers" "$stale_body")"
location="$(header_value "$stale_headers" Location)"
assert_login_redirect_with_next "stale project cookie is rejected as anonymous" "$status" "$location" "$PROTECTED_PATH"
if [ -n "$(header_value "$stale_headers" Set-Cookie)" ]; then
  fail "stale project cookie must not mutate current-project auth cookies"
else
  pass "stale project cookie does not mutate current-project auth cookies"
fi

# /docs is not reachable in production.
status="$(http_status "${API_URL}/docs")"
if [ "$status" = "404" ]; then
  pass "/docs is not reachable in production (404)"
else
  fail "/docs is reachable in production (${status})"
fi

# The API readiness endpoint returns 200.
status="$(http_status "${API_URL}/readyz")"
if [ "$status" = "200" ]; then
  pass "API readiness endpoint returns 200"
else
  fail "API readiness endpoint: expected 200, got ${status}"
fi

echo
if [ "$failed" = "0" ]; then
  echo "PASS auth production smoke check passed"
  exit 0
fi
echo "FAIL auth production smoke check failed"
exit 1
