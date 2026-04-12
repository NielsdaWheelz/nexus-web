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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Derive unique project name from directory for container isolation
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

# Fixed Supabase ports (from supabase/config.toml)
SUPABASE_API_PORT=54321
SUPABASE_DB_PORT=54322

canonicalize_loopback_url() {
    local url=$1
    echo "$url" | sed 's#://127\.0\.0\.1:#://localhost:#'
}

echo "=== Nexus Project Setup ==="
echo ""
echo "Project: $PROJECT_NAME"
echo "Supabase API port: $SUPABASE_API_PORT"
echo "Supabase DB port: $SUPABASE_DB_PORT"
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

SUPABASE_URL=$(canonicalize_loopback_url "$SUPABASE_URL")

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

# Create storage bucket for file uploads (idempotent)
echo "Creating storage bucket..."
BUCKET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/storage/v1/bucket" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"name": "media", "public": false}')
if [ "$BUCKET_STATUS" = "200" ] || [ "$BUCKET_STATUS" = "201" ]; then
    echo "Storage bucket 'media' created"
elif [ "$BUCKET_STATUS" = "409" ]; then
    echo "Storage bucket 'media' already exists"
else
    echo "Warning: Failed to create storage bucket (HTTP $BUCKET_STATUS)"
    echo "  Create the 'media' bucket manually via Supabase Studio: http://localhost:54323"
fi
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

# Install node ingest worker dependencies (fetch + jsdom + Readability)
echo "Installing node ingest worker dependencies..."
cd "$PROJECT_ROOT/node/ingest"
npm ci
echo "Node ingest worker dependencies installed"
echo ""

# Generate encryption key for BYOK API keys
echo "Generating key encryption key..."
NEXUS_KEY_ENCRYPTION_KEY=$(python3 -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())")
echo "Key encryption key generated"
echo ""

# Database URLs using Supabase local Postgres
DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/postgres"
DATABASE_URL_TEST="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/nexus_test"
DATABASE_URL_TEST_MIGRATIONS="postgresql+psycopg://postgres:postgres@localhost:${SUPABASE_DB_PORT}/nexus_test_migrations"

# Derived Supabase auth settings
SUPABASE_ISSUER="${SUPABASE_URL}/auth/v1"
SUPABASE_JWKS_URL="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
SUPABASE_AUDIENCES="authenticated"
AUTH_ALLOWED_REDIRECT_ORIGINS="http://localhost:3000,http://localhost:3001"

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
DATABASE_URL=${DATABASE_URL}
DATABASE_URL_TEST=${DATABASE_URL_TEST}
DATABASE_URL_TEST_MIGRATIONS=${DATABASE_URL_TEST_MIGRATIONS}

# Podcast features are disabled by default for local setup because
# Podcast Index credentials are not provisioned automatically by `make setup`.
PODCASTS_ENABLED=false
# PODCAST_INDEX_API_KEY=<podcast-index-api-key>
# PODCAST_INDEX_API_SECRET=<podcast-index-api-secret>

# Supabase local configuration
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_ROLE_KEY}

# Supabase auth settings (used by FastAPI)
SUPABASE_ISSUER=${SUPABASE_ISSUER}
SUPABASE_JWKS_URL=${SUPABASE_JWKS_URL}
SUPABASE_AUDIENCES=${SUPABASE_AUDIENCES}
AUTH_ALLOWED_REDIRECT_ORIGINS=${AUTH_ALLOWED_REDIRECT_ORIGINS}

# Key encryption for BYOK API keys (XChaCha20-Poly1305)
NEXUS_KEY_ENCRYPTION_KEY=${NEXUS_KEY_ENCRYPTION_KEY}
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
echo "Supabase Studio: http://localhost:54323"
