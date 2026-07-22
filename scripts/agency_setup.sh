#!/usr/bin/env bash
set -euo pipefail

# Nexus project setup script
# Installs dependencies and prepares the development environment
#
# Prerequisites:
#   - Docker running
#   - Git installed
#   - Supabase CLI installed (brew install supabase/tap/supabase)
#   - Ports 54321-54324 free for Supabase
#
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Derive unique project name from directory for container isolation
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

# Fixed Supabase ports (from supabase/config.toml)
SUPABASE_API_PORT=54321
SUPABASE_DB_PORT=54322
POSTGRES_PORT="${POSTGRES_PORT:-54320}"
MINIO_PORT="${MINIO_PORT:-9000}"
LOCAL_COMPOSE_PROJECT="${LOCAL_COMPOSE_PROJECT:-nexus-local}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-nexus-local-access-key}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-nexus-local-secret-key}"
R2_BUCKET="${R2_BUCKET:-media}"
R2_REGION="${R2_REGION:-us-east-1}"

echo "=== Nexus Project Setup ==="
echo ""
echo "Project: $PROJECT_NAME"
echo "App Postgres port: $POSTGRES_PORT"
echo "MinIO port: $MINIO_PORT"
echo "Supabase Auth API port: $SUPABASE_API_PORT"
echo "Supabase Auth backing DB port: $SUPABASE_DB_PORT"
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
check_tool git
check_tool docker
check_tool curl
check_tool node
check_tool bun
check_tool supabase
echo "Required tools found"
echo ""

# Start local app data services.
echo "Starting local app data services..."
cd "$PROJECT_ROOT"
POSTGRES_PORT="$POSTGRES_PORT" \
    MINIO_PORT="$MINIO_PORT" \
    R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    R2_BUCKET="$R2_BUCKET" \
    COMPOSE_PROJECT_NAME="$LOCAL_COMPOSE_PROJECT" \
    docker compose -f docker/docker-compose.yml up -d postgres minio minio-init
echo "Local app data services started"
echo ""

echo "Waiting for app Postgres..."
DB_CONTAINER=$(COMPOSE_PROJECT_NAME="$LOCAL_COMPOSE_PROJECT" docker compose -f docker/docker-compose.yml ps -q postgres)
if [ -z "$DB_CONTAINER" ]; then
    echo "Error: Could not find app Postgres container"
    exit 1
fi
for i in $(seq 1 30); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
        break
    fi
    if [ "$i" = "30" ]; then
        echo "Error: App Postgres did not become ready in time"
        exit 1
    fi
    sleep 1
done
echo "App Postgres ready"
echo ""

echo "Waiting for MinIO and bucket initialization..."
for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${MINIO_PORT}/minio/health/ready" >/dev/null 2>&1; then
        break
    fi
    if [ "$i" = "30" ]; then
        echo "Error: MinIO did not become ready in time"
        exit 1
    fi
    sleep 1
done
MINIO_INIT_CONTAINER=$(COMPOSE_PROJECT_NAME="$LOCAL_COMPOSE_PROJECT" docker compose -f docker/docker-compose.yml ps -a -q minio-init)
if [ -z "$MINIO_INIT_CONTAINER" ]; then
    echo "Error: MinIO bucket init container was not created"
    exit 1
fi
MINIO_INIT_EXIT=$(docker wait "$MINIO_INIT_CONTAINER" 2>/dev/null || docker inspect -f '{{.State.ExitCode}}' "$MINIO_INIT_CONTAINER")
if [ "$MINIO_INIT_EXIT" != "0" ]; then
    COMPOSE_PROJECT_NAME="$LOCAL_COMPOSE_PROJECT" docker compose -f docker/docker-compose.yml logs minio-init >&2
    echo "Error: MinIO bucket init failed"
    exit 1
fi
echo "MinIO ready"
echo ""

# Start Supabase local Auth only. Supabase still runs its internal Postgres for
# Auth metadata, but application data does not use Supabase Database or Storage.
echo "Starting Supabase local Auth..."
supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,mailpit,postgrest
echo "Supabase local Auth started"
echo ""

# Get Supabase status as JSON for extracting values
echo "Getting Supabase configuration..."
# Filter out "Stopped services:" line that appears before JSON on some versions
SUPABASE_STATUS=$(supabase status --output json 2>&1 | grep -v '^Stopped services:')

# Extract values using grep and sed (portable, no jq dependency)
# Handle both compact JSON ("key":"value") and pretty JSON ("key": "value")
SUPABASE_URL=$(echo "$SUPABASE_STATUS" | grep -o '"API_URL": *"[^"]*"' | sed 's/"API_URL": *"//;s/"$//' || true)
SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:${SUPABASE_API_PORT}}"
SUPABASE_ANON_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"ANON_KEY": *"[^"]*"' | sed 's/"ANON_KEY": *"//;s/"$//' || true)
if [ -z "$SUPABASE_ANON_KEY" ]; then
    SUPABASE_ANON_KEY=$(echo "$SUPABASE_STATUS" | grep -o '"PUBLISHABLE_KEY": *"[^"]*"' | sed 's/"PUBLISHABLE_KEY": *"//;s/"$//' || true)
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
    missing_fields=()
    [ -z "$SUPABASE_URL" ] && missing_fields+=("API_URL")
    [ -z "$SUPABASE_ANON_KEY" ] && missing_fields+=("ANON_KEY")
    echo "Error: Failed to extract Supabase configuration"
    echo "Missing fields: ${missing_fields[*]}"
    exit 1
fi

echo "Supabase URL: $SUPABASE_URL"
echo ""

# Create local app test databases.
echo "Creating test databases..."
docker exec "$DB_CONTAINER" createdb -U postgres nexus_test 2>/dev/null || true
docker exec "$DB_CONTAINER" createdb -U postgres nexus_test_migrations 2>/dev/null || true
echo "Test databases ready (nexus_test, nexus_test_migrations)"
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
bun install
echo "Frontend dependencies installed"
echo ""

# Install node ingest worker dependencies (fetch + jsdom + Readability)
echo "Installing node ingest worker dependencies..."
cd "$PROJECT_ROOT/node/ingest"
bun install --frozen-lockfile
echo "Node ingest worker dependencies installed"
echo ""

# Database URLs using standalone local Postgres
DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/postgres"
DATABASE_URL_TEST="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test"
DATABASE_URL_TEST_MIGRATIONS="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}/nexus_test_migrations"

# Local MinIO values use the same R2-compatible storage interface as production.
R2_S3_API_ORIGIN="http://127.0.0.1:${MINIO_PORT}"

# Derived Supabase auth settings
SUPABASE_ISSUER="${SUPABASE_URL}/auth/v1"
SUPABASE_JWKS_URL="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
SUPABASE_AUDIENCES="authenticated"
AUTH_ALLOWED_REDIRECT_ORIGINS="http://localhost:3000,http://127.0.0.1:3000,http://10.0.2.2:3000,http://localhost:3001,http://127.0.0.1:3001"
STREAM_BASE_URL="http://localhost:8000"
STREAM_CORS_ORIGINS="http://localhost:3000,http://localhost:3001"

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

# Application config
NEXUS_ENV=local
POSTGRES_PORT=${POSTGRES_PORT}
MINIO_PORT=${MINIO_PORT}
DATABASE_URL=${DATABASE_URL}
DATABASE_URL_TEST=${DATABASE_URL_TEST}
DATABASE_URL_TEST_MIGRATIONS=${DATABASE_URL_TEST_MIGRATIONS}

# Podcast features are disabled by default for local setup because
# Podcast Index credentials are not provisioned automatically by make setup.
PODCASTS_ENABLED=false
# PODCAST_INDEX_API_KEY=<podcast-index-api-key>
# PODCAST_INDEX_API_SECRET=<podcast-index-api-secret>

# Supabase local Auth configuration
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}

# Supabase auth settings (used by FastAPI)
SUPABASE_ISSUER=${SUPABASE_ISSUER}
SUPABASE_JWKS_URL=${SUPABASE_JWKS_URL}
SUPABASE_AUDIENCES=${SUPABASE_AUDIENCES}
AUTH_ALLOWED_REDIRECT_ORIGINS=${AUTH_ALLOWED_REDIRECT_ORIGINS}

# Direct browser-to-FastAPI SSE
STREAM_BASE_URL=${STREAM_BASE_URL}
STREAM_CORS_ORIGINS=${STREAM_CORS_ORIGINS}

# R2-compatible object storage (MinIO in local development)
R2_S3_API_ORIGIN=${R2_S3_API_ORIGIN}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
R2_BUCKET=${R2_BUCKET}
R2_REGION=${R2_REGION}

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
AUTH_ALLOWED_REDIRECT_ORIGINS=${AUTH_ALLOWED_REDIRECT_ORIGINS}
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
echo "To seed development data:"
echo "  make seed"
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
echo "Supabase local is running for Auth only."
