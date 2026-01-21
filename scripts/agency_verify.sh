#!/usr/bin/env bash
set -euo pipefail

# Nexus verification script
# Runs linters, formatters, and all tests

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
fi

# Defaults (can be overridden by .env or environment)
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
DATABASE_URL_BASE="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}"

# Derive container name from project directory
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
POSTGRES_CONTAINER="${PROJECT_NAME}-postgres-1"

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
    echo "✗ Formatting check failed (run 'make fmt' to fix)"
    FAILED=1
fi
echo ""

# Check if PostgreSQL is available
if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres &> /dev/null 2>&1; then
    # Run main tests (excludes migration tests)
    echo "=== Running Tests ==="
    if DATABASE_URL="${DATABASE_URL_BASE}/nexus_test" NEXUS_ENV=test \
        uv run pytest tests/ -v --ignore=tests/test_migrations.py; then
        echo "✓ Tests passed"
    else
        echo "✗ Tests failed"
        FAILED=1
    fi
    echo ""

    # Run migration tests (separate database)
    echo "=== Running Migration Tests ==="
    if DATABASE_URL="${DATABASE_URL_BASE}/nexus_test_migrations" NEXUS_ENV=test \
        uv run pytest tests/test_migrations.py -v; then
        echo "✓ Migration tests passed"
    else
        echo "✗ Migration tests failed"
        FAILED=1
    fi
else
    echo "=== Skipping Database Tests ==="
    echo "(PostgreSQL not available - run 'make setup' first)"
    echo ""
    FAILED=1
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
