#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

canonical_runner_temp() {
  local configured="${RUNNER_TEMP:-}"
  if [ -z "$configured" ] || [ "$configured" = "/" ]; then
    die "RUNNER_TEMP must name a dedicated absolute directory"
  fi
  if [ ! -d "$configured" ] || [ -L "$configured" ]; then
    die "RUNNER_TEMP must be a real directory"
  fi

  local canonical
  canonical="$(realpath -e -- "$configured")"
  if [ "$canonical" != "$configured" ]; then
    die "RUNNER_TEMP must be canonical"
  fi
  if [ "$(stat -c '%u' -- "$canonical")" != "$(id -u)" ]; then
    die "RUNNER_TEMP must be owned by the CI user"
  fi
  printf '%s\n' "$canonical"
}

canonical_checkout() {
  local configured="${GITHUB_WORKSPACE:-}"
  if [ -z "$configured" ] || [ "$configured" = "/" ]; then
    die "GITHUB_WORKSPACE must name the repository root"
  fi
  if [ ! -d "$configured" ] || [ -L "$configured" ]; then
    die "GITHUB_WORKSPACE must be a real directory"
  fi

  local checkout
  checkout="$(realpath -e -- "$configured")"
  local git_root
  git_root="$(realpath -e -- "$(git -C "$checkout" rev-parse --show-toplevel)")"
  if [ "$checkout" != "$configured" ] || [ "$checkout" != "$git_root" ]; then
    die "GITHUB_WORKSPACE must be the canonical repository root"
  fi
  if [ "$(stat -c '%u' -- "$checkout")" != "$(id -u)" ]; then
    die "GITHUB_WORKSPACE must be owned by the CI user"
  fi
  printf '%s\n' "$checkout"
}

github_output_path() {
  local runner_temp="$1"
  local configured="${GITHUB_OUTPUT:-}"
  if [ -z "$configured" ] || [ ! -f "$configured" ] || [ -L "$configured" ]; then
    die "GITHUB_OUTPUT must be a real runner-owned file"
  fi

  local output
  output="$(realpath -e -- "$configured")"
  case "$output" in
    "$runner_temp"/*) ;;
    *) die "GITHUB_OUTPUT must be inside RUNNER_TEMP" ;;
  esac
  if [ "$(stat -c '%u' -- "$output")" != "$(id -u)" ]; then
    die "GITHUB_OUTPUT must be owned by the CI user"
  fi
  printf '%s\n' "$output"
}

validated_evidence_workspace() {
  local evidence_workspace="$1"
  local runner_temp
  runner_temp="$(canonical_runner_temp)"

  local parent="${evidence_workspace%/*}"
  local name="${evidence_workspace##*/}"
  if [ "$parent" != "$runner_temp" ] \
    || [[ ! "$name" =~ ^nexus-ci-evidence\.[A-Za-z0-9]{8}$ ]]; then
    die "evidence workspace is outside the exact runner-owned namespace"
  fi
  if [ ! -d "$evidence_workspace" ] || [ -L "$evidence_workspace" ]; then
    die "evidence workspace must be a real directory"
  fi
  if [ "$(realpath -e -- "$evidence_workspace")" != "$evidence_workspace" ]; then
    die "evidence workspace must be canonical"
  fi
  if [ "$(stat -c '%u' -- "$evidence_workspace")" != "$(id -u)" ]; then
    die "evidence workspace must be owned by the CI user"
  fi
  if [ "$(stat -c '%a' -- "$evidence_workspace")" != "700" ]; then
    die "evidence workspace must be private"
  fi
  printf '%s\n' "$evidence_workspace"
}

run_proof() {
  if [ "$#" -eq 0 ]; then
    die "run expects a test workflow"
  fi
  case "$1" in
    changed|full) ;;
    *) die "CI evidence staging admits only changed or full" ;;
  esac
  local workflow="$1"

  local command
  for command in cp find git id jq mktemp realpath stat; do
    command -v "$command" >/dev/null 2>&1 || die "$command is not installed"
  done

  local checkout
  checkout="$(canonical_checkout)"
  local runner_temp
  runner_temp="$(canonical_runner_temp)"
  case "$runner_temp" in
    "$checkout"|"$checkout"/*) die "RUNNER_TEMP must be outside the test checkout" ;;
  esac
  local github_output
  github_output="$(github_output_path "$runner_temp")"

  if ! git -C "$checkout" check-ignore --quiet -- \
    test-results/.nexus-ignore-contract; then
    die "test-results must remain an explicit ignored evidence boundary"
  fi
  if ! git -C "$checkout" diff --quiet --ignore-submodules=none -- \
    || ! git -C "$checkout" diff --cached --quiet --ignore-submodules=none --; then
    die "CI test checkout contains tracked changes"
  fi
  if [ ! -x "$checkout/scripts/test" ]; then
    die "the canonical test entrypoint is absent or not executable"
  fi

  local runs="$checkout/test-results/runs"
  declare -A existing_runs=()
  local path name
  if [ -e "$runs" ] || [ -L "$runs" ]; then
    if [ ! -d "$runs" ] || [ -L "$runs" ]; then
      die "the run evidence path must be a real directory"
    fi
    if [ "$(stat -c '%u' -- "$runs")" != "$(id -u)" ]; then
      die "the run evidence directory must be owned by the CI user"
    fi
    for path in "$runs"/*; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      name="${path##*/}"
      if [[ "$name" =~ ^[0-9a-f]{16}$ ]] && [ -d "$path" ] && [ ! -L "$path" ]; then
        existing_runs["$name"]=1
      fi
    done
  fi

  local test_status
  if (cd "$checkout" && "$checkout/scripts/test" "$@"); then
    test_status=0
  else
    test_status=$?
  fi
  if ! git -C "$checkout" diff --quiet --ignore-submodules=none -- \
    || ! git -C "$checkout" diff --cached --quiet --ignore-submodules=none --; then
    die "CI test invocation left tracked changes"
  fi

  if [ ! -d "$runs" ] || [ -L "$runs" ]; then
    if [ "$test_status" -ne 0 ]; then
      return "$test_status"
    fi
    die "passing test invocation produced no run evidence directory"
  fi

  local -a new_runs=()
  for path in "$runs"/*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    name="${path##*/}"
    if [[ "$name" =~ ^[0-9a-f]{16}$ ]] \
      && [ -d "$path" ] \
      && [ ! -L "$path" ] \
      && [ -z "${existing_runs[$name]+present}" ]; then
      new_runs+=("$path")
    fi
  done
  if [ "${#new_runs[@]}" -eq 0 ] && [ "$test_status" -ne 0 ]; then
    return "$test_status"
  fi
  if [ "${#new_runs[@]}" -ne 1 ]; then
    die "test invocation did not claim exactly one new run evidence directory"
  fi

  local run_directory="${new_runs[0]}"
  local run_id="${run_directory##*/}"
  if [ "$(realpath -e -- "$run_directory")" != "$run_directory" ]; then
    die "run evidence directory must be canonical"
  fi
  if [ "$(stat -c '%u' -- "$run_directory")" != "$(id -u)" ]; then
    die "run evidence directory must be owned by the CI user"
  fi
  if [ -n "$(find "$run_directory" \
    \( -type l -o ! -uid "$(id -u)" -o \( ! -type f ! -type d \) \) \
    -print -quit)" ]; then
    die "run evidence contains a symlink, special file, or foreign owner"
  fi

  local summary="$run_directory/summary.json"
  local run_context="$run_directory/run-context.json"
  if [ -f "$summary" ]; then
    if [ ! -f "$run_context" ]; then
      die "terminal run evidence has no run-context artifact"
    fi
    local git_sha
    git_sha="$(git -C "$checkout" rev-parse HEAD)"
    if ! jq -se \
      --arg run_id "$run_id" \
      --arg workflow "$workflow" \
      --arg git_sha "$git_sha" \
      --arg run_context "test-results/runs/${run_id}/run-context.json" '
        length == 1
        and .[0].version == 3
        and .[0].run_id == $run_id
        and .[0].workflow == $workflow
        and .[0].git_sha == $git_sha
        and .[0].run_context_artifact == $run_context
        and (.[0].status | IN("pass", "fail", "not_run"))
      ' "$summary" >/dev/null; then
      die "terminal run evidence does not match the CI invocation"
    fi
    local summary_status
    summary_status="$(jq -r .status "$summary")"
    if { [ "$test_status" -eq 0 ] && [ "$summary_status" != "pass" ]; } \
      || { [ "$test_status" -ne 0 ] && [ "$summary_status" = "pass" ]; }; then
      die "terminal run evidence disagrees with the test exit status"
    fi
  elif [ "$test_status" -eq 0 ]; then
    die "passing test invocation produced no terminal summary"
  fi

  local evidence_workspace
  evidence_workspace="$(mktemp -d -- "$runner_temp/nexus-ci-evidence.XXXXXXXX")"
  chmod 700 -- "$evidence_workspace"
  evidence_workspace="$(validated_evidence_workspace "$evidence_workspace")"
  mkdir -m 700 -- "$evidence_workspace/runs"
  cp --archive --reflink=auto -- "$run_directory" "$evidence_workspace/runs/"
  printf 'path=%s\n' "$evidence_workspace" >>"$github_output"

  return "$test_status"
}

cleanup() {
  if [ "$#" -ne 1 ]; then
    die "cleanup expects one evidence workspace"
  fi
  local evidence_workspace
  evidence_workspace="$(validated_evidence_workspace "$1")"
  rm --recursive --force --one-file-system -- "$evidence_workspace"
  if [ -e "$evidence_workspace" ] || [ -L "$evidence_workspace" ]; then
    die "evidence workspace cleanup did not complete"
  fi
}

operation="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi
case "$operation" in
  run) run_proof "$@" ;;
  cleanup) cleanup "$@" ;;
  *) die "usage: ci-proof-artifact.sh run TEST-ARGS...|cleanup PATH" ;;
esac
