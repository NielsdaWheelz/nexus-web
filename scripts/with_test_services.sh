#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.test.yml"
source "$SCRIPT_DIR/test_env.sh"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <command...>" >&2
    exit 1
fi

if [ "${TEST_RUNTIME_ACTIVE:-}" = "1" ]; then
    test_env_export_db_urls
    test_env_export_r2_env
    test_env_export_app_urls
    test_env_export_makeflags

    status=0
    "$@" || status=$?
    exit $status
fi

test_env_resolve_ports
test_env_resolve_minio_port
test_env_resolve_app_ports
test_env_export_app_urls

COMPOSE_PROJECT_NAME="nexus-test-$(date +%s)-$$"
export COMPOSE_PROJECT_NAME POSTGRES_PORT MINIO_PORT API_PORT WEB_PORT TEST_RUNTIME_ACTIVE=1

# shellcheck disable=SC2329
cleanup() {
    set +e
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null
    test_env_wait_for_port_close "$POSTGRES_PORT" "postgres"
    test_env_wait_for_port_close "$MINIO_PORT" "MinIO"
    test_env_cleanup_owned_app_port "$API_PORT" "api"
    test_env_cleanup_owned_app_port "$WEB_PORT" "web"
    if [ -n "${TEST_POSTGRES_PORT_LOCK_DIR:-}" ]; then
        rm -rf "$TEST_POSTGRES_PORT_LOCK_DIR"
    fi
    if [ -n "${TEST_MINIO_PORT_LOCK_DIR:-}" ]; then
        rm -rf "$TEST_MINIO_PORT_LOCK_DIR"
    fi
    if [ -n "${TEST_API_PORT_LOCK_DIR:-}" ]; then
        rm -rf "$TEST_API_PORT_LOCK_DIR"
    fi
    if [ -n "${TEST_WEB_PORT_LOCK_DIR:-}" ]; then
        rm -rf "$TEST_WEB_PORT_LOCK_DIR"
    fi
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" up -d

postgres_container="$(docker compose -f "$COMPOSE_FILE" ps -q postgres)"

test_env_require_tool curl
test_env_require_tool python3

# pg_isready confirms Postgres is ready inside the container; test_env_tcp_accepts
# then confirms the published host port the app actually connects through is live.
test_env_wait_until "postgres" 30 1 docker exec "$postgres_container" pg_isready -U postgres
test_env_wait_until "postgres host port" 120 0.25 test_env_tcp_accepts "$POSTGRES_PORT"
test_env_wait_until "MinIO" 30 1 \
    curl -fsS "http://127.0.0.1:${MINIO_PORT}/minio/health/ready"

docker exec "$postgres_container" createdb -U postgres nexus_test >/dev/null 2>&1 || true
docker exec "$postgres_container" createdb -U postgres nexus_test_migrations >/dev/null 2>&1 || true

test_env_export_db_urls
test_env_export_r2_env
test_env_export_app_urls
test_env_export_makeflags

(
    cd "$PROJECT_ROOT/python"
    uv run python - <<'PY'
import os

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_S3_API_ORIGIN"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name=os.environ["R2_REGION"],
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
    ),
)
try:
    s3.create_bucket(Bucket=os.environ["R2_BUCKET"])
except ClientError as exc:
    code = exc.response.get("Error", {}).get("Code")
    if code not in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
        raise
PY
)

status=0
"$@" || status=$?
exit $status
