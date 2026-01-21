#!/usr/bin/env bash
set -euo pipefail

# Nexus archive/cleanup script
# Stops services and cleans up generated files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Nexus Cleanup ==="
echo ""

# Stop Docker services
echo "Stopping infrastructure services..."
cd "$PROJECT_ROOT/docker"
if docker compose down 2>/dev/null; then
    echo "✓ Services stopped"
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

# Optionally remove virtual environments
if [ "${CLEAN_VENV:-}" = "1" ]; then
    echo "Removing virtual environments..."
    rm -rf "$PROJECT_ROOT/python/.venv"
    echo "✓ Virtual environments removed"
    echo ""
fi

echo "=== Cleanup Complete ==="
echo ""
echo "To also remove virtual environments, run:"
echo "  CLEAN_VENV=1 ./scripts/agency_archive.sh"
