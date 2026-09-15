#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

run_claim_to_cleanup=""
active_test_process_group=""
test_interruption_status=0

terminate_active_test() {
  local process_group="$active_test_process_group"
  [ -n "$process_group" ] || return 0

  # The controller receives TERM cooperatively and tears down the one
  # separately-sessioned command it owns. The bounded KILL is only a final
  # backstop for the controller session itself; GitHub's inherited process
  # tracking identity remains the hard-cancellation backstop for descendants.
  if kill -0 -- "-$process_group" 2>/dev/null; then
    kill -TERM -- "-$process_group" 2>/dev/null || true
    local attempt
    for ((attempt = 0; attempt < 100; attempt += 1)); do
      if ! kill -0 -- "-$process_group" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 -- "-$process_group" 2>/dev/null; then
      kill -KILL -- "-$process_group" 2>/dev/null || true
    fi
  fi
  wait "$process_group" 2>/dev/null || true
  active_test_process_group=""
}

interrupt_active_test() {
  # Normalize shell HUP/INT/TERM to the controller's owned TERM path. The
  # adapter must remain alive long enough to validate and stage interrupted
  # evidence when the runner grants it a cancellation grace period.
  trap '' HUP INT TERM
  test_interruption_status=143
  terminate_active_test
}

cleanup_run_claim() {
  terminate_active_test
  local claim="$run_claim_to_cleanup"
  if [ -n "$claim" ] && [ -f "$claim" ] && [ ! -L "$claim" ]; then
    rm -- "$claim"
  fi
}

trap cleanup_run_claim EXIT

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

validated_run_claim_file() {
  local claim="$1"
  local runner_temp
  runner_temp="$(canonical_runner_temp)"

  local parent="${claim%/*}"
  local name="${claim##*/}"
  if [ "$parent" != "$runner_temp" ] \
    || [[ ! "$name" =~ ^nexus-test-run-claim\.[A-Za-z0-9]{8}$ ]]; then
    die "run claim file is outside the exact runner-owned namespace"
  fi
  if [ ! -f "$claim" ] || [ -L "$claim" ]; then
    die "run claim must be a real file"
  fi
  if [ "$(realpath -e -- "$claim")" != "$claim" ]; then
    die "run claim file must be canonical"
  fi
  if [ "$(stat -c '%u' -- "$claim")" != "$(id -u)" ]; then
    die "run claim file must be owned by the CI user"
  fi
  if [ "$(stat -c '%a' -- "$claim")" != "600" ]; then
    die "run claim file must be private"
  fi
  printf '%s\n' "$claim"
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
    changed|pr|full) ;;
    *) die "CI evidence staging admits only changed, pr, or full" ;;
  esac
  local workflow="$1"

  local command
  for command in cp env find git id jq mktemp realpath setsid sleep stat; do
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

  local run_claim
  run_claim="$(mktemp -- "$runner_temp/nexus-test-run-claim.XXXXXXXX")"
  run_claim_to_cleanup="$run_claim"
  chmod 600 -- "$run_claim"
  run_claim="$(validated_run_claim_file "$run_claim")"
  local run_claim_descriptor
  exec {run_claim_descriptor}>"$run_claim"

  test_interruption_status=0
  trap interrupt_active_test HUP INT TERM
  (
    cd "$checkout"
    exec setsid env NEXUS_TEST_RUN_CLAIM_FD="$run_claim_descriptor" \
      "$checkout/scripts/test" "$@"
  ) &
  local test_process_group=$!
  active_test_process_group="$test_process_group"
  if [ "$test_interruption_status" -ne 0 ]; then
    terminate_active_test
  fi

  local observed_test_status
  if wait "$test_process_group" 2>/dev/null; then
    observed_test_status=0
  else
    observed_test_status=$?
  fi
  if [ -n "$active_test_process_group" ] \
    && kill -0 -- "-$test_process_group" 2>/dev/null; then
    terminate_active_test
    die "test controller exited while its owned process group remained active"
  fi
  active_test_process_group=""
  local test_status="$observed_test_status"
  if [ "$test_interruption_status" -ne 0 ]; then
    test_status="$test_interruption_status"
  fi
  exec {run_claim_descriptor}>&-
  if ! git -C "$checkout" diff --quiet --ignore-submodules=none -- \
    || ! git -C "$checkout" diff --cached --quiet --ignore-submodules=none --; then
    die "CI test invocation left tracked changes"
  fi

  run_claim="$(validated_run_claim_file "$run_claim")"
  if ! jq -se '
    length == 1
    and (.[0] |
      type == "object"
      and keys == ["directory", "run_id", "version"]
      and .version == 1
      and (.run_id | type == "string" and test("^[0-9a-f]{16}$"))
      and .directory == ("test-results/runs/" + .run_id)
    )
  ' "$run_claim" >/dev/null; then
    die "test controller did not publish one exact run claim"
  fi
  local run_id claim_directory
  IFS=$'\t' read -r run_id claim_directory < <(
    jq -r '[.run_id, .directory] | @tsv' "$run_claim"
  )
  rm -- "$run_claim"
  run_claim_to_cleanup=""

  if [ -n "${existing_runs[$run_id]+present}" ]; then
    die "test controller claimed a pre-existing run evidence directory"
  fi
  if [ ! -d "$runs" ] || [ -L "$runs" ]; then
    die "claimed run evidence path is not a real directory"
  fi

  local run_directory="$checkout/$claim_directory"
  if [ ! -d "$run_directory" ] || [ -L "$run_directory" ]; then
    die "claimed run evidence directory is absent or invalid"
  fi
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
  local proof_result="incomplete"
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
    proof_result="$(jq -r .status "$summary")"
    if { [ "$test_status" -eq 0 ] && [ "$proof_result" != "pass" ]; } \
      || { [ "$test_status" -ne 0 ] && [ "$proof_result" = "pass" ]; }; then
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
  printf 'path=%s\nresult=%s\n' \
    "$evidence_workspace" "$proof_result" >>"$github_output"

  # GitHub does not publish GITHUB_OUTPUT values from a failed step. Return
  # success only after the exact evidence is validated and staged; the workflow
  # enforces proof_result after its mandatory upload and guarded cleanup.
  return 0
}

enforce() {
  if [ "$#" -ne 1 ]; then
    die "enforce expects one proof result"
  fi
  case "$1" in
    pass) return 0 ;;
    fail|not_run|incomplete)
      die "canonical test proof concluded $1"
      ;;
    *) die "proof result is absent or invalid" ;;
  esac
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
  enforce) enforce "$@" ;;
  cleanup) cleanup "$@" ;;
  *) die "usage: ci-proof-artifact.sh run TEST-ARGS...|enforce RESULT|cleanup PATH" ;;
esac
