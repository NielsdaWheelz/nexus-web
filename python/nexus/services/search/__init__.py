"""Search service package (split from the former services/search.py god file).

The package root re-exports only the orchestrator entry points the rest of the codebase
calls (§4.1). Scope parsing (``search.scope``), telemetry (``search.telemetry``), and the
result-type authority (``schemas.search``) are imported from their owning modules directly.
"""

from __future__ import annotations

from nexus.schemas.search import ALL_RESULT_TYPES
from nexus.services.search.service import get_search_result, search

__all__ = [
    "ALL_RESULT_TYPES",
    "get_search_result",
    "search",
]
