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
start_log="$(mktemp)"

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

cleanup_supabase_project() {
    docker rm -f \
        "supabase_db_${project_id}" \
        "supabase_kong_${project_id}" \
        "supabase_auth_${project_id}" \
        "supabase_rest_${project_id}" \
        "supabase_storage_${project_id}" \
        "supabase_realtime_${project_id}" \
        "supabase_inbucket_${project_id}" \
        "supabase_imgproxy_${project_id}" \
        "supabase_pg_meta_${project_id}" \
        "supabase_studio_${project_id}" \
        "supabase_edge_runtime_${project_id}" \
        "supabase_analytics_${project_id}" \
        "supabase_vector_${project_id}" \
        "supabase_pooler_${project_id}" >/dev/null 2>&1 || true
    docker volume rm "supabase_db_${project_id}" "supabase_storage_${project_id}" >/dev/null 2>&1 || true
    docker network rm "supabase_network_${project_id}" >/dev/null 2>&1 || true
}

wait_for_supabase_ports_to_close() {
    for _ in {1..40}; do
        if ! lsof -i :54321 >/dev/null 2>&1 && ! lsof -i :54322 >/dev/null 2>&1; then
            return
        fi
        sleep 0.5
    done
}

# shellcheck disable=SC2329
cleanup() {
    set +e
    rm -f "$start_log"
    if [ "${SUPABASE_KEEP_RUNNING:-}" = "1" ]; then
        rm -rf "$lock_dir"
        return
    fi
    cleanup_supabase_project
    rm -rf "$lock_dir"
}
trap cleanup EXIT

if [ "${SUPABASE_KEEP_RUNNING:-}" != "1" ]; then
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
fi
# Test suites use Supabase Auth only. App data uses test Postgres and S3-compatible object storage.
for attempt in 1 2; do
    if ! supabase start \
        -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,mailpit,postgrest \
        >"$start_log" 2>&1; then
        echo "Supabase Auth startup failed on attempt ${attempt}." >&2
        cat "$start_log" >&2
        if [ "$attempt" = "2" ]; then
            exit 1
        fi
        cleanup_supabase_project
        wait_for_supabase_ports_to_close
        continue
    fi

    for _ in {1..120}; do
        db_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_db_${project_id}" 2>/dev/null || true)
        auth_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_auth_${project_id}" 2>/dev/null || true)
        kong_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_kong_${project_id}" 2>/dev/null || true)
        if [ "$db_health" = "healthy" ] &&
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
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
done
test_env_export_supabase_env
test_env_export_storage_prefix

status=0
"$@" || status=$?
exit $status
