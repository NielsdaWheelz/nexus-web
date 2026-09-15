#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly root_dir
readonly repository="NielsdaWheelz/nexus-web"

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$#" = 2 ] || \
  die "usage: deploy/hetzner/fetch-release-bundle.sh <source-sha> <empty-output-directory>"
readonly source_sha="$1"
readonly bundle="$2"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || die "source sha must be 40 lowercase hex characters"
[[ "$bundle" = /* ]] || die "release bundle output must be an absolute path"
if [ ! -d "$bundle" ] || [ -L "$bundle" ]; then
  die "release bundle output must be a real directory"
fi
[ -z "$(find "$bundle" -mindepth 1 -maxdepth 1 -print -quit)" ] || \
  die "release bundle output must be empty"

for command in cmp find gh git jq python3 sort timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is not installed"
done
[ -n "${GH_TOKEN:-}" ] || die "gh_token is required to fetch a release bundle"
[ -z "$(git -C "$root_dir" status --porcelain --untracked-files=normal)" ] || \
  die "release bundle fetch requires a clean checkout"
[ "$(git -C "$root_dir" rev-parse HEAD)" = "$source_sha" ] || \
  die "source sha must equal checked-out head"
timeout --foreground 2m git -C "$root_dir" fetch --quiet origin main
[ "$(git -C "$root_dir" rev-parse origin/main)" = "$source_sha" ] || \
  die "source sha must equal origin/main"

readonly artifact_name="nexus-backend-release-${source_sha}"
artifact_pages="$(
  timeout --foreground 2m gh api --paginate --slurp \
    "repos/${repository}/actions/artifacts?name=${artifact_name}&per_page=100"
)"
publisher_run_id="$(
  jq -er --arg name "$artifact_name" --arg sha "$source_sha" '
    [.[].artifacts[]
      | select(.name == $name and .expired == false)] as $artifacts
    | if ($artifacts | length) == 1
      then $artifacts[0]
      else error("artifact is not unique")
      end
    | select(
        (.id | type == "number" and . > 0)
        and (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
        and (.workflow_run.id | type == "number" and . > 0)
        and .workflow_run.head_branch == "main"
        and .workflow_run.head_sha == $sha
      )
    | .workflow_run.id
  ' <<<"$artifact_pages"
)" || die "one exact unexpired backend artifact must exist for the source sha"

timeout --foreground 5m gh run download "$publisher_run_id" \
  --repo "$repository" \
  --name "$artifact_name" \
  --dir "$bundle"

bundle_files="$(cd "$bundle" && find . -type f -printf '%P\n' | LC_ALL=C sort)"
expected_bundle_files=$'Caddyfile\ncandidate-manifest.json\ndocker-compose.yml\npython/nexus/__init__.py\npython/nexus/release_artifact.py\nrelease.py'
[ "$bundle_files" = "$expected_bundle_files" ] || \
  die "release artifact has an unexpected shape"

cmp "$bundle/release.py" "$root_dir/deploy/hetzner/release.py"
cmp "$bundle/docker-compose.yml" "$root_dir/deploy/hetzner/docker-compose.yml"
cmp "$bundle/Caddyfile" "$root_dir/deploy/hetzner/Caddyfile"
cmp "$bundle/python/nexus/__init__.py" "$root_dir/python/nexus/__init__.py"
cmp "$bundle/python/nexus/release_artifact.py" "$root_dir/python/nexus/release_artifact.py"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$root_dir/python" \
  python3 -B "$root_dir/deploy/hetzner/release.py" validate-candidate \
  --manifest "$bundle/candidate-manifest.json" >/dev/null

jq -e --arg sha "$source_sha" --arg repository "$repository" '
  keys == [
    "expected_database_revision",
    "expected_oracle_manifest_digest",
    "images",
    "repository",
    "schema_version",
    "source_sha"
  ]
  and .schema_version == 2
  and .source_sha == $sha
  and .repository == $repository
' "$bundle/candidate-manifest.json" >/dev/null || \
  die "candidate manifest does not match the requested repository and source sha"

jq -cn --arg source_sha "$source_sha" '{source_sha: $source_sha}'
