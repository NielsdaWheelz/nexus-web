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

project_id=$(awk -F'"' '/^project_id =/ { print $2; exit }' supabase/config.toml)
project_id="${project_id:-$(basename "$PROJECT_ROOT")}"
lock_root="${TMPDIR:-/tmp}/nexus-supabase-locks"
lock_dir="$lock_root/$project_id"
lock_wait_seconds=5

mkdir -p "$lock_root"
while ! mkdir "$lock_dir" 2>/dev/null; do
    owner_pid=""
    if [ -f "$lock_dir/pid" ]; then
        owner_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
    fi
    if [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -rf "$lock_dir"
        continue
    fi
    echo "Waiting for Supabase test stack lock held by pid $owner_pid..." >&2
    sleep "$lock_wait_seconds"
done
printf '%s\n' "$$" > "$lock_dir/pid"

cleanup() {
    set +e
    if [ "${SUPABASE_KEEP_RUNNING:-}" != "1" ]; then
        supabase stop >/dev/null 2>&1 || true
    fi
    rm -rf "$lock_dir"
}
trap cleanup EXIT

supabase start --ignore-health-check >/dev/null 2>&1 || true
for attempt in 1 2; do
    for _ in {1..120}; do
        db_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_db_${project_id}" 2>/dev/null || true)
        storage_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_storage_${project_id}" 2>/dev/null || true)
        auth_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_auth_${project_id}" 2>/dev/null || true)
        kong_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_kong_${project_id}" 2>/dev/null || true)
        if [ "$db_health" = "healthy" ] &&
            [ "$storage_health" = "healthy" ] &&
            [ "$auth_health" = "healthy" ] &&
            [ "$kong_health" = "healthy" ]; then
            break 2
        fi
        sleep 1
    done
    if [ "$attempt" = "2" ]; then
        echo "Error: Supabase core containers did not become healthy." >&2
        docker ps -a --format '{{.Names}} {{.Status}}' | grep "supabase_.*_${project_id}" >&2 || true
        exit 1
    fi
    echo "Supabase core containers did not settle; clearing partial local stack before retry..." >&2
    supabase stop --no-backup >/dev/null 2>&1 || true
    sleep 10
    supabase start --ignore-health-check >/dev/null 2>&1 || true
done

test_env_export_supabase_env
test_env_export_storage_prefix

status=0
"$@" || status=$?
exit $status
