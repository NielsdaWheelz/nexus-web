#!/usr/bin/env bash
set -euo pipefail

# Shared test environment setup for hermetic runs.

test_env_require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: $1 is required but not installed." >&2
        exit 1
    fi
}

test_env_port_is_busy() {
    local port="$1"

    if lsof -nP -i ":$port" >/dev/null 2>&1; then
        return 0
    fi
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq "(^|[ ,])([0-9.]+|\\[::\\]):$port->"; then
        return 0
    fi
    return 1
}

test_env_resolve_ports() {
    local preferred_port
    local port
    local max_port
    local lock_root
    local lock_dir
    local owner_pid

    if [ -n "${POSTGRES_PORT:-}" ] && [ "${TEST_RUNTIME_ACTIVE:-}" = "1" ]; then
        export POSTGRES_PORT
        return
    fi

    test_env_require_tool lsof

    if [ -n "${TEST_POSTGRES_PORT:-}" ]; then
        preferred_port="$TEST_POSTGRES_PORT"
        max_port="$TEST_POSTGRES_PORT"
    else
        preferred_port=5432
        max_port=$((preferred_port + 100))
    fi
    case "$preferred_port" in
        ""|*[!0-9]*)
            echo "Error: TEST_POSTGRES_PORT must be a numeric port" >&2
            exit 1
            ;;
    esac

    lock_root="${TMPDIR:-/tmp}/nexus-test-port-locks"
    mkdir -p "$lock_root"

    port="$preferred_port"

    while [ "$port" -le "$max_port" ]; do
        lock_dir="$lock_root/$port"

        if mkdir "$lock_dir" 2>/dev/null; then
            printf '%s\n' "$$" > "$lock_dir/pid"

            if ! test_env_port_is_busy "$port"; then
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

    if [ -n "${TEST_POSTGRES_PORT:-}" ]; then
        echo "Error: TEST_POSTGRES_PORT $TEST_POSTGRES_PORT is not available" >&2
    else
        echo "Error: Could not find available port for postgres starting from $preferred_port" >&2
    fi
    exit 1
}

test_env_resolve_minio_port() {
    local preferred_port
    local port
    local max_port
    local lock_root
    local lock_dir
    local owner_pid

    if [ -n "${MINIO_PORT:-}" ] && [ "${TEST_RUNTIME_ACTIVE:-}" = "1" ]; then
        export MINIO_PORT
        return
    fi

    test_env_require_tool lsof

    if [ -n "${TEST_MINIO_PORT:-}" ]; then
        preferred_port="$TEST_MINIO_PORT"
        max_port="$TEST_MINIO_PORT"
    else
        preferred_port=9000
        max_port=$((preferred_port + 100))
    fi
    case "$preferred_port" in
        ""|*[!0-9]*)
            echo "Error: TEST_MINIO_PORT must be a numeric port" >&2
            exit 1
            ;;
    esac

    lock_root="${TMPDIR:-/tmp}/nexus-test-minio-port-locks"
    mkdir -p "$lock_root"

    port="$preferred_port"

    while [ "$port" -le "$max_port" ]; do
        lock_dir="$lock_root/$port"

        if mkdir "$lock_dir" 2>/dev/null; then
            printf '%s\n' "$$" > "$lock_dir/pid"

            if ! test_env_port_is_busy "$port"; then
                MINIO_PORT="$port"
                TEST_MINIO_PORT_LOCK_DIR="$lock_dir"
                export MINIO_PORT TEST_MINIO_PORT_LOCK_DIR
                if [ "$port" -ne "$preferred_port" ]; then
                    echo "Note: MinIO port $preferred_port in use, using $port instead" >&2
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

    if [ -n "${TEST_MINIO_PORT:-}" ]; then
        echo "Error: TEST_MINIO_PORT $TEST_MINIO_PORT is not available" >&2
    else
        echo "Error: Could not find available port for MinIO starting from $preferred_port" >&2
    fi
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

test_env_export_r2_env() {
    if [ -z "${MINIO_PORT:-}" ]; then
        echo "Error: MINIO_PORT not set (call test_env_resolve_minio_port first)" >&2
        exit 1
    fi

    export R2_ENDPOINT_URL="http://127.0.0.1:${MINIO_PORT}"
    export R2_ACCESS_KEY_ID="nexus-test-access-key"
    export R2_SECRET_ACCESS_KEY="nexus-test-secret-key"
    export R2_BUCKET="media"
    export R2_REGION="us-east-1"
}

test_env_export_makeflags() {
    unset SERVICE_ROLE_KEY SUPABASE_AUTH_ADMIN_KEY SUPABASE_DATABASE_URL SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY
    export MAKEFLAGS="${MAKEFLAGS:-} -e"
}

test_env_export_supabase_env() {
    test_env_require_tool supabase

    # Filter out "Stopped services:" line that appears before JSON on some versions.
    SUPABASE_STATUS=$(supabase status --output json 2>&1 | grep -v '^Stopped services:')

    SUPABASE_URL=$(printf '%s\n' "$SUPABASE_STATUS" | grep -o '"API_URL": *"[^"]*"' | sed 's/"API_URL": *"//;s/"$//' || true)
    if [ -z "$SUPABASE_URL" ]; then
        supabase_api_port=$(awk '
            /^\[api\]/ { in_api = 1; next }
            /^\[/ { in_api = 0 }
            in_api && /^[[:space:]]*port[[:space:]]*=/ {
                gsub(/[^0-9]/, "", $0)
                print
                exit
            }
        ' "${PROJECT_ROOT:-$(pwd)}/supabase/config.toml")
        SUPABASE_URL="http://127.0.0.1:${supabase_api_port:-54321}"
    fi
    SUPABASE_ANON_KEY=$(printf '%s\n' "$SUPABASE_STATUS" | grep -o '"ANON_KEY": *"[^"]*"' | sed 's/"ANON_KEY": *"//;s/"$//' || true)
    if [ -z "$SUPABASE_ANON_KEY" ]; then
        SUPABASE_ANON_KEY=$(printf '%s\n' "$SUPABASE_STATUS" | grep -o '"PUBLISHABLE_KEY": *"[^"]*"' | sed 's/"PUBLISHABLE_KEY": *"//;s/"$//' || true)
    fi
    if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
        echo "Error: Failed to extract Supabase configuration" >&2
        echo "Status output: $SUPABASE_STATUS" >&2
        exit 1
    fi

    unset SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY
    export SUPABASE_URL
    export SUPABASE_ANON_KEY
    export SUPABASE_JWKS_URL="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
    export SUPABASE_ISSUER="${SUPABASE_URL}/auth/v1"
    export SUPABASE_AUDIENCES="${SUPABASE_AUDIENCES:-authenticated}"
}
