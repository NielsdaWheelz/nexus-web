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

    test_env_require_tool python3

    if python3 - "$port" <<'PY'
import errno
import socket
import sys

try:
    port = int(sys.argv[1])
except (IndexError, ValueError):
    sys.exit(1)

if port < 1 or port > 65535:
    sys.exit(1)

targets = [(socket.AF_INET, "127.0.0.1")]
if socket.has_ipv6:
    targets.append((socket.AF_INET6, "::1"))

checked = 0
for family, host in targets:
    sock = None
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock.bind((host, port))
        checked += 1
    except OSError as exc:
        if family == socket.AF_INET6 and exc.errno in {
            errno.EAFNOSUPPORT,
            errno.EADDRNOTAVAIL,
            getattr(errno, "EPROTONOSUPPORT", 93),
        }:
            continue
        sys.exit(1)
    finally:
        if sock is not None:
            sock.close()

sys.exit(0 if checked else 1)
PY
    then
        return 1
    fi
    return 0
}

test_env_validate_port() {
    local port
    local label

    port="$1"
    label="$2"

    case "$port" in
        ""|*[!0-9]*)
            echo "Error: $label must be a numeric port" >&2
            exit 1
            ;;
    esac
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        echo "Error: $label must be between 1 and 65535" >&2
        exit 1
    fi
}

test_env_resolve_port() {
    local service_name
    local output_var
    local preferred_port
    local max_port
    local lock_namespace
    local lock_var
    local current_value
    local port
    local lock_root
    local lock_dir
    local owner_pid

    service_name="$1"
    output_var="$2"
    preferred_port="$3"
    max_port="$4"
    lock_namespace="$5"
    lock_var="$6"

    current_value="${!output_var:-}"
    if [ -n "$current_value" ] && [ "${TEST_RUNTIME_ACTIVE:-}" = "1" ]; then
        export "$output_var"
        return
    fi

    test_env_validate_port "$preferred_port" "$output_var"
    if [ "$max_port" -gt 65535 ]; then
        max_port=65535
    fi
    test_env_validate_port "$max_port" "$output_var max"
    if [ "$max_port" -lt "$preferred_port" ]; then
        max_port="$preferred_port"
    fi

    lock_root="${TMPDIR:-/tmp}/$lock_namespace"
    mkdir -p "$lock_root"

    port="$preferred_port"

    while [ "$port" -le "$max_port" ]; do
        lock_dir="$lock_root/$port"

        if mkdir "$lock_dir" 2>/dev/null; then
            printf '%s\n' "$$" > "$lock_dir/pid"

            if ! test_env_port_is_busy "$port"; then
                printf -v "$output_var" '%s' "$port"
                printf -v "$lock_var" '%s' "$lock_dir"
                export "$output_var" "$lock_var"
                if [ "$port" -ne "$preferred_port" ]; then
                    echo "Note: $service_name port $preferred_port in use, using $port instead" >&2
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

    if [ "$max_port" -eq "$preferred_port" ]; then
        echo "Error: $service_name port $preferred_port is not available" >&2
    else
        echo "Error: Could not find available port for $service_name starting from $preferred_port" >&2
    fi
    exit 1
}

test_env_resolve_ports() {
    local preferred_port
    local max_port

    preferred_port="${TEST_POSTGRES_PORT:-5432}"
    test_env_validate_port "$preferred_port" "TEST_POSTGRES_PORT"
    if [ -n "${TEST_POSTGRES_PORT:-}" ]; then
        max_port="$preferred_port"
    else
        max_port=$((preferred_port + 100))
    fi
    test_env_resolve_port \
        "postgres" \
        POSTGRES_PORT \
        "$preferred_port" \
        "$max_port" \
        "nexus-test-postgres-port-locks" \
        TEST_POSTGRES_PORT_LOCK_DIR
}

test_env_resolve_minio_port() {
    local preferred_port
    local max_port

    preferred_port="${TEST_MINIO_PORT:-9000}"
    test_env_validate_port "$preferred_port" "TEST_MINIO_PORT"
    if [ -n "${TEST_MINIO_PORT:-}" ]; then
        max_port="$TEST_MINIO_PORT"
    else
        max_port=$((preferred_port + 100))
    fi
    test_env_resolve_port \
        "MinIO" \
        MINIO_PORT \
        "$preferred_port" \
        "$max_port" \
        "nexus-test-minio-port-locks" \
        TEST_MINIO_PORT_LOCK_DIR
}

test_env_resolve_api_port() {
    local preferred_port
    local max_port

    preferred_port="${TEST_API_PORT:-${API_PORT:-8000}}"
    test_env_validate_port "$preferred_port" "TEST_API_PORT/API_PORT"
    if [ -n "${TEST_API_PORT:-}" ]; then
        max_port="$preferred_port"
    else
        max_port=$((preferred_port + 100))
    fi
    test_env_resolve_port \
        "api" \
        API_PORT \
        "$preferred_port" \
        "$max_port" \
        "nexus-test-api-port-locks" \
        TEST_API_PORT_LOCK_DIR
}

test_env_resolve_web_port() {
    local preferred_port
    local max_port

    preferred_port="${TEST_WEB_PORT:-${WEB_PORT:-3000}}"
    test_env_validate_port "$preferred_port" "TEST_WEB_PORT/WEB_PORT"
    if [ -n "${TEST_WEB_PORT:-}" ]; then
        max_port="$preferred_port"
    else
        max_port=$((preferred_port + 100))
    fi
    test_env_resolve_port \
        "web" \
        WEB_PORT \
        "$preferred_port" \
        "$max_port" \
        "nexus-test-web-port-locks" \
        TEST_WEB_PORT_LOCK_DIR
}

test_env_resolve_app_ports() {
    test_env_resolve_api_port
    test_env_resolve_web_port
}

test_env_wait_for_port_close() {
    local port="$1"
    local label="${2:-service}"
    local i

    for i in {1..80}; do
        if ! test_env_port_is_busy "$port"; then
            return
        fi
        sleep 0.25
    done
    echo "Warning: $label port $port was still busy after cleanup" >&2
}

test_env_port_listener_pids() {
    local port="$1"

    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true
        return
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -H -ltnp "sport = :$port" 2>/dev/null \
            | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
            | sort -u || true
    fi
}

test_env_stop_port_listeners() {
    local port="$1"
    local label="${2:-service}"
    local pids
    local i

    mapfile -t pids < <(test_env_port_listener_pids "$port")
    if [ "${#pids[@]}" -eq 0 ]; then
        return
    fi

    echo "Note: stopping $label listener(s) on port $port: ${pids[*]}" >&2
    kill -TERM "${pids[@]}" 2>/dev/null || true
    for i in {1..40}; do
        if ! test_env_port_is_busy "$port"; then
            return
        fi
        sleep 0.25
    done

    mapfile -t pids < <(test_env_port_listener_pids "$port")
    if [ "${#pids[@]}" -gt 0 ]; then
        echo "Note: force-stopping $label listener(s) on port $port: ${pids[*]}" >&2
        kill -KILL "${pids[@]}" 2>/dev/null || true
    fi
}

test_env_cleanup_owned_app_port() {
    local port="$1"
    local label="${2:-service}"

    if ! test_env_port_is_busy "$port"; then
        return
    fi
    test_env_stop_port_listeners "$port" "$label"
    test_env_wait_for_port_close "$port" "$label"
}

test_env_export_app_urls() {
    if [ -z "${API_PORT:-}" ] || [ -z "${WEB_PORT:-}" ]; then
        echo "Error: API_PORT and WEB_PORT must be set (call test_env_resolve_app_ports first)" >&2
        exit 1
    fi

    export APP_PUBLIC_URL="http://localhost:${WEB_PORT}"
    export FASTAPI_BASE_URL="http://localhost:${API_PORT}"
    export STREAM_BASE_URL="http://localhost:${API_PORT}"
    export STREAM_CORS_ORIGINS="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}"
    export AUTH_ALLOWED_REDIRECT_ORIGINS="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT},http://10.0.2.2:${WEB_PORT}"
    export MINIO_API_CORS_ALLOW_ORIGIN="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}"
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
