"""Search Pydantic schemas.

Contains request and response models for the search endpoint.
These schemas are introduced in Slice 3 (PR-06: Keyword Search).

Search returns mixed typed results from different content types:
- media (titles)
- fragments (canonical_text)
- annotations (body)
- messages (content)
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Valid search result types
SEARCH_RESULT_TYPES = Literal["media", "fragment", "annotation", "message", "transcript_chunk"]

# Valid search scopes
SEARCH_SCOPE_PREFIXES = ("all", "media:", "library:", "conversation:")


# =============================================================================
# Response Schemas
# =============================================================================


class SearchResultSourceOut(BaseModel):
    """Source metadata shared by media/fragment/annotation search rows."""

    media_id: UUID
    media_kind: str
    title: str
    authors: list[str] = Field(default_factory=list)
    published_date: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResultHighlightOut(BaseModel):
    """Quote-context snippet for annotation search results."""

    exact: str
    prefix: str = ""
    suffix: str = ""

    model_config = ConfigDict(extra="forbid")


class SearchResultMediaOut(BaseModel):
    """V2 typed search result for media title hits."""

    type: Literal["media"]
    id: UUID
    score: float
    snippet: str
    source: SearchResultSourceOut

    model_config = ConfigDict(extra="forbid")


class SearchResultFragmentOut(BaseModel):
    """V2 typed search result for fragment text hits."""

    type: Literal["fragment"]
    id: UUID
    score: float
    snippet: str
    fragment_idx: int
    source: SearchResultSourceOut

    model_config = ConfigDict(extra="forbid")


class SearchResultAnnotationOut(BaseModel):
    """V2 typed search result for annotation-body hits."""

    type: Literal["annotation"]
    id: UUID
    score: float
    snippet: str
    highlight_id: UUID
    fragment_id: UUID
    fragment_idx: int
    annotation_body: str
    highlight: SearchResultHighlightOut
    source: SearchResultSourceOut

    model_config = ConfigDict(extra="forbid")


class SearchResultMessageOut(BaseModel):
    """V2 typed search result for conversation message hits."""

    type: Literal["message"]
    id: UUID
    score: float
    snippet: str
    conversation_id: UUID
    seq: int

    model_config = ConfigDict(extra="forbid")


class SearchResultTranscriptChunkOut(BaseModel):
    """Typed search result for semantic transcript chunk hits."""

    type: Literal["transcript_chunk"]
    id: UUID
    score: float
    snippet: str
    t_start_ms: int
    t_end_ms: int
    source: SearchResultSourceOut

    model_config = ConfigDict(extra="forbid")


SearchResultOut = Annotated[
    SearchResultMediaOut
    | SearchResultFragmentOut
    | SearchResultAnnotationOut
    | SearchResultMessageOut
    | SearchResultTranscriptChunkOut,
    Field(discriminator="type"),
]


class SearchPageInfo(BaseModel):
    """Pagination information for search results.

    Uses offset-based cursor encoded as base64url JSON.
    """

    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResponse(BaseModel):
    """Response for search endpoint.

    Results are a mixed, ordered list of typed search results.
    """

    results: list[SearchResultOut] = Field(default_factory=list)
    page: SearchPageInfo = Field(default_factory=SearchPageInfo)

    model_config = ConfigDict(extra="forbid")
