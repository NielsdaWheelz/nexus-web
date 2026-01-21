#!/usr/bin/env bash
set -euo pipefail

# Nexus verification script
# Runs all tests, linters, and formatters

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Nexus Verification ==="
echo ""

cd "$PROJECT_ROOT/python"

# Check if uv is available
if ! command -v uv &> /dev/null; then
    echo "Error: uv is required but not installed."
    exit 1
fi

# Ensure dependencies are installed
if [ ! -d ".venv" ]; then
    echo "Installing dependencies..."
    uv sync --all-extras
fi

FAILED=0

# Run linter
echo "=== Running Ruff Linter ==="
if uv run ruff check .; then
    echo "✓ Linting passed"
else
    echo "✗ Linting failed"
    FAILED=1
fi
echo ""

# Check formatting
echo "=== Checking Code Formatting ==="
if uv run ruff format --check .; then
    echo "✓ Formatting check passed"
else
    echo "✗ Formatting check failed (run 'uv run ruff format .' to fix)"
    FAILED=1
fi
echo ""

# Run tests that don't require database
echo "=== Running Unit Tests (no DB) ==="
if DATABASE_URL=postgresql+psycopg://localhost/test \
    uv run pytest tests/test_health.py tests/test_errors.py -v; then
    echo "✓ Unit tests passed"
else
    echo "✗ Unit tests failed"
    FAILED=1
fi
echo ""

# Check if PostgreSQL is available for DB tests
if docker exec nexus-postgres pg_isready -U postgres &> /dev/null 2>&1; then
    echo "=== Running Database Tests ==="
    
    # Ensure test database exists
    docker exec nexus-postgres createdb -U postgres nexus_test 2>/dev/null || true
    
    # Run migration tests
    echo "Running migration tests..."
    if DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test \
        uv run pytest tests/test_migrations.py -v; then
        echo "✓ Migration tests passed"
    else
        echo "✗ Migration tests failed"
        FAILED=1
    fi
    
    # Run DB connectivity tests
    echo ""
    echo "Running DB connectivity tests..."
    # First ensure migrations are applied
    cd "$PROJECT_ROOT/migrations"
    DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test \
        uv run --project ../python alembic upgrade head 2>/dev/null || true
    cd "$PROJECT_ROOT/python"
    
    if DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test \
        uv run pytest tests/test_db.py -v; then
        echo "✓ DB connectivity tests passed"
    else
        echo "✗ DB connectivity tests failed"
        FAILED=1
    fi
else
    echo "=== Skipping Database Tests ==="
    echo "(PostgreSQL not available - start with: cd docker && docker compose up -d)"
fi
echo ""

# Summary
echo "=== Verification Summary ==="
if [ $FAILED -eq 0 ]; then
    echo "✓ All checks passed"
    exit 0
else
    echo "✗ Some checks failed"
    exit 1
fi
