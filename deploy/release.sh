#!/usr/bin/env bash
# prepare the explicit web candidate, release its backend, then activate and check web.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec uv run --project "$root/python" --frozen --no-sync \
  python -B "$root/deploy/web/controller.py" "$@"
