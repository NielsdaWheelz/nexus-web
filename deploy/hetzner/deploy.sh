#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR
readonly SSH_TARGET="nexus@5.78.194.235"
readonly PRODUCTION_HOST="nexus.nielseriknandal.com"
readonly VERCEL_PROJECT_NAME="nexus-web"
readonly VERCEL_PROJECT_ID="prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"
readonly VERCEL_TEAM_ID="team_fKVvTyTsMBQ7qFjccFO17BJL"
readonly VERCEL_SCOPE="niels-erik-nandals-projects"
readonly VERCEL_CLI="${ROOT_DIR}/apps/web/node_modules/.bin/vercel"
# justify-retry-schedule: provider reads get one immediate replay for a transport
# or explicitly transient HTTP failure; durable operation replay owns later attempts.
readonly VERCEL_READ_ATTEMPTS=2
# justify-polling: Vercel promotion has no completion stream in the locked CLI;
# twelve two-second observations bound alias convergence to 24 seconds.
readonly VERCEL_ALIAS_POLL_ATTEMPTS=12
readonly VERCEL_ALIAS_POLL_INTERVAL_SECONDS=2
readonly -a SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)
export PYTHONDONTWRITEBYTECODE=1

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

require_exact_public_headers() {
  local headers="$1"
  local label="$2"
  local cache_control

  cache_control="$(awk '
    {
      line = $0
      sub(/\r$/, "", line)
      separator = index(line, ":")
      if (separator == 0) next
      name = tolower(substr(line, 1, separator - 1))
      value = substr(line, separator + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      if (name == "cache-control") print value
    }
  ' "$headers")"
  [ "$cache_control" = "no-store" ] || die "$label must return one exact Cache-Control: no-store"
  if grep -Eiq '^(location|set-cookie):' "$headers"; then
    die "$label redirected or mutated authentication state"
  fi
}

vercel_get() {
  local url="$1"
  local output="$2"
  local status=""
  local attempt

  for ((attempt = 1; attempt <= VERCEL_READ_ATTEMPTS; attempt++)); do
    if status="$(
      curl --silent --show-error --max-time 15 --max-filesize 1048576 \
        --proto '=https' --tlsv1.2 \
        --config "$VERCEL_API_CONFIG" \
        --output "$output" \
        --write-out '%{http_code}' \
        "$url"
    )"; then
      case "$status" in
        408|429|5??)
          if [ "$attempt" -lt "$VERCEL_READ_ATTEMPTS" ]; then
            continue
          fi
          ;;
      esac
      printf '%s' "$status"
      return 0
    fi
  done
  return 1
}

bind_production_alias() {
  local deployment_url="$1"

  timeout --foreground 4m "$VERCEL_CLI" alias set "$deployment_url" "$PRODUCTION_HOST" \
    --scope "$VERCEL_SCOPE" --non-interactive >/dev/null
}

settle_bound_frontend_failure() {
  local deployment_id="$1"
  timeout --foreground 4m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 3m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" fail-bound-frontend \
      --source-sha "$SOURCE_SHA" \
      --deployment-id "$deployment_id"
  die "the immutable bound Vercel deployment is permanently unavailable; host settlement completed"
}

case "$PRODUCTION_HOST" in
  *[!a-z0-9.-]*|.*|*..*|*.) die "committed production host is malformed" ;;
esac
[[ "$PRODUCTION_HOST" == *.* ]] || die "committed production host is malformed"
[ "$#" = 1 ] || die "usage: deploy/hetzner/deploy.sh <source-sha>"
readonly SOURCE_SHA="$1"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex characters"

for command in git jq ssh timeout; do
  require_command "$command"
done

[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "production release requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "requested source SHA must equal checked-out HEAD"
origin_main_proven=false

TEMPORARY="$(mktemp -d)"
readonly TEMPORARY
readonly BUNDLE="${TEMPORARY}/bundle"
readonly REMOTE_BUNDLE="/opt/nexus/releases/${SOURCE_SHA}"
readonly REMOTE_CONTROLLER="${REMOTE_BUNDLE}/release.py"
REMOTE_TEMPORARY=""

cleanup() {
  if [[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-release\.[A-Za-z0-9]{8}$ ]]; then
    timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
      rm -r -- "$REMOTE_TEMPORARY" >/dev/null 2>&1 || true
  fi
  rm -r -- "$TEMPORARY"
}
trap cleanup EXIT

bundle_installed=false
if timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  sudo test -x "$REMOTE_CONTROLLER"; then
  bundle_installed=true
else
  installed_probe_status="$?"
  [ "$installed_probe_status" = 1 ] || \
    die "could not determine whether the immutable host bundle is installed"
fi

if [ "$bundle_installed" = false ]; then
  require_command scp
  [ -x "${ROOT_DIR}/deploy/hetzner/fetch-release-bundle.sh" ] || \
    die "immutable release bundle resolver is not executable"
  mkdir "$BUNDLE"
  "${ROOT_DIR}/deploy/hetzner/fetch-release-bundle.sh" \
    "$SOURCE_SHA" "$BUNDLE" >/dev/null
  origin_main_proven=true

  REMOTE_TEMPORARY="$(timeout --foreground 30s ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    mktemp -d /tmp/nexus-release.XXXXXXXX)"
  [[ "$REMOTE_TEMPORARY" =~ ^/tmp/nexus-release\.[A-Za-z0-9]{8}$ ]] || \
    die "host returned an invalid transfer directory"
  timeout --foreground 5m scp "${SSH_OPTIONS[@]}" -r \
    "${BUNDLE}/." "${SSH_TARGET}:${REMOTE_TEMPORARY}/"
  timeout --foreground 3m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 2m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_TEMPORARY}/python" \
    python3 -B "${REMOTE_TEMPORARY}/release.py" install-bundle \
      --source "$REMOTE_TEMPORARY" >/dev/null
fi

host_inspect="$(
  timeout --foreground 1m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    sudo env PYTHONDONTWRITEBYTECODE=1 "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" inspect --source-sha "$SOURCE_SHA"
)"
jq -e --arg sha "$SOURCE_SHA" '
  keys == [
    "current_sha",
    "current_vercel_deployment_id",
    "failed_vercel_deployment_ids",
    "forward_fix_sha",
    "phase",
    "predecessor_sha",
    "status",
    "vercel_deployment_id"
  ]
  and (.current_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.current_vercel_deployment_id | type == "string"
    and test("^dpl_[A-Za-z0-9]+$"))
  and ((.failed_vercel_deployment_ids | type) == "array")
  and ([.failed_vercel_deployment_ids[]
    | type == "string" and test("^dpl_[A-Za-z0-9]+$")]
    | all)
  and ((.failed_vercel_deployment_ids | unique | length)
    == (.failed_vercel_deployment_ids | length))
  and (
    (.forward_fix_sha == null and (.failed_vercel_deployment_ids | length) == 0)
    or
    ((.forward_fix_sha | type == "string")
      and (.failed_vercel_deployment_ids | length) > 0)
  )
  and (
    (.status == "new"
      and .phase == null
      and (.predecessor_sha | type == "string" and test("^[0-9a-f]{40}$"))
      and .vercel_deployment_id == null)
    or
    (.status == "resume"
      and (.phase | IN(
        "Prepared",
        "WritersStopped",
        "BackupVerified",
        "DataMutationStarted",
        "BackendActivationStarted",
        "AwaitingFrontendPromotion",
        "FrontendPromoted",
        "RollbackRequired",
        "ForwardFixPending"
      ))
      and (.vercel_deployment_id | type == "string"))
    or
    (.status == "current"
      and .current_sha == $sha
      and .phase == "Succeeded"
      and (.vercel_deployment_id | type == "string"))
  )
' <<<"$host_inspect" >/dev/null || die "host inspect response is malformed"
status="$(jq -r .status <<<"$host_inspect")"
phase="$(jq -r '.phase // empty' <<<"$host_inspect")"
if [ "$phase" = "RollbackRequired" ] || [ "$phase" = "ForwardFixPending" ]; then
  settlement_deployment_id="$(jq -r .vercel_deployment_id <<<"$host_inspect")"
  [[ "$settlement_deployment_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || \
    die "durable failure settlement has no bound Vercel deployment"
  timeout --foreground 16m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 15m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" apply \
      --source-sha "$SOURCE_SHA" \
      --deployment-id "$settlement_deployment_id" \
      --production-host "$PRODUCTION_HOST"
  die "durable failure settlement unexpectedly returned success"
fi

if [ "$origin_main_proven" = false ]; then
  timeout --foreground 2m git -C "$ROOT_DIR" fetch --quiet origin main
  [ "$(git -C "$ROOT_DIR" rev-parse origin/main)" = "$SOURCE_SHA" ] || \
    die "requested source SHA must equal origin/main"
fi

for command in awk curl grep; do
  require_command "$command"
done
[ -x "$VERCEL_CLI" ] || die "run the locked apps/web dependency install first"
[ -n "${VERCEL_TOKEN:-}" ] || die "VERCEL_TOKEN is required"
[[ "$VERCEL_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]] || die "VERCEL_TOKEN is malformed"
readonly VERCEL_API_CONFIG="${TEMPORARY}/vercel-api.conf"
(
  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN" >"$VERCEL_API_CONFIG"
)

vercel_project_body="${TEMPORARY}/vercel-project.json"
vercel_project_status="$(vercel_get \
  "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}?teamId=${VERCEL_TEAM_ID}" \
  "$vercel_project_body")" || die "Vercel project inspection failed transiently"
[ "$vercel_project_status" = 200 ] || \
  die "Vercel project inspection returned HTTP ${vercel_project_status}"
jq -e \
  --arg id "$VERCEL_PROJECT_ID" \
  --arg name "$VERCEL_PROJECT_NAME" \
  --arg team "$VERCEL_TEAM_ID" '
  .id == $id
  and .name == $name
  and .accountId == $team
  and .autoAssignCustomDomains == false
  and .autoExposeSystemEnvs == true
  and .ssoProtection.deploymentType == "preview"
' "$vercel_project_body" >/dev/null || \
  die "committed Vercel project/team identity or build policy disagrees"

current_id="$(jq -r '.current_vercel_deployment_id // empty' <<<"$host_inspect")"
bound_deployment_id="$(jq -r '.vercel_deployment_id // empty' <<<"$host_inspect")"
deployment=""

# Resume resolves and, if necessary, terminally settles only its durable exact
# deployment ID before inspecting the mutable production alias.
if [ "$status" = "resume" ]; then
  [[ "$bound_deployment_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || \
    die "resume has no bound Vercel deployment"
  bound_api_body="${TEMPORARY}/bound-deployment.json"
  bound_api_status="$(vercel_get \
    "https://api.vercel.com/v13/deployments/${bound_deployment_id}?teamId=${VERCEL_TEAM_ID}" \
    "$bound_api_body")" || die "direct bound Vercel inspection failed transiently"
  if [ "$bound_api_status" = 404 ]; then
    jq -e '
      type == "object"
      and (.error | type) == "object"
      and (.error.code | type) == "string"
      and ((.error.code | ascii_downcase) | IN("not_found", "deployment_not_found"))
    ' "$bound_api_body" >/dev/null || \
      die "bound Vercel inspection returned an unrecognized HTTP 404 contract"
    settle_bound_frontend_failure "$bound_deployment_id"
  fi
  [ "$bound_api_status" = 200 ] || \
    die "direct bound Vercel inspection returned transient/operator HTTP ${bound_api_status}"
  jq -e '
    type == "object"
    and (.id | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
    and (.name | type) == "string"
    and (.projectId | type) == "string"
    and (.ownerId | type) == "string"
    and (.readyState | type) == "string"
    and (.target | type) == "string"
    and (.url | type) == "string"
    and (.meta | type) == "object"
    and (.meta.githubCommitSha | type) == "string"
    and (.alias | type) == "array"
  ' "$bound_api_body" >/dev/null || \
    die "bound Vercel deployment response is malformed"
  if ! jq -e \
    --arg id "$bound_deployment_id" \
    --arg project_id "$VERCEL_PROJECT_ID" \
    --arg project "$VERCEL_PROJECT_NAME" \
    --arg team "$VERCEL_TEAM_ID" \
    --arg sha "$SOURCE_SHA" '
    .id == $id
    and .projectId == $project_id
    and .name == $project
    and .ownerId == $team
    and .target == "production"
    and .meta.githubCommitSha == $sha
  ' "$bound_api_body" >/dev/null; then
    die "bound Vercel deployment identity disagrees with durable release state"
  fi
  bound_ready_state="$(jq -r .readyState "$bound_api_body")"
  case "$bound_ready_state" in
    ERROR|CANCELED)
      settle_bound_frontend_failure "$bound_deployment_id"
      ;;
    BUILDING|QUEUED|INITIALIZING)
      die "bound Vercel deployment is not terminally ready; retry the same SHA"
      ;;
    READY) ;;
    *) die "bound Vercel deployment has an unknown state" ;;
  esac
  deployment="$(jq -cer '{id, name, state: .readyState, target, meta, url}' \
    "$bound_api_body")"
fi

authoritative_alias_body="${TEMPORARY}/authoritative-alias.json"
authoritative_alias_status="$(vercel_get \
  "https://api.vercel.com/v2/aliases/${PRODUCTION_HOST}?teamId=${VERCEL_TEAM_ID}" \
  "$authoritative_alias_body")" || die "authoritative Vercel alias inspection failed transiently"
[ "$authoritative_alias_status" = 200 ] || \
  die "authoritative Vercel alias inspection returned HTTP ${authoritative_alias_status}"
jq -e \
  --arg host "$PRODUCTION_HOST" \
  --arg project_id "$VERCEL_PROJECT_ID" '
  .alias == $host
  and (.deploymentId | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
  and .deployment.id == .deploymentId
  and .projectId == $project_id
' "$authoritative_alias_body" >/dev/null || \
  die "authoritative Vercel alias has no exact production deployment binding"
authoritative_id="$(jq -r .deploymentId "$authoritative_alias_body")"
authoritative_body="${TEMPORARY}/authoritative-deployment.json"
authoritative_status="$(vercel_get \
  "https://api.vercel.com/v13/deployments/${authoritative_id}?teamId=${VERCEL_TEAM_ID}" \
  "$authoritative_body")" || die "authoritative Vercel inspection failed transiently"
[ "$authoritative_status" = 200 ] || \
  die "authoritative Vercel inspection returned HTTP ${authoritative_status}"
jq -e \
  --arg id "$authoritative_id" \
  --arg project_id "$VERCEL_PROJECT_ID" \
  --arg project "$VERCEL_PROJECT_NAME" \
  --arg team "$VERCEL_TEAM_ID" '
  (.id | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
  and .id == $id
  and .projectId == $project_id
  and .name == $project
  and .ownerId == $team
  and .target == "production"
  and .readyState == "READY"
' "$authoritative_body" >/dev/null || \
  die "authoritative Vercel deployment is not exact READY production"

if [ "$status" = "current" ]; then
  [ "$authoritative_id" = "$current_id" ] || \
    die "authoritative Vercel deployment differs from the current release record"
  timeout --foreground 4m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 3m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" verify-current --source-sha "$SOURCE_SHA"
  exit 0
fi

prior_authoritative_id="$current_id"
resume_bound_id="$bound_deployment_id"
if [ "$authoritative_id" != "$prior_authoritative_id" ] \
  && { [ -z "$resume_bound_id" ] || [ "$authoritative_id" != "$resume_bound_id" ]; } \
  && ! jq -e --arg id "$authoritative_id" \
    '.failed_vercel_deployment_ids | index($id) != null' \
    <<<"$host_inspect" >/dev/null; then
  die "authoritative Vercel deployment is unknown before host mutation"
fi

if [ "$status" = "new" ]; then
  vercel_list_body="${TEMPORARY}/vercel-deployments.json"
  vercel_list_status="$(vercel_get \
    "https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&target=production&limit=100&meta-githubCommitSha=${SOURCE_SHA}" \
    "$vercel_list_body")" || die "Vercel candidate listing failed transiently"
  [ "$vercel_list_status" = 200 ] || \
    die "Vercel candidate listing returned HTTP ${vercel_list_status}"
  deployment="$(
    jq -cer \
      --arg sha "$SOURCE_SHA" \
      --arg project_id "$VERCEL_PROJECT_ID" \
      --arg project "$VERCEL_PROJECT_NAME" '
      select(
        (.deployments | type) == "array"
        and (.pagination | type) == "object"
        and .pagination.next == null
      )
      | [.deployments[]
          | select(
              .readyState == "READY"
              and .name == $project
              and .projectId == $project_id
              and .target == "production"
              and .meta.githubCommitSha == $sha
              and (.uid | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
              and (.url | type == "string")
              and (.createdAt | type == "number")
            )] as $matches
      | if ($matches | length) == 0 then error("no staged candidate") else . end
      | ($matches | max_by(.createdAt)) as $newest
      | if ([$matches[] | select(.createdAt == $newest.createdAt)] | length) != 1
        then error("ambiguous newest staged candidate")
        else {
          id: $newest.uid,
          name: $newest.name,
          state: $newest.readyState,
          target: $newest.target,
          meta: $newest.meta,
          url: $newest.url
        }
        end
    ' "$vercel_list_body"
  )" || die "no READY production-target Vercel deployment exists for the exact SHA"
  bound_deployment_id="$(jq -r .id <<<"$deployment")"
fi
deployment_url="$(jq -r .url <<<"$deployment")"
[[ "$deployment_url" =~ ^[a-z0-9][a-z0-9.-]*\.vercel\.app$ ]] || \
  die "Vercel candidate URL is malformed"
if [ "$status" = "resume" ]; then
  candidate_detail="$bound_api_body"
else
  candidate_detail="${TEMPORARY}/candidate-deployment.json"
  candidate_detail_status="$(vercel_get \
    "https://api.vercel.com/v13/deployments/${bound_deployment_id}?teamId=${VERCEL_TEAM_ID}" \
    "$candidate_detail")" || die "exact Vercel candidate inspection failed transiently"
  [ "$candidate_detail_status" = 200 ] || \
    die "exact Vercel candidate inspection returned HTTP ${candidate_detail_status}"
fi
jq -e \
  --arg id "$bound_deployment_id" \
  --arg url "$deployment_url" \
  --arg sha "$SOURCE_SHA" \
  --arg project_id "$VERCEL_PROJECT_ID" \
  --arg project "$VERCEL_PROJECT_NAME" \
  --arg team "$VERCEL_TEAM_ID" '
  .id == $id
  and .name == $project
  and .projectId == $project_id
  and .ownerId == $team
  and .url == $url
  and .target == "production"
  and .readyState == "READY"
  and .meta.githubCommitSha == $sha
  and (.alias | type) == "array"
' "$candidate_detail" >/dev/null || die "Vercel candidate inspection disagrees with selection"
production_aliases_json="$(jq -c '.targets.production.alias // []' "$vercel_project_body")"
automatic_aliases_json="$(jq -c '.targets.production.automaticAliases // []' "$vercel_project_body")"
if [ "$status" = "new" ]; then
  jq -e \
    --arg production_host "$PRODUCTION_HOST" \
    --argjson production_aliases "$production_aliases_json" \
    --argjson automatic_aliases "$automatic_aliases_json" '
    .alias as $aliases
    | all($aliases[];
        . as $alias
        | ($alias | test("^[a-z0-9][a-z0-9.-]*\\.vercel\\.app$"))
        and $alias != $production_host
        and (
          (any($production_aliases[]; . == $alias) | not)
          or any($automatic_aliases[]; . == $alias)
        )
      )
  ' "$candidate_detail" >/dev/null || \
    die "Vercel candidate has a production or non-generated alias"
fi

candidate_headers="${TEMPORARY}/candidate.headers"
candidate_version="${TEMPORARY}/candidate.json"
candidate_status="$(curl --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  --dump-header "$candidate_headers" \
  --output "$candidate_version" \
  --write-out '%{http_code}' \
  "https://${deployment_url}/version")"
[ "$candidate_status" = "200" ] || die "staged frontend version did not return HTTP 200"
jq -e --arg sha "$SOURCE_SHA" 'keys == ["source_sha"] and .source_sha == $sha' \
  "$candidate_version" >/dev/null || die "staged frontend version differs from the candidate SHA"
require_exact_public_headers "$candidate_headers" "staged frontend version"

timeout --foreground 2m "$ROOT_DIR/deploy/supabase/verify-auth-config.sh"

if [ "$status" = "new" ] || [ "$phase" != "FrontendPromoted" ]; then
  timeout --foreground 66m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 65m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" apply \
      --source-sha "$SOURCE_SHA" \
      --deployment-id "$bound_deployment_id" \
      --production-host "$PRODUCTION_HOST"
fi

authoritative_alias_status="$(vercel_get \
  "https://api.vercel.com/v2/aliases/${PRODUCTION_HOST}?teamId=${VERCEL_TEAM_ID}" \
  "$authoritative_alias_body")" || die "authoritative Vercel alias inspection failed transiently"
[ "$authoritative_alias_status" = 200 ] || \
  die "authoritative Vercel alias inspection returned HTTP ${authoritative_alias_status}"
jq -e \
  --arg host "$PRODUCTION_HOST" \
  --arg project_id "$VERCEL_PROJECT_ID" '
  .alias == $host
  and (.deploymentId | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
  and .deployment.id == .deploymentId
  and .projectId == $project_id
' "$authoritative_alias_body" >/dev/null || \
  die "authoritative Vercel alias has no exact production deployment binding"
authoritative_id="$(jq -r .deploymentId "$authoritative_alias_body")"
authoritative_status="$(vercel_get \
  "https://api.vercel.com/v13/deployments/${authoritative_id}?teamId=${VERCEL_TEAM_ID}" \
  "$authoritative_body")" || die "authoritative Vercel inspection failed transiently"
[ "$authoritative_status" = 200 ] || \
  die "authoritative Vercel inspection returned HTTP ${authoritative_status}"
jq -e \
  --arg id "$authoritative_id" \
  --arg project_id "$VERCEL_PROJECT_ID" \
  --arg project "$VERCEL_PROJECT_NAME" \
  --arg team "$VERCEL_TEAM_ID" '
  (.id | type == "string" and test("^dpl_[A-Za-z0-9]+$"))
  and .id == $id
  and .projectId == $project_id
  and .name == $project
  and .ownerId == $team
  and .target == "production"
  and .readyState == "READY"
' "$authoritative_body" >/dev/null || \
  die "authoritative Vercel deployment is not exact READY production"
current_id="$(jq -r '.current_vercel_deployment_id // empty' <<<"$host_inspect")"
if [ "$authoritative_id" != "$bound_deployment_id" ]; then
  if [ "$authoritative_id" != "$current_id" ]; then
    if ! jq -e --arg id "$authoritative_id" \
      '.failed_vercel_deployment_ids | index($id) != null' \
      <<<"$host_inspect" >/dev/null; then
      die "authoritative Vercel deployment is neither exact prior, failed-public, nor bound"
    fi
  fi
  timeout --foreground 4m "$VERCEL_CLI" promote "$bound_deployment_id" \
    --yes --timeout 3m --scope "$VERCEL_SCOPE" --non-interactive
fi

alias_bound=false
alias_body="${TEMPORARY}/bound-alias.json"
bind_production_alias "$deployment_url"
for ((alias_attempt = 1; alias_attempt <= VERCEL_ALIAS_POLL_ATTEMPTS; alias_attempt++)); do
  if alias_status="$(vercel_get \
    "https://api.vercel.com/v2/aliases/${PRODUCTION_HOST}?teamId=${VERCEL_TEAM_ID}" \
    "$alias_body")" \
    && [ "$alias_status" = 200 ] \
    && jq -e \
    --arg host "$PRODUCTION_HOST" \
    --arg id "$bound_deployment_id" \
    --arg project_id "$VERCEL_PROJECT_ID" \
    '
      .alias == $host
      and .deploymentId == $id
      and .deployment.id == $id
      and .projectId == $project_id
    ' "$alias_body" >/dev/null; then
    alias_bound=true
    break
  fi
  sleep "$VERCEL_ALIAS_POLL_INTERVAL_SECONDS"
done
[ "$alias_bound" = true ] || die "authoritative domain did not bind the exact candidate"

production_version="${TEMPORARY}/production.json"
production_headers="${TEMPORARY}/production.headers"
production_status="$(curl --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  --dump-header "$production_headers" \
  --output "$production_version" \
  --write-out '%{http_code}' \
  "https://${PRODUCTION_HOST}/version")"
[ "$production_status" = "200" ] || \
  die "authoritative frontend version did not return HTTP 200"
require_exact_public_headers "$production_headers" "authoritative frontend version"
jq -e --arg sha "$SOURCE_SHA" 'keys == ["source_sha"] and .source_sha == $sha' \
  "$production_version" >/dev/null || \
  die "authoritative frontend does not serve the exact candidate SHA"

auth_api_url="$(awk -F= '$1 == "FASTAPI_BASE_URL" {print $2; exit}' "${ROOT_DIR}/deploy/env/env-prod-frontend")"
auth_supabase_url="$(awk -F= '$1 == "NEXT_PUBLIC_SUPABASE_URL" {print $2; exit}' "${ROOT_DIR}/deploy/env/env-prod-frontend")"
[ -n "$auth_api_url" ] || die "FASTAPI_BASE_URL is required for post-alias auth smoke"
[ -n "$auth_supabase_url" ] || die "NEXT_PUBLIC_SUPABASE_URL is required for post-alias auth smoke"
if ! timeout --foreground 4m "$ROOT_DIR/deploy/smoke/auth-smoke.sh" \
  --app-url "https://${PRODUCTION_HOST}" \
  --api-url "$auth_api_url" \
  --supabase-url "$auth_supabase_url"; then
  timeout --foreground 16m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
    timeout --foreground 15m sudo env PYTHONDONTWRITEBYTECODE=1 \
    "PYTHONPATH=${REMOTE_BUNDLE}/python" \
    python3 -B "$REMOTE_CONTROLLER" fail-bound-frontend \
      --source-sha "$SOURCE_SHA" \
      --deployment-id "$bound_deployment_id"
  die "post-alias auth smoke failed; release was settled for forward fix"
fi

timeout --foreground 16m ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  timeout --foreground 15m sudo env PYTHONDONTWRITEBYTECODE=1 \
  "PYTHONPATH=${REMOTE_BUNDLE}/python" \
  python3 -B "$REMOTE_CONTROLLER" finalize \
    --source-sha "$SOURCE_SHA" \
    --deployment-id "$bound_deployment_id"
