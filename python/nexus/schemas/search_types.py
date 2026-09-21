"""Canonical public search-result discriminants."""

from __future__ import annotations

from typing import Literal, get_args

SEARCH_RESULT_TYPES = Literal[
    "media",
    "podcast",
    "episode",
    "video",
    "content_chunk",
    "fragment",
    "contributor",
    "page",
    "note_block",
    "highlight",
    "message",
    "evidence_span",
    "conversation",
    "artifact",
    "web_result",
    "reader_apparatus_item",
]

# Runtime views derive from the Literal so validation, dispatch and union
# completeness share one authority.
ALL_RESULT_TYPES: tuple[str, ...] = get_args(SEARCH_RESULT_TYPES)
VALID_RESULT_TYPES: frozenset[str] = frozenset(ALL_RESULT_TYPES)
