"""The public search-result discriminants, shared by search, chat citations and their wire."""

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
ALL_RESULT_TYPES: tuple[str, ...] = get_args(SEARCH_RESULT_TYPES)
VALID_RESULT_TYPES: frozenset[str] = frozenset(ALL_RESULT_TYPES)
