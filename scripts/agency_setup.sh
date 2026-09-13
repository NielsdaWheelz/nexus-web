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

uv sync --all-extras --locked --directory "$repo_root/python"
bun install --frozen-lockfile --cwd "$repo_root/apps/web"
bun install --frozen-lockfile --cwd "$repo_root/node/ingest"

# The typed test controller is the sole owner of test services and writable
# test state. Setup must not start a dev stack, migrate a shared database, seed
# shared data, or write product .env files before verification.
echo "Agency dependencies are ready; ./scripts/test owns test runtime startup."
