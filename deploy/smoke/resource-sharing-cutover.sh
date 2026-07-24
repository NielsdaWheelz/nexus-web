#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="run"

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

case "${1:-}" in
  "") ;;
  --revoked) MODE="revoked" ;;
  --check) MODE="check" ;;
  -h|--help)
    cat <<'EOF'
Usage: deploy/smoke/resource-sharing-cutover.sh [--revoked|--check]

Required for a live smoke:
  APP_URL
  API_URL
  CUTOVER_SHA
  NEXUS_SMOKE_FIXTURE_FILE
  VERCEL_TOKEN
  VERCEL_PROJECT_ID

Optional:
  VERCEL_TEAM_ID
  NEXUS_RUN_WAF_SMOKE=1
  NEXUS_SSH_TARGET, NEXUS_DEPLOY_PATH, NEXUS_REMOTE_ENV_FILE
  NEXUS_CUTOVER_EVIDENCE_FILE
EOF
    exit 0
    ;;
  *) die "unknown argument: $1" ;;
esac

require_command bash
require_command cmp
require_command curl
require_command jq

"${ROOT_DIR}/deploy/vercel/sync-resource-sharing-firewall.sh" --check >/dev/null
if [ "$MODE" = "check" ]; then
  echo "resource-sharing cutover smoke is locally valid; no network requests were made"
  exit 0
fi

for variable in \
  APP_URL CUTOVER_SHA NEXUS_SMOKE_FIXTURE_FILE \
  VERCEL_TOKEN VERCEL_PROJECT_ID; do
  [ -n "${!variable:-}" ] || die "${variable} is required"
done
[ -f "$NEXUS_SMOKE_FIXTURE_FILE" ] || die "NEXUS_SMOKE_FIXTURE_FILE is missing"
jq -e '
  keys == [
    "created_by_user_id",
    "grant_handle",
    "resource_ref",
    "share_token",
    "version"
  ]
  and .version == 1
  and (.created_by_user_id | test("^[0-9a-f-]{36}$"))
  and (.resource_ref | test("^media:[0-9a-f-]{36}$"))
  and (.grant_handle | test("^nrg1[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]{22}$"))
  and (.share_token | test("^nxshr1_[A-Za-z0-9_-]{43}$"))
' "$NEXUS_SMOKE_FIXTURE_FILE" >/dev/null || die "smoke fixture violates its closed contract"
NEXUS_PUBLIC_SHARE_TOKEN="$(jq -er '.share_token' "$NEXUS_SMOKE_FIXTURE_FILE")"
case "$CUTOVER_SHA" in
  *[!0-9a-f]*|"") die "CUTOVER_SHA must be a lowercase Git commit SHA" ;;
esac
[ "${#CUTOVER_SHA}" = "40" ] || die "CUTOVER_SHA must be a full 40-character Git SHA"

APP_URL="${APP_URL%/}"
API_URL="${API_URL:-}"
[ "$MODE" = "revoked" ] || [ -n "$API_URL" ] || die "API_URL is required"
API_URL="${API_URL%/}"
tmp_dir="$(mktemp -d)"
smoke_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  rm -r -- "$tmp_dir"
}
trap cleanup EXIT

http_probe() {
  local name="$1"
  local url="$2"
  local token="${3:-}"
  local range="${4:-}"
  local args=(
    --silent
    --show-error
    --dump-header "${tmp_dir}/${name}.headers"
    --output "${tmp_dir}/${name}.body"
    --write-out "%{http_code}"
  )
  if [ -n "$token" ]; then
    args+=(--header "X-Nexus-Share-Token: ${token}")
  fi
  if [ -n "$range" ]; then
    args+=(--header "Range: ${range}")
  fi
  curl "${args[@]}" "$url"
}

header_value() {
  local name="$1"
  local file="$2"
  awk -v wanted="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
    {
      line = $0
      sub(/\r$/, "", line)
      split(line, parts, ":")
      key = tolower(parts[1])
      if (key == wanted) {
        value = substr(line, index(line, ":") + 1)
        sub(/^[[:space:]]+/, "", value)
      }
    }
    END { print value }
  ' "$file"
}

assert_status() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [ "$actual" = "$expected" ] || die "${label}: expected ${expected}, got ${actual}"
}

assert_public_headers() {
  local file="$1"
  [ "$(header_value cache-control "$file")" = "private, no-store" ] || \
    die "missing private no-store policy"
  [ "$(header_value referrer-policy "$file")" = "no-referrer" ] || \
    die "missing no-referrer policy"
  [ "$(header_value x-robots-tag "$file")" = "noindex, nofollow" ] || \
    die "missing noindex policy"
  [ "$(header_value x-content-type-options "$file")" = "nosniff" ] || \
    die "missing nosniff policy"
  [ -z "$(header_value set-cookie "$file")" ] || die "public response emitted Set-Cookie"
}

if [ "$MODE" = "revoked" ]; then
  status="$(
    http_probe revoked \
      "${APP_URL}/api/public/resource-share" \
      "$NEXUS_PUBLIC_SHARE_TOKEN"
  )"
  assert_status "$status" "404" "revoked public token"
  assert_public_headers "${tmp_dir}/revoked.headers"
  jq -e '
    .error.code == "E_NOT_FOUND"
    and .error.message == "Share unavailable"
  ' "${tmp_dir}/revoked.body" >/dev/null || die "revoked token was not masked"
  evidence='{"typed_fixture_revocation":"passed","revoked_public_token":"passed"}'
  if [ -n "${NEXUS_CUTOVER_EVIDENCE_FILE:-}" ]; then
    printf '%s\n' "$evidence" >"$NEXUS_CUTOVER_EVIDENCE_FILE"
  fi
  printf '%s\n' "$evidence"
  exit 0
fi

status="$(http_probe shell "${APP_URL}/s")"
assert_status "$status" "200" "public shell"
assert_public_headers "${tmp_dir}/shell.headers"
[ -n "$(header_value content-security-policy "${tmp_dir}/shell.headers")" ] || \
  die "public shell has no CSP"
[ "$(header_value cross-origin-opener-policy "${tmp_dir}/shell.headers")" = "same-origin" ] || \
  die "public shell has no same-origin opener policy"
[ "$(header_value cross-origin-resource-policy "${tmp_dir}/shell.headers")" = "same-origin" ] || \
  die "public shell has no same-origin resource policy"
if grep -Fq "$NEXUS_PUBLIC_SHARE_TOKEN" "${tmp_dir}/shell.body"; then
  die "public shell serialized the bearer token"
fi

invalid_token="nxshr1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
status="$(
  http_probe invalid \
    "${APP_URL}/api/public/resource-share/fragments?limit=not-an-integer" \
    "$invalid_token"
)"
assert_status "$status" "404" "invalid token precedence"
jq -e '
  .error.code == "E_NOT_FOUND"
  and .error.message == "Share unavailable"
' "${tmp_dir}/invalid.body" >/dev/null || die "invalid token did not use the masked envelope"

status="$(
  http_probe bootstrap \
    "${APP_URL}/api/public/resource-share" \
    "$NEXUS_PUBLIC_SHARE_TOKEN"
)"
assert_status "$status" "200" "public bootstrap"
assert_public_headers "${tmp_dir}/bootstrap.headers"
jq -e '
  .data.version == "V1"
  and (.data.subject.kind == "Media" or .data.subject.kind == "Highlight")
  and (.data.reader.kind | IN("Article", "Epub", "Pdf", "Transcript"))
' "${tmp_dir}/bootstrap.body" >/dev/null || die "public bootstrap violates the V1 contract"

ambient_status="$(
  curl --silent --show-error \
    --dump-header "${tmp_dir}/ambient.headers" \
    --output "${tmp_dir}/ambient.body" \
    --write-out "%{http_code}" \
    --header "X-Nexus-Share-Token: ${NEXUS_PUBLIC_SHARE_TOKEN}" \
    --header "Cookie: sb-access-token=bogus; nexus-private=bogus" \
    --header "Authorization: Bearer bogus" \
    --header "X-Nexus-Internal: bogus" \
    "${APP_URL}/api/public/resource-share"
)"
assert_status "$ambient_status" "200" "public bootstrap with bogus ambient authority"
assert_public_headers "${tmp_dir}/ambient.headers"
cmp --silent "${tmp_dir}/bootstrap.body" "${tmp_dir}/ambient.body" || \
  die "public projection changed when bogus ambient authority was supplied"

reader_kind="$(jq -er '.data.reader.kind' "${tmp_dir}/bootstrap.body")"
case "$reader_kind" in
  Article|Transcript)
    status="$(
      http_probe public-fragments \
        "${APP_URL}/api/public/resource-share/fragments?limit=1" \
        "$NEXUS_PUBLIC_SHARE_TOKEN"
    )"
    assert_status "$status" "200" "public fragment projection"
    jq -e '.data.items | length == 1' "${tmp_dir}/public-fragments.body" >/dev/null || \
      die "public fragment projection returned no first item"
    ;;
  Epub)
    status="$(
      http_probe public-navigation \
        "${APP_URL}/api/public/resource-share/navigation?limit=1" \
        "$NEXUS_PUBLIC_SHARE_TOKEN"
    )"
    assert_status "$status" "200" "public EPUB navigation"
    section_handle="$(
      jq -er '.data.items[0].section_handle' "${tmp_dir}/public-navigation.body"
    )"
    status="$(
      http_probe public-section \
        "${APP_URL}/api/public/resource-share/sections/${section_handle}" \
        "$NEXUS_PUBLIC_SHARE_TOKEN"
    )"
    assert_status "$status" "200" "public EPUB section"
    ;;
esac

effective_url="$(
  curl --silent --show-error --output /dev/null --write-out "%{url_effective}" \
  --header "X-Nexus-Share-Token: ${NEXUS_PUBLIC_SHARE_TOKEN}" \
    "${APP_URL}/api/public/resource-share"
)"
[ "$effective_url" = "${APP_URL}/api/public/resource-share" ] || \
  die "public request target changed unexpectedly"

pdf_range="not-applicable"
if [ "$reader_kind" = "Pdf" ]; then
  status="$(
    http_probe pdf-range \
      "${APP_URL}/api/public/resource-share/file" \
      "$NEXUS_PUBLIC_SHARE_TOKEN" \
      "bytes=0-0"
  )"
  assert_status "$status" "206" "PDF range"
  [ "$(header_value accept-ranges "${tmp_dir}/pdf-range.headers")" = "bytes" ] || \
    die "PDF range omitted Accept-Ranges"
  [[ "$(header_value content-range "${tmp_dir}/pdf-range.headers")" =~ ^bytes\ 0-0/[0-9]+$ ]] || \
    die "PDF range omitted the exact Content-Range"

  status="$(
    http_probe pdf-invalid-range \
      "${APP_URL}/api/public/resource-share/file" \
      "$NEXUS_PUBLIC_SHARE_TOKEN" \
      "bytes=0-0,2-3"
  )"
  assert_status "$status" "416" "malformed PDF multi-range"
  pdf_range="passed"
fi

health_status="$(http_probe api-health "${API_URL}/health")"
assert_status "$health_status" "200" "API health"
api_revision="$(jq -r '.data.cutover_sha' "${tmp_dir}/api-health.body")"
[ "$api_revision" = "$CUTOVER_SHA" ] || \
  die "API revision ${api_revision} differs from CUTOVER_SHA"

deployment_args=(
  --fail-with-body
  --silent
  --show-error
  --get
  --header "Authorization: Bearer ${VERCEL_TOKEN}"
  --data-urlencode "projectId=${VERCEL_PROJECT_ID}"
  --data-urlencode "target=production"
  --data-urlencode "state=READY"
  --data-urlencode "limit=1"
)
if [ -n "${VERCEL_TEAM_ID:-}" ]; then
  deployment_args+=(--data-urlencode "teamId=${VERCEL_TEAM_ID}")
fi
deployment="$(
  curl "${deployment_args[@]}" "https://api.vercel.com/v6/deployments"
)"
vercel_deployment_id="$(jq -r '.deployments[0].uid // empty' <<<"$deployment")"
vercel_revision="$(
  jq -r '
    .deployments[0].gitSource.sha
    // .deployments[0].meta.githubCommitSha
    // .deployments[0].meta.gitlabCommitSha
    // empty
  ' <<<"$deployment"
)"
[ -n "$vercel_deployment_id" ] || die "no ready production Vercel deployment found"
[ "$vercel_revision" = "$CUTOVER_SHA" ] || \
  die "Vercel revision ${vercel_revision:-unknown} differs from CUTOVER_SHA"

firewall_args=(
  --fail-with-body
  --silent
  --show-error
  --get
  --header "Authorization: Bearer ${VERCEL_TOKEN}"
  --data-urlencode "projectId=${VERCEL_PROJECT_ID}"
)
if [ -n "${VERCEL_TEAM_ID:-}" ]; then
  firewall_args+=(--data-urlencode "teamId=${VERCEL_TEAM_ID}")
fi
firewall="$(
  curl "${firewall_args[@]}" "https://api.vercel.com/v1/security/firewall/config"
)"
firewall_version="$(jq -er '.active.version' <<<"$firewall")"
jq -e '
  [.active.rules[] | select(.name == "Nexus public resource sharing")] | length == 1
' <<<"$firewall" >/dev/null || die "active firewall lacks the managed sharing rule"

worker_revision="not-checked"
if [ -n "${NEXUS_SSH_TARGET:-}" ]; then
  require_command ssh
  deploy_path="${NEXUS_DEPLOY_PATH:-/opt/nexus-web}"
  env_file="${NEXUS_REMOTE_ENV_FILE:-/etc/nexus/nexus.env}"
  worker_revision="$(
    ssh "$NEXUS_SSH_TARGET" sh -s -- \
      "$deploy_path" "$env_file" "$CUTOVER_SHA" <<'REMOTE'
set -euo pipefail
deploy_path="$1"
env_file="$2"
cutover_sha="$3"
cd "$deploy_path"
CUTOVER_SHA="$cutover_sha" NEXUS_ENV_FILE="$env_file" \
  docker compose --env-file "$env_file" -f deploy/hetzner/docker-compose.yml \
  exec -T worker /app/.venv/bin/python -c \
  'import os; print(os.environ.get("CUTOVER_SHA", ""))'
REMOTE
  )"
  [ "$worker_revision" = "$CUTOVER_SHA" ] || \
    die "worker revision ${worker_revision} differs from CUTOVER_SHA"
fi

waf_smoke="not-run"
if [ "${NEXUS_RUN_WAF_SMOKE:-0}" = "1" ]; then
  echo "waiting for a fresh WAF window before the explicit 121-request smoke" >&2
  sleep 61
  for request_number in $(seq 1 120); do
    status="$(
      curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
        --header "X-Nexus-Share-Token: ${invalid_token}" \
        "${APP_URL}/api/public/resource-share"
    )"
    [ "$status" = "404" ] || \
      die "WAF request ${request_number}: expected app 404, got ${status}"
  done
  status="$(
    curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
      --header "X-Nexus-Share-Token: ${invalid_token}" \
      "${APP_URL}/api/public/resource-share"
  )"
  assert_status "$status" "429" "WAF request 121"
  waf_smoke="passed"
fi

server_log_token_check="not-run"
if [ -n "${NEXUS_SSH_TARGET:-}" ]; then
  ssh "$NEXUS_SSH_TARGET" sh -s -- \
    "${NEXUS_DEPLOY_PATH:-/opt/nexus-web}" \
    "${NEXUS_REMOTE_ENV_FILE:-/etc/nexus/nexus.env}" \
    "$CUTOVER_SHA" \
    "$smoke_started_at" >"${tmp_dir}/server.logs" <<'REMOTE'
set -euo pipefail
cd "$1"
CUTOVER_SHA="$3" NEXUS_ENV_FILE="$2" \
  docker compose --env-file "$2" -f deploy/hetzner/docker-compose.yml \
  logs --no-color --since "$4" api caddy
REMOTE
  if grep -Fq "$NEXUS_PUBLIC_SHARE_TOKEN" "${tmp_dir}/server.logs"; then
    die "unique smoke token appeared in Nexus-controlled server logs"
  fi
  server_log_token_check="passed"
fi

evidence="$(
  jq -cn \
    --arg cutover_sha "$CUTOVER_SHA" \
    --arg api_revision "$api_revision" \
    --arg worker_revision "$worker_revision" \
    --arg vercel_deployment_id "$vercel_deployment_id" \
    --arg vercel_revision "$vercel_revision" \
    --arg firewall_version "$firewall_version" \
    --arg waf_smoke "$waf_smoke" \
    --arg server_log_token_check "$server_log_token_check" \
    --arg pdf_range "$pdf_range" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      cutover_sha:$cutover_sha,
      typed_fixture:"passed",
      public_projection:"passed",
      ambient_authority_independence:"passed",
      pdf_range:$pdf_range,
      api_revision:$api_revision,
      worker_revision:$worker_revision,
      vercel_deployment_id:$vercel_deployment_id,
      vercel_revision:$vercel_revision,
      firewall_version:$firewall_version,
      waf_smoke:$waf_smoke,
      server_log_token_check:$server_log_token_check,
      completed_at:$completed_at
    }'
)"
if [ -n "${NEXUS_CUTOVER_EVIDENCE_FILE:-}" ]; then
  printf '%s\n' "$evidence" >"$NEXUS_CUTOVER_EVIDENCE_FILE"
fi
printf '%s\n' "$evidence"
