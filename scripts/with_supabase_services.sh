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

cleanup_supabase_project() {
    docker rm -f \
        supabase_db_nexus-web \
        supabase_kong_nexus-web \
        supabase_auth_nexus-web \
        supabase_rest_nexus-web \
        supabase_storage_nexus-web \
        supabase_realtime_nexus-web \
        supabase_inbucket_nexus-web \
        supabase_imgproxy_nexus-web \
        supabase_pg_meta_nexus-web \
        supabase_studio_nexus-web \
        supabase_edge_runtime_nexus-web \
        supabase_analytics_nexus-web \
        supabase_vector_nexus-web \
        supabase_pooler_nexus-web >/dev/null 2>&1 || true
    docker volume rm supabase_db_nexus-web supabase_storage_nexus-web >/dev/null 2>&1 || true
    docker network rm supabase_network_nexus-web >/dev/null 2>&1 || true
}

wait_for_supabase_ports_to_close() {
    for _ in {1..40}; do
        if ! lsof -i :54321 >/dev/null 2>&1 && ! lsof -i :54322 >/dev/null 2>&1; then
            return
        fi
        sleep 0.5
    done
}

cleanup() {
    if [ "${SUPABASE_KEEP_RUNNING:-}" = "1" ]; then
        return
    fi
    cleanup_supabase_project
}
trap cleanup EXIT

if [ "${SUPABASE_KEEP_RUNNING:-}" != "1" ]; then
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
fi
# Test suites use Supabase Postgres, Kong, Auth, REST, and Storage only.
supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,mailpit
test_env_export_supabase_env
test_env_export_storage_prefix

status=0
"$@" || status=$?
exit $status
