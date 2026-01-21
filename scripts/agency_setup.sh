#!/usr/bin/env bash
set -euo pipefail

# Nexus project setup script
# Installs dependencies and prepares the development environment
#
# Environment variables:
#   POSTGRES_PORT - Host port for postgres (default: auto-detect available)
#   REDIS_PORT - Host port for redis (default: auto-detect available)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Derive unique project name from directory for container isolation
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

# Find an available port starting from a given port
find_available_port() {
    local start_port=$1
    local port=$start_port
    local max_port=$((start_port + 100))

    while [ $port -lt $max_port ]; do
        # Check if port is in use (works on macOS and Linux)
        if ! lsof -i ":$port" >/dev/null 2>&1; then
            echo $port
            return 0
        fi
        port=$((port + 1))
    done

    echo "Error: Could not find available port starting from $start_port" >&2
    return 1
}

# Use provided ports or find available ones
if [ -n "${POSTGRES_PORT:-}" ]; then
    export POSTGRES_PORT
else
    export POSTGRES_PORT=$(find_available_port 5432)
fi

if [ -n "${REDIS_PORT:-}" ]; then
    export REDIS_PORT
else
    export REDIS_PORT=$(find_available_port 6379)
fi

echo "=== Nexus Project Setup ==="
echo ""
echo "Project: $PROJECT_NAME"
echo "Postgres port: $POSTGRES_PORT"
echo "Redis port: $REDIS_PORT"
echo ""

# Check for required tools
check_tool() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: $1 is required but not installed."
        exit 1
    fi
}

echo "Checking required tools..."
check_tool uv
check_tool docker
echo "✓ Required tools found"
echo ""

# Container names (derived from compose project name)
POSTGRES_CONTAINER="${PROJECT_NAME}-postgres-1"
REDIS_CONTAINER="${PROJECT_NAME}-redis-1"

# Start infrastructure services
echo "Starting infrastructure services..."
cd "$PROJECT_ROOT/docker"

# Check if our containers are already running
if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$" && \
   docker ps --format '{{.Names}}' | grep -q "^${REDIS_CONTAINER}$"; then
    echo "✓ Infrastructure containers already running (reusing)"
else
    docker compose up -d
fi
echo "✓ PostgreSQL and Redis started"
echo ""

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres &> /dev/null; then
        echo "✓ PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Error: PostgreSQL did not become ready in time"
        exit 1
    fi
    sleep 1
done
echo ""

# Create test databases if they don't exist
echo "Creating test databases..."
docker exec "$POSTGRES_CONTAINER" createdb -U postgres nexus_test 2>/dev/null || true
docker exec "$POSTGRES_CONTAINER" createdb -U postgres nexus_test_migrations 2>/dev/null || true
echo "✓ Test databases ready (nexus_test, nexus_test_migrations)"
echo ""

# Install python dependencies
echo "Installing python dependencies..."
cd "$PROJECT_ROOT/python"
uv sync --all-extras
echo "✓ Python dependencies installed"
echo ""

# Database URL using configured port
DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}"

# Run migrations on dev database
echo "Running migrations on dev database..."
cd "$PROJECT_ROOT/migrations"
DATABASE_URL="${DATABASE_URL}/nexus_dev" \
    uv run --project ../python alembic upgrade head
echo "✓ Migrations applied to nexus_dev"

# Run migrations on test database
echo "Running migrations on test database..."
DATABASE_URL="${DATABASE_URL}/nexus_test" \
    uv run --project ../python alembic upgrade head
echo "✓ Migrations applied to nexus_test"
echo ""

# Generate .env file for local development
echo "Creating .env file..."
cat > "$PROJECT_ROOT/.env" << EOF
# Nexus local development configuration
# Created by: make setup
# Do not commit this file (it's in .gitignore)

# Infrastructure ports
POSTGRES_PORT=${POSTGRES_PORT}
REDIS_PORT=${REDIS_PORT}

# Application config
NEXUS_ENV=local
DATABASE_URL=${DATABASE_URL}/nexus_dev
EOF
echo "✓ Created .env file"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "To start the API server:"
echo "  make api"
echo ""
echo "To run tests:"
echo "  make test-all"
echo ""
echo "API docs: http://localhost:8000/docs"
