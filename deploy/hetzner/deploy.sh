#!/usr/bin/env bash
# Release one main SHA: converge the Hetzner backend, then bind the Vercel
# frontend that CI already built for the same SHA. Idempotent; rerun it.
#
#   VERCEL_TOKEN=... deploy/hetzner/deploy.sh <source-sha>
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR
readonly PRODUCTION_HOST="nexus.nielseriknandal.com"
readonly VERCEL_PROJECT_NAME="nexus-web"
readonly VERCEL_PROJECT_ID="prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"
readonly VERCEL_TEAM_ID="team_fKVvTyTsMBQ7qFjccFO17BJL"
readonly VERCEL_SCOPE="niels-erik-nandals-projects"
readonly VERCEL_CLI="${ROOT_DIR}/apps/web/node_modules/.bin/vercel"
# Vercel's alias binding has no completion stream in the locked CLI; twelve
# two-second observations bound convergence to 24 seconds.
readonly ALIAS_POLL_ATTEMPTS=12

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$#" = 1 ] || die "usage: deploy/hetzner/deploy.sh <source-sha>"
readonly SOURCE_SHA="$1"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex characters"

for command in curl git jq python3 timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed"
done
[ -x "$VERCEL_CLI" ] || die "run the locked apps/web dependency install first"
[ -n "${VERCEL_TOKEN:-}" ] || die "VERCEL_TOKEN is required"
[[ "$VERCEL_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]] || die "VERCEL_TOKEN is malformed"

[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "a production release requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "the requested source SHA must equal checked-out HEAD"
timeout --foreground 2m git -C "$ROOT_DIR" fetch --quiet origin main
[ "$(git -C "$ROOT_DIR" rev-parse origin/main)" = "$SOURCE_SHA" ] || \
  die "the requested source SHA must equal origin/main"

TEMPORARY="$(mktemp -d)"
readonly TEMPORARY
trap 'rm -r -- "$TEMPORARY"' EXIT
readonly API_CONFIG="${TEMPORARY}/vercel-api.conf"
(
  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN" >"$API_CONFIG"
)

vercel_get() {
  local url="$1" output="$2" status
  status="$(
    curl --silent --show-error --max-time 15 --max-filesize 1048576 \
      --proto '=https' --tlsv1.2 --config "$API_CONFIG" \
      --output "$output" --write-out '%{http_code}' "$url"
  )" || die "Vercel read failed: $url"
  [ "$status" = 200 ] || die "Vercel read returned HTTP ${status}: $url"
}

# The exact production deployment CI built for this SHA, and nothing else.
readonly LISTING="${TEMPORARY}/deployments.json"
vercel_get \
  "https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&target=production&limit=100&meta-githubCommitSha=${SOURCE_SHA}" \
  "$LISTING"
deployment="$(
  jq -cer --arg sha "$SOURCE_SHA" --arg project "$VERCEL_PROJECT_NAME" \
    --arg project_id "$VERCEL_PROJECT_ID" '
    [.deployments[] | select(
        .readyState == "READY" and .name == $project and .projectId == $project_id
        and .target == "production" and .meta.githubCommitSha == $sha
        and (.uid | test("^dpl_[A-Za-z0-9]+$")) and (.url | type == "string")
      )] as $matches
    | if ($matches | length) == 0 then error("no READY production deployment") else . end
    | ($matches | max_by(.createdAt)) as $newest
    | if ([$matches[] | select(.createdAt == $newest.createdAt)] | length) != 1
      then error("ambiguous newest candidate") else {id: $newest.uid, url: $newest.url} end
  ' "$LISTING"
)" || die "no single READY production Vercel deployment exists for ${SOURCE_SHA}"
deployment_id="$(jq -r .id <<<"$deployment")"
deployment_url="$(jq -r .url <<<"$deployment")"
[[ "$deployment_url" =~ ^[a-z0-9][a-z0-9.-]*\.vercel\.app$ ]] || \
  die "the Vercel candidate URL is malformed"

# The published player-protocol contract is the web/native compatibility
# identity; the staged frontend must already serve this tree's copy.
player_protocol="$(jq -c . "${ROOT_DIR}/contracts/android-player-protocol.json")"
require_version() {
  local origin="$1" label="$2" body="${TEMPORARY}/${2}.json" headers="${TEMPORARY}/${2}.headers"
  curl --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    --dump-header "$headers" --output "$body" "https://${origin}/version" || \
    die "${label} /version did not return HTTP 200"
  jq -e --arg sha "$SOURCE_SHA" --argjson protocol "$player_protocol" '
    keys == ["player_protocol", "source_sha"]
    and .source_sha == $sha and .player_protocol == $protocol
  ' "$body" >/dev/null || die "${label} does not serve this SHA and player protocol"
  grep -Fiqx 'cache-control: no-store' <(tr -d '\r' <"$headers") || \
    die "${label} /version is cacheable"
}
require_version "$deployment_url" staged

# Converge the backend before the public frontend can call it.
PYTHONPATH="${ROOT_DIR}/python" python3 -B "${ROOT_DIR}/deploy/hetzner/release.py" "$SOURCE_SHA"

timeout --foreground 4m "$VERCEL_CLI" promote "$deployment_id" \
  --yes --timeout 3m --scope "$VERCEL_SCOPE" --non-interactive
timeout --foreground 4m "$VERCEL_CLI" alias set "$deployment_url" "$PRODUCTION_HOST" \
  --scope "$VERCEL_SCOPE" --non-interactive >/dev/null

readonly ALIAS="${TEMPORARY}/alias.json"
bound=false
for ((attempt = 1; attempt <= ALIAS_POLL_ATTEMPTS; attempt++)); do
  vercel_get "https://api.vercel.com/v2/aliases/${PRODUCTION_HOST}?teamId=${VERCEL_TEAM_ID}" "$ALIAS"
  if jq -e --arg host "$PRODUCTION_HOST" --arg id "$deployment_id" \
    '.alias == $host and .deploymentId == $id and .deployment.id == $id' \
    "$ALIAS" >/dev/null; then
    bound=true
    break
  fi
  sleep 2
done
[ "$bound" = true ] || die "the authoritative domain did not bind ${deployment_id}"

require_version "$PRODUCTION_HOST" production
echo "released ${SOURCE_SHA}: backend converged, ${PRODUCTION_HOST} bound to ${deployment_id}"
