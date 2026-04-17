#!/usr/bin/env bash
set -euo pipefail

# Shared test environment setup for hermetic runs.

TEST_ENV_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_env_require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: $1 is required but not installed." >&2
        exit 1
    fi
}

test_env_resolve_ports() {
    local preferred_port
    local port
    local max_port
    local lock_root
    local lock_dir
    local owner_pid

    if [ -n "${POSTGRES_PORT:-}" ]; then
        export POSTGRES_PORT
        return
    fi

    test_env_require_tool lsof

    preferred_port=5432
    if [ -n "${TEST_POSTGRES_PORT:-}" ]; then
        preferred_port="$TEST_POSTGRES_PORT"
    fi

    lock_root="${TMPDIR:-/tmp}/nexus-test-port-locks"
    mkdir -p "$lock_root"

    port="$preferred_port"
    max_port=$((preferred_port + 100))

    while [ "$port" -le "$max_port" ]; do
        lock_dir="$lock_root/$port"

        if mkdir "$lock_dir" 2>/dev/null; then
            printf '%s\n' "$$" > "$lock_dir/pid"

            if ! lsof -i ":$port" >/dev/null 2>&1; then
                POSTGRES_PORT="$port"
                TEST_POSTGRES_PORT_LOCK_DIR="$lock_dir"
                export POSTGRES_PORT TEST_POSTGRES_PORT_LOCK_DIR
                if [ "$port" -ne "$preferred_port" ]; then
                    echo "Note: postgres port $preferred_port in use, using $port instead" >&2
                fi
                return
            fi

            rm -rf "$lock_dir"
        else
            owner_pid=""
            if [ -f "$lock_dir/pid" ]; then
                owner_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
            fi
            if [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; then
                rm -rf "$lock_dir"
                continue
            fi
        fi

        port=$((port + 1))
    done

    echo "Error: Could not find available port for postgres starting from $preferred_port" >&2
    exit 1
}

test_env_export_db_urls() {
    if [ -z "${POSTGRES_PORT:-}" ]; then
        echo "Error: POSTGRES_PORT not set (call test_env_resolve_ports first)" >&2
        exit 1
    fi

    export DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test"
    export DATABASE_URL_TEST="$DATABASE_URL"
    export DATABASE_URL_TEST_MIGRATIONS="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test_migrations"
    export NEXUS_ENV="test"
}

test_env_export_makeflags() {
    export MAKEFLAGS="${MAKEFLAGS:-} -e"
}

test_env_export_supabase_env() {
    test_env_require_tool supabase

    # Filter out "Stopped services:" line that appears before JSON on some versions.
    SUPABASE_STATUS=$(supabase status --output json 2>&1 | grep -v '^Stopped services:')

    SUPABASE_URL=$(echo "$SUPABASE_STATUS" | grep -o '"API_URL": *"[^"]*"' | sed 's/"API_URL": *"//;s/"$//')
    SUPABASE_ANON_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"ANON_KEY": *"[^"]*"' | sed 's/"ANON_KEY": *"//;s/"$//')
    SUPABASE_SERVICE_ROLE_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"SERVICE_ROLE_KEY": *"[^"]*"' | sed 's/"SERVICE_ROLE_KEY": *"//;s/"$//')

    if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
        echo "Error: Failed to extract Supabase configuration" >&2
        echo "Status output: $SUPABASE_STATUS" >&2
        exit 1
    fi

    export SUPABASE_URL
    export SUPABASE_ANON_KEY
    export SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
    export SUPABASE_JWKS_URL="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
    export SUPABASE_ISSUER="${SUPABASE_URL}/auth/v1"
    export SUPABASE_AUDIENCES="${SUPABASE_AUDIENCES:-authenticated}"
}

test_env_export_storage_prefix() {
    if [ -z "${STORAGE_TEST_PREFIX:-}" ]; then
        STORAGE_TEST_PREFIX="test_runs/${TEST_RUN_ID:-$(date +%s)-$$}/"
        export STORAGE_TEST_PREFIX
    fi
}
