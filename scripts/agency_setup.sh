#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"

require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Agency setup requires $1." >&2
        exit 1
    fi
}

require_tool git
require_tool uv
require_tool bun
require_tool docker
require_tool supabase

# Sensitivity builds fresh offline environments. Reinstalling hydrates every
# locked artifact even when this workspace's existing venv is already current.
uv sync --all-extras --locked --reinstall --directory "$repo_root/python"

# Full and higher gates archive the immutable provider-runtime and llm-tools
# commits from adjacent developer clones, then materialize them offline. Fetch
# only missing objects and hydrate their exact locks without moving either
# developer checkout's HEAD, refs, index, or working tree.
PYTHONPATH="$repo_root/python" "$repo_root/python/.venv/bin/python" \
    -m nexus_test_control.setup_dependencies --repo-root "$repo_root"

bun install --frozen-lockfile --cwd "$repo_root/apps/web"
bun install --frozen-lockfile --cwd "$repo_root/node/ingest"

# The typed test controller is the sole owner of test services and writable
# test state. Setup must not start a dev stack, migrate a shared database, seed
# shared data, or write product .env files before verification.
echo "Agency dependencies are ready; ./scripts/test owns test runtime startup."
