#!/usr/bin/env bash
set -euo pipefail

# Nexus verification script
# Runs linters, type checks, formatters, and all tests
#
# This script is strict by default - it will fail if dependencies are missing.
# Run 'make setup' first to ensure all dependencies are installed.

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
REDIS_PORT="${REDIS_PORT:-6379}"
DATABASE_URL_BASE="postgresql+psycopg://postgres:postgres@localhost:${POSTGRES_PORT}"
REDIS_URL="redis://localhost:${REDIS_PORT}/0"

# Derive container names from project directory
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
POSTGRES_CONTAINER="${PROJECT_NAME}-postgres-1"
REDIS_CONTAINER="${PROJECT_NAME}-redis-1"

echo "=== Nexus Verification ==="
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
check_tool npm
echo "✓ Required tools found"
echo ""

FAILED=0

# =============================================================================
# Backend Checks
# =============================================================================

cd "$PROJECT_ROOT/python"

# Fail if dependencies not installed (strict mode)
if [ ! -d ".venv" ]; then
    echo "Error: Python dependencies not installed. Run 'make setup' first."
    exit 1
fi

# Run linter
echo "=== Running Backend Linter ==="
if uv run ruff check .; then
    echo "✓ Backend linting passed"
else
    echo "✗ Backend linting failed"
    FAILED=1
fi
echo ""

# Check formatting
echo "=== Checking Backend Formatting ==="
if uv run ruff format --check .; then
    echo "✓ Backend formatting check passed"
else
    echo "✗ Backend formatting check failed (run 'make fmt-back' to fix)"
    FAILED=1
fi
echo ""

# =============================================================================
# Frontend Checks
# =============================================================================

cd "$PROJECT_ROOT/apps/web"

# Fail if dependencies not installed (strict mode)
if [ ! -d "node_modules" ]; then
    echo "Error: Frontend dependencies not installed. Run 'make setup' first."
    exit 1
fi

echo "=== Running Frontend Linter ==="
if npm run lint; then
    echo "✓ Frontend linting passed"
else
    echo "✗ Frontend linting failed"
    FAILED=1
fi
echo ""

echo "=== Running Frontend Type Check ==="
if npm run typecheck; then
    echo "✓ Frontend type check passed"
else
    echo "✗ Frontend type check failed"
    FAILED=1
fi
echo ""

echo "=== Running Frontend Build ==="
if npm run build; then
    echo "✓ Frontend build passed"
else
    echo "✗ Frontend build failed"
    FAILED=1
fi
echo ""

# =============================================================================
# Database Tests
# =============================================================================

# Check if PostgreSQL is available
if ! docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres &> /dev/null 2>&1; then
    echo "=== Skipping Database Tests ==="
    echo "Error: PostgreSQL not available. Run 'make setup' first."
    echo ""
    FAILED=1
else
    cd "$PROJECT_ROOT/python"

    # Run main tests (excludes migration tests)
    echo "=== Running Backend Tests ==="
    if DATABASE_URL="${DATABASE_URL_BASE}/nexus_test" NEXUS_ENV=test \
        uv run pytest tests/ -v --ignore=tests/test_migrations.py; then
        echo "✓ Backend tests passed"
    else
        echo "✗ Backend tests failed"
        FAILED=1
    fi
    echo ""

    # Check if Redis is available before running migration tests
    if ! docker exec "$REDIS_CONTAINER" redis-cli ping &> /dev/null 2>&1; then
        echo "=== Skipping Migration Tests ==="
        echo "Error: Redis not available. Run 'make setup' first."
        echo ""
        FAILED=1
    else
        # Run migration tests (separate database)
        echo "=== Running Migration Tests ==="
        if DATABASE_URL="${DATABASE_URL_BASE}/nexus_test_migrations" REDIS_URL="$REDIS_URL" NEXUS_ENV=test \
            uv run pytest tests/test_migrations.py -v; then
            echo "✓ Migration tests passed"
        else
            echo "✗ Migration tests failed"
            FAILED=1
        fi
        echo ""
    fi
fi

# =============================================================================
# Frontend Tests
# =============================================================================

cd "$PROJECT_ROOT/apps/web"

echo "=== Running Frontend Tests ==="
if npm test -- --passWithNoTests; then
    echo "✓ Frontend tests passed"
else
    echo "✗ Frontend tests failed"
    FAILED=1
fi
echo ""

# =============================================================================
# Summary
# =============================================================================

echo "=== Verification Summary ==="
if [ $FAILED -eq 0 ]; then
    echo "✓ All checks passed"
    exit 0
else
    echo "✗ Some checks failed"
    exit 1
fi
