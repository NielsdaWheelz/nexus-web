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

test_env_resolve_ports

COMPOSE_PROJECT_NAME="nexus-test-$(date +%s)-$$"
export COMPOSE_PROJECT_NAME POSTGRES_PORT REDIS_PORT

cleanup() {
    set +e
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" up -d

postgres_container="$(docker compose -f "$COMPOSE_FILE" ps -q postgres)"
redis_container="$(docker compose -f "$COMPOSE_FILE" ps -q redis)"

for i in {1..30}; do
    if docker exec "$postgres_container" pg_isready -U postgres >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "Error: Postgres did not become ready in time" >&2
        exit 1
    fi
    sleep 1
done

for i in {1..30}; do
    if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "Error: Redis did not become ready in time" >&2
        exit 1
    fi
    sleep 1
done

docker exec "$postgres_container" createdb -U postgres nexus_test >/dev/null 2>&1 || true
docker exec "$postgres_container" createdb -U postgres nexus_test_migrations >/dev/null 2>&1 || true

test_env_export_db_urls
test_env_export_makeflags

status=0
"$@" || status=$?
exit $status
