#!/usr/bin/env bash
set -euo pipefail

# Nexus project setup script
# Installs dependencies and prepares the development environment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Nexus Project Setup ==="
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

# Start infrastructure services
echo "Starting infrastructure services..."
cd "$PROJECT_ROOT/docker"
docker compose up -d
echo "✓ PostgreSQL and Redis started"
echo ""

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec nexus-postgres pg_isready -U postgres &> /dev/null; then
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

# Create test database if it doesn't exist
echo "Creating test database..."
docker exec nexus-postgres createdb -U postgres nexus_test 2>/dev/null || true
echo "✓ Test database ready"
echo ""

# Install python dependencies
echo "Installing python dependencies..."
cd "$PROJECT_ROOT/python"
uv sync --all-extras
echo "✓ Python dependencies installed"
echo ""

# Run migrations on dev database
echo "Running migrations on dev database..."
cd "$PROJECT_ROOT/migrations"
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev \
    uv run --project ../python alembic upgrade head
echo "✓ Migrations applied"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "To start the API server:"
echo "  cd apps/api"
echo "  PYTHONPATH=\$PWD/../../python DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev \\"
echo "    uv run --project ../../python uvicorn main:app --reload"
echo ""
echo "API docs: http://localhost:8000/docs"
