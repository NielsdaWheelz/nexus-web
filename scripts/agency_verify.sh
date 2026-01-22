#!/usr/bin/env bash
set -euo pipefail

# Nexus verification script
# Delegates to make verify which handles service startup, linting, and testing

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"
exec make verify
