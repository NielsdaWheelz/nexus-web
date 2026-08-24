"""Nexus search policy constants shared by declarations and execution.

The executable model-facing contract lives in :mod:`nexus.services.tool_runtime`.
Search parsing, authorization, and retrieval remain with the existing search and
resource-graph owners; this module keeps only their product-level result policy.
"""

from __future__ import annotations

APP_SEARCH_LIMIT = 8
APP_SEARCH_SELECTED_LIMIT = 6
APP_SEARCH_CONTEXT_CHARS = 16_000
