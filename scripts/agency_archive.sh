#!/usr/bin/env bash
set -euo pipefail

# Nexus archive/cleanup script
# Stops services and cleans up generated files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Must match setup script's naming convention
PROJECT_NAME="nexus-$(basename "$PROJECT_ROOT")"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

echo "=== Nexus Cleanup ==="
echo ""
echo "Project: $PROJECT_NAME"
echo ""

# Stop Docker services (with volumes to free up space)
echo "Stopping infrastructure services..."
cd "$PROJECT_ROOT/docker"
if docker compose down -v 2>/dev/null; then
    echo "✓ Services stopped and volumes removed"
else
    echo "  (no services were running)"
fi
echo ""

# Clean Python artifacts
echo "Cleaning Python artifacts..."
find "$PROJECT_ROOT" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find "$PROJECT_ROOT" -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
find "$PROJECT_ROOT" -type d -name .ruff_cache -exec rm -rf {} + 2>/dev/null || true
find "$PROJECT_ROOT" -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
find "$PROJECT_ROOT" -type f -name "*.pyc" -delete 2>/dev/null || true
echo "✓ Python artifacts cleaned"
echo ""

# Clean coverage reports
echo "Cleaning coverage reports..."
rm -rf "$PROJECT_ROOT/python/.coverage" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/python/htmlcov" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/python/coverage.xml" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/apps/web/coverage" 2>/dev/null || true
echo "✓ Coverage reports cleaned"
echo ""

# Clean frontend build artifacts
echo "Cleaning frontend build artifacts..."
rm -rf "$PROJECT_ROOT/apps/web/.next" 2>/dev/null || true
echo "✓ Frontend build artifacts cleaned"
echo ""

# Optionally remove virtual environments and node_modules
if [ "${CLEAN_DEPS:-}" = "1" ]; then
    echo "Removing virtual environments..."
    rm -rf "$PROJECT_ROOT/python/.venv"
    echo "✓ Virtual environments removed"
    echo ""

    echo "Removing node_modules..."
    rm -rf "$PROJECT_ROOT/apps/web/node_modules"
    echo "✓ node_modules removed"
    echo ""
fi

# Optionally remove .env file
if [ "${CLEAN_ENV:-}" = "1" ]; then
    echo "Removing .env file..."
    rm -f "$PROJECT_ROOT/.env"
    echo "✓ .env file removed"
    echo ""
fi

echo "=== Cleanup Complete ==="
echo ""
echo "Options:"
echo "  CLEAN_DEPS=1  - Also remove dependencies (venv, node_modules)"
echo "  CLEAN_ENV=1   - Also remove .env file"
echo ""
echo "Example: CLEAN_DEPS=1 CLEAN_ENV=1 ./scripts/agency_archive.sh"
