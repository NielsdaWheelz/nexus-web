#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/test_env.sh"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <command...>" >&2
    exit 1
fi

cd "$PROJECT_ROOT"

cleanup() {
    if [ "${SUPABASE_KEEP_RUNNING:-}" = "1" ]; then
        return
    fi
    supabase stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

supabase start >/dev/null
test_env_export_supabase_env
test_env_export_storage_prefix

status=0
"$@" || status=$?
exit $status
