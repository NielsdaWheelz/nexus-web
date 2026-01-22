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
    if [ -n "${TEST_POSTGRES_PORT:-}" ]; then
        POSTGRES_PORT="$TEST_POSTGRES_PORT"
    else
        POSTGRES_PORT="$("$TEST_ENV_SCRIPT_DIR/find_port.sh" 5432 postgres)"
    fi

    if [ -n "${TEST_REDIS_PORT:-}" ]; then
        REDIS_PORT="$TEST_REDIS_PORT"
    else
        REDIS_PORT="$("$TEST_ENV_SCRIPT_DIR/find_port.sh" 6379 redis)"
    fi

    export POSTGRES_PORT REDIS_PORT
}

test_env_export_db_urls() {
    if [ -z "${POSTGRES_PORT:-}" ]; then
        echo "Error: POSTGRES_PORT not set (call test_env_resolve_ports first)" >&2
        exit 1
    fi

    export DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test"
    export DATABASE_URL_TEST="$DATABASE_URL"
    export DATABASE_URL_TEST_MIGRATIONS="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test_migrations"
    export REDIS_URL="redis://localhost:${REDIS_PORT}/0"
    export CELERY_BROKER_URL="$REDIS_URL"
    export CELERY_RESULT_BACKEND="$REDIS_URL"
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
