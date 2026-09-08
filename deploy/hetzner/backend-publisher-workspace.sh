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
    die "RUNNER_TEMP must be owned by the publisher user"
  fi
  printf '%s\n' "$canonical"
}

validated_release_workspace() {
  local release_workspace="$1"
  local runner_temp
  runner_temp="$(canonical_runner_temp)"

  local parent="${release_workspace%/*}"
  local name="${release_workspace##*/}"
  if [ "$parent" != "$runner_temp" ] \
    || [[ ! "$name" =~ ^nexus-backend-release\.[A-Za-z0-9]{8}$ ]]; then
    die "release workspace is outside the exact runner-owned namespace"
  fi
  if [ ! -d "$release_workspace" ] || [ -L "$release_workspace" ]; then
    die "release workspace must be a real directory"
  fi
  if [ "$(realpath -e -- "$release_workspace")" != "$release_workspace" ]; then
    die "release workspace must be canonical"
  fi
  if [ "$(stat -c '%u' -- "$release_workspace")" != "$(id -u)" ]; then
    die "release workspace must be owned by the publisher user"
  fi
  if [ "$(stat -c '%a' -- "$release_workspace")" != "700" ]; then
    die "release workspace must be private"
  fi
  printf '%s\n' "$release_workspace"
}

prepare() {
  if [ "$#" -ne 0 ]; then
    die "prepare does not accept arguments"
  fi
  if [ -z "${GITHUB_WORKSPACE:-}" ]; then
    die "GITHUB_WORKSPACE is required"
  fi

  local checkout
  checkout="$(realpath -e -- "$GITHUB_WORKSPACE")"
  local git_root
  git_root="$(realpath -e -- "$(git -C "$checkout" rev-parse --show-toplevel)")"
  if [ "$checkout" != "$git_root" ]; then
    die "GITHUB_WORKSPACE must be the repository root"
  fi

  local runtime_state="$checkout/.nexus-test"
  if [ -e "$runtime_state" ] || [ -L "$runtime_state" ]; then
    if [ ! -d "$runtime_state" ] || [ -L "$runtime_state" ]; then
      die "the preserved .nexus-test path must be a real directory"
    fi
    if [ "$(stat -c '%u' -- "$runtime_state")" != "$(id -u)" ]; then
      die "the preserved .nexus-test directory must be owned by the publisher user"
    fi
  fi
  if ! git -C "$checkout" check-ignore --quiet -- .nexus-test; then
    die ".nexus-test must remain an explicit ignored runtime boundary"
  fi
  if ! git -C "$checkout" diff --quiet --ignore-submodules=none -- \
    || ! git -C "$checkout" diff --cached --quiet --ignore-submodules=none --; then
    die "publisher checkout contains tracked changes"
  fi

  # The self-hosted runner deliberately retains only the test controller's
  # workspace-local runtime record. Everything else is unowned input to an
  # immutable publication and must be removed, including nested repositories.
  git -C "$checkout" clean -qffdx -e /.nexus-test/

  local residue
  residue="$(git -C "$checkout" clean -nffdx -e /.nexus-test/)"
  if [ -n "$residue" ]; then
    printf 'error: publisher checkout retains unowned files after sanitation\n' >&2
    printf '%.4096s\n' "$residue" >&2
    exit 1
  fi
  if [ -n "$(git -C "$checkout" status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" ]; then
    die "publisher checkout is not clean after sanitation"
  fi

  local runner_temp
  runner_temp="$(canonical_runner_temp)"
  case "$runner_temp" in
    "$checkout"|"$checkout"/*)
      die "RUNNER_TEMP must be outside the publication checkout"
      ;;
  esac

  if [ -z "${GITHUB_OUTPUT:-}" ] || [ ! -f "$GITHUB_OUTPUT" ] || [ -L "$GITHUB_OUTPUT" ]; then
    die "GITHUB_OUTPUT must be a real runner-owned file"
  fi
  local github_output
  github_output="$(realpath -e -- "$GITHUB_OUTPUT")"
  case "$github_output" in
    "$runner_temp"/*) ;;
    *) die "GITHUB_OUTPUT must be inside RUNNER_TEMP" ;;
  esac
  if [ "$(stat -c '%u' -- "$github_output")" != "$(id -u)" ]; then
    die "GITHUB_OUTPUT must be owned by the publisher user"
  fi

  local release_workspace
  release_workspace="$(mktemp -d -- "$runner_temp/nexus-backend-release.XXXXXXXX")"
  chmod 700 -- "$release_workspace"
  release_workspace="$(validated_release_workspace "$release_workspace")"
  printf 'path=%s\n' "$release_workspace" >>"$github_output"
}

require_workspace() {
  if [ "$#" -ne 1 ]; then
    die "require expects one release workspace"
  fi
  validated_release_workspace "$1" >/dev/null
}

cleanup() {
  if [ "$#" -ne 1 ]; then
    die "cleanup expects one release workspace"
  fi
  local release_workspace
  release_workspace="$(validated_release_workspace "$1")"
  rm --recursive --force --one-file-system -- "$release_workspace"
  if [ -e "$release_workspace" ] || [ -L "$release_workspace" ]; then
    die "release workspace cleanup did not complete"
  fi
}

operation="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi
case "$operation" in
  prepare) prepare "$@" ;;
  require) require_workspace "$@" ;;
  cleanup) cleanup "$@" ;;
  *) die "usage: backend-publisher-workspace.sh prepare|require PATH|cleanup PATH" ;;
esac
