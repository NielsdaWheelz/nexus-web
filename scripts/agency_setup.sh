#!/usr/bin/env bash
set -euo pipefail

# Nexus project setup script
# Installs dependencies and prepares the development environment
#
# Prerequisites:
#   - Docker running
#   - Supabase CLI installed (brew install supabase/tap/supabase)
#   - Ports 54321-54324 free for Supabase
#
# Environment variables:
#   REDIS_PORT - Host port for redis (default: auto-detect available)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Derive unique project name from directory for container isolation
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

# Fixed Supabase ports (from supabase/config.toml)
SUPABASE_API_PORT=54321
SUPABASE_DB_PORT=54322

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

# Use provided redis port or find available one
if [ -n "${REDIS_PORT:-}" ]; then
    export REDIS_PORT
else
    export REDIS_PORT=$(find_available_port 6379)
fi

echo "=== Nexus Project Setup ==="
echo ""
echo "Project: $PROJECT_NAME"
echo "Supabase API port: $SUPABASE_API_PORT"
echo "Supabase DB port: $SUPABASE_DB_PORT"
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
check_tool node
check_tool npm
check_tool supabase
echo "Required tools found"
echo ""

# Container names (derived from compose project name)
REDIS_CONTAINER="${PROJECT_NAME}-redis-1"

# Start Supabase local
echo "Starting Supabase local..."
cd "$PROJECT_ROOT"
supabase start
echo "Supabase local started"
echo ""

# Get Supabase status as JSON for extracting values
echo "Getting Supabase configuration..."
# Filter out "Stopped services:" line that appears before JSON on some versions
SUPABASE_STATUS=$(supabase status --output json 2>&1 | grep -v '^Stopped services:')

# Extract values using grep and sed (portable, no jq dependency)
# Handle both compact JSON ("key":"value") and pretty JSON ("key": "value")
SUPABASE_URL=$(echo "$SUPABASE_STATUS" | grep -o '"API_URL": *"[^"]*"' | sed 's/"API_URL": *"//;s/"$//')
SUPABASE_ANON_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"ANON_KEY": *"[^"]*"' | sed 's/"ANON_KEY": *"//;s/"$//')
SUPABASE_SERVICE_ROLE_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"SERVICE_ROLE_KEY": *"[^"]*"' | sed 's/"SERVICE_ROLE_KEY": *"//;s/"$//')

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "Error: Failed to extract Supabase configuration"
    echo "Status output: $SUPABASE_STATUS"
    exit 1
fi

echo "Supabase URL: $SUPABASE_URL"
echo ""

# Find Supabase DB container and create test databases
echo "Creating test databases..."
DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep -m 1 '^supabase_db_' || true)
if [ -z "$DB_CONTAINER" ]; then
    echo "Error: Could not find Supabase DB container"
    exit 1
fi
docker exec "$DB_CONTAINER" createdb -U postgres nexus_test 2>/dev/null || true
docker exec "$DB_CONTAINER" createdb -U postgres nexus_test_migrations 2>/dev/null || true
echo "Test databases ready (nexus_test, nexus_test_migrations)"
echo ""

# Start Redis
echo "Starting Redis..."
cd "$PROJECT_ROOT/docker"

# Check if Redis container is already running
if docker ps --format '{{.Names}}' | grep -q "^${REDIS_CONTAINER}$"; then
    echo "Redis container already running (reusing)"
else
    docker compose up -d
fi
echo "Redis started"
echo ""

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
for i in {1..30}; do
    if docker exec "$REDIS_CONTAINER" redis-cli ping &> /dev/null; then
        echo "Redis is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Error: Redis did not become ready in time"
        exit 1
    fi
    sleep 1
done
echo ""

# Install python dependencies
echo "Installing python dependencies..."
cd "$PROJECT_ROOT/python"
uv sync --all-extras
echo "Python dependencies installed"
echo ""

# Install frontend dependencies
echo "Installing frontend dependencies..."
cd "$PROJECT_ROOT/apps/web"
npm install
echo "Frontend dependencies installed"
echo ""

# Install node ingest worker dependencies (Playwright + Readability)
echo "Installing node ingest worker dependencies..."
cd "$PROJECT_ROOT/node/ingest"
npm install
echo "Installing Playwright browsers (Chromium)..."
npx playwright install chromium
echo "Node ingest worker dependencies installed"
echo ""

# Database URLs using Supabase local Postgres
DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/postgres"
DATABASE_URL_TEST="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/nexus_test"
DATABASE_URL_TEST_MIGRATIONS="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/nexus_test_migrations"
REDIS_URL="redis://localhost:${REDIS_PORT}/0"

# Derived Supabase auth settings
SUPABASE_ISSUER="${SUPABASE_URL}/auth/v1"
SUPABASE_JWKS_URL="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
SUPABASE_AUDIENCES="authenticated"

# Run migrations on dev database (using default 'postgres' db)
echo "Running migrations on dev database..."
cd "$PROJECT_ROOT/migrations"
DATABASE_URL="${DATABASE_URL}" \
    uv run --project ../python alembic upgrade head
echo "Migrations applied to postgres (dev)"

# Run migrations on test database
echo "Running migrations on test database..."
DATABASE_URL="${DATABASE_URL_TEST}" \
    uv run --project ../python alembic upgrade head
echo "Migrations applied to nexus_test"

# Run migrations on test_migrations database
echo "Running migrations on test_migrations database..."
DATABASE_URL="${DATABASE_URL_TEST_MIGRATIONS}" \
    uv run --project ../python alembic upgrade head
echo "Migrations applied to nexus_test_migrations"
echo ""

# Generate .env file for local development
echo "Creating .env file..."
cat > "$PROJECT_ROOT/.env" << EOF
# Nexus local development configuration
# Created by: make setup
# Do not commit this file (it's in .gitignore)

# Infrastructure ports
REDIS_PORT=${REDIS_PORT}

# Application config
NEXUS_ENV=local
DATABASE_URL=${DATABASE_URL}
DATABASE_URL_TEST=${DATABASE_URL_TEST}
DATABASE_URL_TEST_MIGRATIONS=${DATABASE_URL_TEST_MIGRATIONS}
REDIS_URL=${REDIS_URL}

# Supabase local configuration
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_ROLE_KEY}

# Supabase auth settings (used by FastAPI)
SUPABASE_ISSUER=${SUPABASE_ISSUER}
SUPABASE_JWKS_URL=${SUPABASE_JWKS_URL}
SUPABASE_AUDIENCES=${SUPABASE_AUDIENCES}
EOF
echo "Created .env file"
echo ""

# Generate apps/web/.env.local for frontend
echo "Creating apps/web/.env.local..."
cat > "$PROJECT_ROOT/apps/web/.env.local" << EOF
# Nexus frontend local development configuration
# Created by: make setup
# Do not commit this file (it's in .gitignore)

FASTAPI_BASE_URL=http://localhost:8000
NEXUS_ENV=local
NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
EOF
echo "Created apps/web/.env.local"
echo ""

# Verification step
echo "=== Verifying Setup ==="
cd "$PROJECT_ROOT/python"

echo "Running quick sanity check..."
if DATABASE_URL="${DATABASE_URL_TEST}" NEXUS_ENV=test \
    SUPABASE_JWKS_URL="${SUPABASE_JWKS_URL}" \
    SUPABASE_ISSUER="${SUPABASE_ISSUER}" \
    SUPABASE_AUDIENCES="${SUPABASE_AUDIENCES}" \
    uv run pytest tests/test_db.py -v -q --tb=short 2>/dev/null; then
    echo "Database connectivity verified"
else
    echo "Warning: Database sanity check failed"
    echo "  Setup completed but verification failed. Check logs above."
    exit 1
fi
echo ""

echo "=== Setup Complete ==="
echo ""
echo "To start the API server:"
echo "  make api"
echo ""
echo "To start the web frontend:"
echo "  make web"
echo ""
echo "To run tests:"
echo "  make test"
echo ""
echo "API docs: http://localhost:8000/docs"
echo "Supabase Studio: http://localhost:54323"
