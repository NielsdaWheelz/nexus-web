"""The public search-result discriminants, shared by search, chat citations and their wire."""

from __future__ import annotations

from typing import Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_evidence import CapturedPassageTarget

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
    "web_result",
    "reader_apparatus_item",
]
ALL_RESULT_TYPES: tuple[str, ...] = get_args(SEARCH_RESULT_TYPES)
VALID_RESULT_TYPES: frozenset[str] = frozenset(ALL_RESULT_TYPES)


class SearchResultContextRefOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID]
    passage_target: CapturedPassageTarget | None


class SearchPageInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    has_more: bool = False
    next_cursor: str | None
