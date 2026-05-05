"""Search Pydantic schemas.

Contains request and response models for the search endpoint.
These schemas are introduced in Slice 3 (PR-06: Keyword Search).

Search returns mixed typed results from different content types:
- media (titles)
- podcasts (titles/descriptions)
- content chunks (indexed document evidence)
- pages (titles/descriptions)
- note blocks (body)
- messages (content)
"""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_serializer

from nexus.schemas.contributors import ContributorCreditOut, ContributorOut

# Valid search result types
SEARCH_RESULT_TYPES = Literal[
    "media",
    "podcast",
    "content_chunk",
    "contributor",
    "page",
    "note_block",
    "message",
]

# Valid search scopes
SEARCH_SCOPE_PREFIXES = ("all", "media:", "library:", "conversation:")


# =============================================================================
# Response Schemas
# =============================================================================


class SearchResultSourceOut(BaseModel):
    """Source metadata shared by media/content search rows."""

    media_id: UUID
    media_kind: str
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    published_date: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResultHighlightOut(BaseModel):
    """Quote-context snippet for highlight-backed search results."""

    exact: str
    prefix: str = ""
    suffix: str = ""

    model_config = ConfigDict(extra="forbid")


class SearchResultContextRefOut(BaseModel):
    """Backend-owned context reference for model retrieval and citations."""

    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID] = Field(default_factory=list)

    @model_serializer
    def serialize(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": self.type, "id": str(self.id)}
        if self.evidence_span_ids:
            payload["evidence_span_ids"] = [
                str(evidence_span_id) for evidence_span_id in self.evidence_span_ids
            ]
        return payload

    model_config = ConfigDict(extra="forbid")


class SearchResultResolverOut(BaseModel):
    """Backend-owned reader locator for evidence-backed results."""

    kind: Literal["web", "epub", "pdf", "transcript"]
    route: str
    params: dict[str, str]
    status: str
    selector: dict[str, Any]
    highlight: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResultModelFields(BaseModel):
    """Common model-facing fields shared by every typed search row."""

    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultMediaOut(BaseModel):
    """V2 typed search result for media title hits."""

    type: Literal["media"]
    id: UUID
    score: float
    snippet: str
    source: SearchResultSourceOut
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultPodcastOut(BaseModel):
    """Typed search result for visible podcast hits."""

    type: Literal["podcast"]
    id: UUID
    score: float
    snippet: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultContentChunkOut(BaseModel):
    """Typed search result for indexed document evidence."""

    type: Literal["content_chunk"]
    id: UUID
    score: float
    snippet: str
    source_kind: str
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source: SearchResultSourceOut
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    citation_label: str
    resolver: SearchResultResolverOut
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultContributorOut(BaseModel):
    """Typed search result for contributor identity hits."""

    type: Literal["contributor"]
    id: str
    score: float
    snippet: str
    contributor_handle: str
    contributor: ContributorOut
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultNoteBlockOut(BaseModel):
    """Typed search result for note-block body hits."""

    type: Literal["note_block"]
    id: UUID
    score: float
    snippet: str
    page_id: UUID
    page_title: str
    body_text: str
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultPageOut(BaseModel):
    """Typed search result for note pages."""

    type: Literal["page"]
    id: UUID
    score: float
    snippet: str
    description: str | None = None
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultMessageOut(BaseModel):
    """V2 typed search result for conversation message hits."""

    type: Literal["message"]
    id: UUID
    score: float
    snippet: str
    conversation_id: UUID
    seq: int
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


SearchResultOut = Annotated[
    SearchResultMediaOut
    | SearchResultPodcastOut
    | SearchResultContentChunkOut
    | SearchResultContributorOut
    | SearchResultPageOut
    | SearchResultNoteBlockOut
    | SearchResultMessageOut,
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
