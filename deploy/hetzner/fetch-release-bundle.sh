#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT_DIR
readonly REPOSITORY="NielsdaWheelz/nexus-web"

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

[ "$#" = 2 ] || \
  die "usage: deploy/hetzner/fetch-release-bundle.sh <source-sha> <empty-output-directory>"
readonly SOURCE_SHA="$1"
readonly BUNDLE="$2"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || \
  die "source SHA must be 40 lowercase hex characters"
[[ "$BUNDLE" = /* ]] || die "release bundle output must be an absolute path"
if [ ! -d "$BUNDLE" ] || [ -L "$BUNDLE" ]; then
  die "release bundle output must be a real directory"
fi
[ -z "$(find "$BUNDLE" -mindepth 1 -maxdepth 1 -print -quit)" ] || \
  die "release bundle output must be empty"

for command in cmp find gh git jq python3 sort timeout; do
  require_command "$command"
done
[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is required to fetch a release bundle"
[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ] || \
  die "release bundle fetch requires a clean checkout"
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || \
  die "source SHA must equal checked-out HEAD"
timeout --foreground 2m git -C "$ROOT_DIR" fetch --quiet origin main
[ "$(git -C "$ROOT_DIR" rev-parse origin/main)" = "$SOURCE_SHA" ] || \
  die "source SHA must equal origin/main"

readonly ARTIFACT_NAME="nexus-backend-release-${SOURCE_SHA}"
artifact_pages="$(
  timeout --foreground 2m gh api --paginate --slurp \
    "repos/${REPOSITORY}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100"
)"
publisher_run_id="$(
  jq -er --arg name "$ARTIFACT_NAME" '
    [.[].artifacts[]] as $artifacts
    | if (
        length > 0
        and all(.[]; .total_count == 1)
        and ($artifacts | length) == 1
      )
      then $artifacts[0]
      else error("artifact is not unique")
      end
    | select(
        .name == $name
        and .expired == false
        and (.id | type == "number" and . > 0)
        and (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
        and (.workflow_run.id | type == "number" and . > 0)
      )
    | .workflow_run.id
    | select(type == "number" and . > 0)
  ' <<<"$artifact_pages"
)" || die "one unexpired immutable backend artifact must exist for the exact SHA"

timeout --foreground 5m gh run download "$publisher_run_id" \
  --repo "$REPOSITORY" \
  --name "$ARTIFACT_NAME" \
  --dir "$BUNDLE"
bundle_files="$(cd "$BUNDLE" && find . -type f -printf '%P\n' | LC_ALL=C sort)"
expected_bundle_files=$'Caddyfile\ncandidate-manifest.json\ndocker-compose.yml\npython/nexus/__init__.py\npython/nexus/release_artifact.py\nrelease.py'
[ "$bundle_files" = "$expected_bundle_files" ] || \
  die "release artifact has an unexpected shape"
cmp "${BUNDLE}/release.py" "${ROOT_DIR}/deploy/hetzner/release.py"
cmp "${BUNDLE}/docker-compose.yml" "${ROOT_DIR}/deploy/hetzner/docker-compose.yml"
cmp "${BUNDLE}/Caddyfile" "${ROOT_DIR}/deploy/hetzner/Caddyfile"
cmp "${BUNDLE}/python/nexus/__init__.py" "${ROOT_DIR}/python/nexus/__init__.py"
cmp "${BUNDLE}/python/nexus/release_artifact.py" \
  "${ROOT_DIR}/python/nexus/release_artifact.py"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="${ROOT_DIR}/python" \
  python3 -B "${ROOT_DIR}/deploy/hetzner/release.py" validate-candidate \
    --manifest "${BUNDLE}/candidate-manifest.json" >/dev/null

manifest="$(<"${BUNDLE}/candidate-manifest.json")"
source_ci_run_id="$(
  jq -er --arg sha "$SOURCE_SHA" --arg repository "$REPOSITORY" '
    select(
      keys == [
        "expected_database_revision",
        "expected_oracle_manifest_digest",
        "images",
        "publisher_run_attempt",
        "publisher_run_id",
        "repository",
        "schema_version",
        "source_ci_run_attempt",
        "source_ci_run_id",
        "source_ci_workflow_id",
        "source_sha"
      ]
      and .schema_version == 1
      and .source_sha == $sha
      and .repository == $repository
      and (.source_ci_run_id | type == "number" and . > 0)
      and .source_ci_run_attempt == 1
      and (.source_ci_workflow_id | type == "number" and . > 0)
      and (.publisher_run_id | type == "number" and . > 0)
      and .publisher_run_attempt == 1
    )
    | .source_ci_run_id
  ' <<<"$manifest"
)" || die "candidate manifest does not match the requested repository/SHA"
[ "$(jq -r .publisher_run_id <<<"$manifest")" = "$publisher_run_id" ] || \
  die "candidate manifest does not bind the artifact owner"
[ "$source_ci_run_id" != "$publisher_run_id" ] || \
  die "source CI and publisher run IDs must differ"

publisher="$(timeout --foreground 1m gh api \
  "repos/${REPOSITORY}/actions/runs/${publisher_run_id}/attempts/1")"
jq -e \
  --arg repository "$REPOSITORY" \
  --argjson run_id "$publisher_run_id" '
  .id == $run_id
  and .run_attempt == 1
  and .path == ".github/workflows/backend-images.yml"
  and .event == "workflow_run"
  and .head_branch == "main"
  and .conclusion == "success"
  and .repository.full_name == $repository
' <<<"$publisher" >/dev/null || \
  die "candidate publisher is not the exact first-attempt main workflow"

source_ci_workflow_id="$(jq -r .source_ci_workflow_id <<<"$manifest")"
source_ci="$(timeout --foreground 1m gh api \
  "repos/${REPOSITORY}/actions/runs/${source_ci_run_id}/attempts/1")"
jq -e \
  --arg sha "$SOURCE_SHA" \
  --arg repository "$REPOSITORY" \
  --argjson run_id "$source_ci_run_id" \
  --argjson workflow_id "$source_ci_workflow_id" '
  .id == $run_id
  and .name == "CI"
  and .run_attempt == 1
  and .path == ".github/workflows/ci.yml"
  and .workflow_id == $workflow_id
  and .event == "push"
  and .head_branch == "main"
  and .head_sha == $sha
  and .conclusion == "success"
  and .repository.full_name == $repository
' <<<"$source_ci" >/dev/null || \
  die "manifest source CI is not the exact successful first main attempt"

jq -cnS \
  --arg source_sha "$SOURCE_SHA" \
  --argjson publisher_run_id "$publisher_run_id" \
  --argjson source_ci_run_id "$source_ci_run_id" \
  '{publisher_run_id:$publisher_run_id,source_ci_run_id:$source_ci_run_id,source_sha:$source_sha}'
