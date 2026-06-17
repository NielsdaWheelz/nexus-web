#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/test_env.sh"

require_admin=0
if [ "${1:-}" = "--require-admin" ]; then
    require_admin=1
    shift
elif [ "${1:-}" = "--help" ] || [[ "${1:-}" == --* ]]; then
    echo "Usage: $0 [--require-admin] <command...>" >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    echo "Usage: $0 [--require-admin] <command...>" >&2
    exit 1
fi

for key in SERVICE_ROLE_KEY SUPABASE_DATABASE_URL SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY; do
    if [ -n "${!key:-}" ]; then
        echo "Error: $key is not accepted by E2E Supabase bootstrap; use command-scoped SUPABASE_AUTH_ADMIN_KEY." >&2
        exit 1
    fi
done

cd "$PROJECT_ROOT"

base_project_id=$(awk -F'"' '/^project_id =/ { print $2; exit }' supabase/config.toml)
base_project_id="${base_project_id:-$(basename "$PROJECT_ROOT")}"
supabase_project_id="${base_project_id}-test-$(date +%s)-$$"
supabase_workdir="$(mktemp -d)"
start_log="$(mktemp)"

cleanup_supabase_project() {
    docker rm -f \
        "supabase_db_${supabase_project_id}" \
        "supabase_kong_${supabase_project_id}" \
        "supabase_auth_${supabase_project_id}" \
        "supabase_rest_${supabase_project_id}" \
        "supabase_storage_${supabase_project_id}" \
        "supabase_realtime_${supabase_project_id}" \
        "supabase_inbucket_${supabase_project_id}" \
        "supabase_mailpit_${supabase_project_id}" \
        "supabase_imgproxy_${supabase_project_id}" \
        "supabase_pg_meta_${supabase_project_id}" \
        "supabase_studio_${supabase_project_id}" \
        "supabase_edge_runtime_${supabase_project_id}" \
        "supabase_analytics_${supabase_project_id}" \
        "supabase_vector_${supabase_project_id}" \
        "supabase_pooler_${supabase_project_id}" >/dev/null 2>&1 || true
    docker volume rm \
        "supabase_db_${supabase_project_id}" \
        "supabase_storage_${supabase_project_id}" >/dev/null 2>&1 || true
    docker network rm "supabase_network_${supabase_project_id}" >/dev/null 2>&1 || true
}

wait_for_supabase_ports_to_close() {
    local port

    for port in \
        "${SUPABASE_API_PORT:-}" \
        "${SUPABASE_DB_PORT:-}" \
        "${SUPABASE_STUDIO_PORT:-}" \
        "${SUPABASE_INBUCKET_PORT:-}" \
        "${SUPABASE_DB_SHADOW_PORT:-}"; do
        if [ -n "$port" ]; then
            test_env_wait_for_port_close "$port" "Supabase"
        fi
    done
}

release_supabase_port_locks() {
    rm -rf \
        "${TEST_SUPABASE_API_PORT_LOCK_DIR:-}" \
        "${TEST_SUPABASE_DB_PORT_LOCK_DIR:-}" \
        "${TEST_SUPABASE_STUDIO_PORT_LOCK_DIR:-}" \
        "${TEST_SUPABASE_INBUCKET_PORT_LOCK_DIR:-}" \
        "${TEST_SUPABASE_DB_SHADOW_PORT_LOCK_DIR:-}"
}

# shellcheck disable=SC2329
cleanup() {
    set +e
    rm -f "$start_log"
    if [ "${SUPABASE_KEEP_RUNNING:-}" = "1" ]; then
        echo "Supabase test stack kept with SUPABASE_WORKDIR=$supabase_workdir" >&2
        release_supabase_port_locks
        return
    fi
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
    rm -rf "$supabase_workdir"
    release_supabase_port_locks
}
trap cleanup EXIT

resolve_supabase_port() {
    local label="$1"
    local output_var="$2"
    local override_var="$3"
    local preferred_port="${!override_var:-$4}"
    local max_port
    local lock_namespace="$5"
    local lock_var="$6"
    local runtime_active="${TEST_RUNTIME_ACTIVE:-}"

    test_env_validate_port "$preferred_port" "$override_var"
    if [ -n "${!override_var:-}" ]; then
        max_port="$preferred_port"
    else
        max_port=$((preferred_port + 100))
    fi

    unset TEST_RUNTIME_ACTIVE
    test_env_resolve_port \
        "$label" \
        "$output_var" \
        "$preferred_port" \
        "$max_port" \
        "$lock_namespace" \
        "$lock_var"
    if [ -n "$runtime_active" ]; then
        export TEST_RUNTIME_ACTIVE="$runtime_active"
    fi
}

resolve_supabase_port \
    "Supabase API" \
    SUPABASE_API_PORT \
    TEST_SUPABASE_API_PORT \
    54321 \
    "nexus-test-supabase-api-port-locks" \
    TEST_SUPABASE_API_PORT_LOCK_DIR
resolve_supabase_port \
    "Supabase database" \
    SUPABASE_DB_PORT \
    TEST_SUPABASE_DB_PORT \
    54322 \
    "nexus-test-supabase-db-port-locks" \
    TEST_SUPABASE_DB_PORT_LOCK_DIR
resolve_supabase_port \
    "Supabase Studio" \
    SUPABASE_STUDIO_PORT \
    TEST_SUPABASE_STUDIO_PORT \
    54323 \
    "nexus-test-supabase-studio-port-locks" \
    TEST_SUPABASE_STUDIO_PORT_LOCK_DIR
resolve_supabase_port \
    "Supabase inbucket" \
    SUPABASE_INBUCKET_PORT \
    TEST_SUPABASE_INBUCKET_PORT \
    54324 \
    "nexus-test-supabase-inbucket-port-locks" \
    TEST_SUPABASE_INBUCKET_PORT_LOCK_DIR
resolve_supabase_port \
    "Supabase shadow database" \
    SUPABASE_DB_SHADOW_PORT \
    TEST_SUPABASE_DB_SHADOW_PORT \
    54325 \
    "nexus-test-supabase-shadow-port-locks" \
    TEST_SUPABASE_DB_SHADOW_PORT_LOCK_DIR

export SUPABASE_PROJECT_ID="$supabase_project_id" SUPABASE_WORKDIR="$supabase_workdir"
export SUPABASE_URL="http://127.0.0.1:${SUPABASE_API_PORT}"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
mkdir -p "$supabase_workdir/supabase"
cp "$PROJECT_ROOT/supabase/config.toml" "$supabase_workdir/supabase/config.toml"
node - "$supabase_workdir/supabase/config.toml" <<'NODE'
const fs = require("node:fs");

const configPath = process.argv[2];
const webPort = process.env.WEB_PORT || "3000";
let text = fs.readFileSync(configPath, "utf-8");

function replaceRequired(pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Missing Supabase config key ${label}`);
  }
  text = text.replace(pattern, replacement);
}

function setPort(section, key, envKey) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\[${escaped}\\][\\s\\S]*?\\n${key}\\s*=\\s*)\\d+`);
  replaceRequired(pattern, `$1${process.env[envKey]}`, `${section}.${key}`);
}

function setString(section, key, value) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\[${escaped}\\][\\s\\S]*?\\n${key}\\s*=\\s*)"[^"]*"`);
  replaceRequired(pattern, `$1"${value}"`, `${section}.${key}`);
}

replaceRequired(
  /^project_id = ".*"$/m,
  `project_id = "${process.env.SUPABASE_PROJECT_ID}"`,
  "project_id",
);
setPort("api", "port", "SUPABASE_API_PORT");
setPort("db", "port", "SUPABASE_DB_PORT");
setPort("db", "shadow_port", "SUPABASE_DB_SHADOW_PORT");
setPort("studio", "port", "SUPABASE_STUDIO_PORT");
setPort("inbucket", "port", "SUPABASE_INBUCKET_PORT");
setString("auth", "jwt_issuer", `http://127.0.0.1:${process.env.SUPABASE_API_PORT}/auth/v1`);
setString("auth", "site_url", `http://localhost:${webPort}`);
replaceRequired(
  /additional_redirect_urls\s*=\s*\[[\s\S]*?\]/,
  [
    "additional_redirect_urls = [",
    `  "http://localhost:${webPort}/auth/callback",`,
    `  "http://127.0.0.1:${webPort}/auth/callback",`,
    `  "http://10.0.2.2:${webPort}/auth/callback",`,
    "]",
  ].join("\n"),
  "auth.additional_redirect_urls",
);
fs.writeFileSync(configPath, text);
NODE

if [ "${SUPABASE_KEEP_RUNNING:-}" != "1" ]; then
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
fi
# Test suites use Supabase Auth only. App data uses test Postgres and S3-compatible object storage.
for attempt in 1 2; do
    if ! supabase --workdir "$supabase_workdir" start \
        -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,postgrest \
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
        db_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_db_${supabase_project_id}" 2>/dev/null || true)
        auth_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_auth_${supabase_project_id}" 2>/dev/null || true)
        kong_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "supabase_kong_${supabase_project_id}" 2>/dev/null || true)
        if [ "$db_health" = "healthy" ] &&
            [ "$auth_health" = "healthy" ] &&
            [ "$kong_health" = "healthy" ]; then
            break 2
        fi
        sleep 1
    done

    if [ "$attempt" = "2" ]; then
        echo "Error: Supabase core containers did not become healthy." >&2
        docker ps -a --format '{{.Names}} {{.Status}}' | grep "supabase_.*_${supabase_project_id}" >&2 || true
        exit 1
    fi

    echo "Supabase core containers did not settle; clearing partial local stack before retry..." >&2
    cleanup_supabase_project
    wait_for_supabase_ports_to_close
done

resolver_args=(--print-shell)
if [ "$require_admin" = "1" ]; then
    resolver_args+=(--require-admin)
fi
test_env_require_tool node
eval "$(node e2e/supabase-env.cjs "${resolver_args[@]}")"
export E2E_MAILBOX_URL="http://127.0.0.1:${SUPABASE_INBUCKET_PORT}"

status=0
"$@" || status=$?
exit $status
