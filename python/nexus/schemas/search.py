"""Search Pydantic schemas.

Contains request and response models for the search endpoint.

Search returns mixed typed results from different content types:
- media (titles)
- podcasts (titles/descriptions)
- content chunks (indexed document evidence)
- pages (titles)
- note blocks (body)
- messages (content)
"""

from typing import Annotated, Any, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalLocator, validate_locator_for_result_type

# Valid search result types — the canonical result-discriminant authority for the
# whole codebase (HTTP response union, chat telemetry, retriever dispatch). The
# runtime tuple/set below are derived from the Literal so the two can never drift.
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

# Runtime view of SEARCH_RESULT_TYPES (declaration order preserved) for iteration,
# default-all expansion, and membership checks. Single authority; do not redefine.
ALL_RESULT_TYPES: tuple[str, ...] = get_args(SEARCH_RESULT_TYPES)
VALID_RESULT_TYPES: frozenset[str] = frozenset(ALL_RESULT_TYPES)


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
    summary_md: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResultContextRefOut(BaseModel):
    """Backend-owned context reference for model retrieval and citations."""

    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    locator: RetrievalLocator | None = None

    @model_serializer
    def serialize(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": self.type, "id": str(self.id)}
        if self.evidence_span_ids:
            payload["evidence_span_ids"] = [
                str(evidence_span_id) for evidence_span_id in self.evidence_span_ids
            ]
        if self.locator is not None:
            payload["locator"] = self.locator.model_dump(mode="json", exclude_none=True)
        return payload

    model_config = ConfigDict(extra="forbid")


class SearchResultBaseOut(BaseModel):
    """Envelope fields shared by every typed search result variant."""

    score: float
    snippet: str
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    resource_ref: str
    activation: ResourceActivationOut
    citation_target: str | None
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultMediaOut(SearchResultBaseOut):
    """Typed search result for media title hits."""

    type: Literal["media"]
    id: UUID
    source: SearchResultSourceOut


class SearchResultEpisodeOut(SearchResultBaseOut):
    """Typed search result for podcast episode media hits."""

    type: Literal["episode"]
    id: UUID
    source: SearchResultSourceOut


class SearchResultVideoOut(SearchResultBaseOut):
    """Typed search result for video media hits."""

    type: Literal["video"]
    id: UUID
    source: SearchResultSourceOut


class SearchResultPodcastOut(SearchResultBaseOut):
    """Typed search result for visible podcast hits."""

    type: Literal["podcast"]
    id: UUID
    contributors: list[ContributorCreditOut] = Field(default_factory=list)


class SearchResultContentChunkOut(SearchResultBaseOut):
    """Typed search result for indexed document evidence."""

    type: Literal["content_chunk"]
    id: UUID
    source_kind: str
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source: SearchResultSourceOut
    citation_label: str
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultContentChunkOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultFragmentOut(SearchResultBaseOut):
    """Typed search result for a readable source fragment."""

    type: Literal["fragment"]
    id: UUID
    source: SearchResultSourceOut
    citation_label: str | None = None
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultFragmentOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultContributorIdentityOut(BaseModel):
    """Minimal contributor identity embedded in a contributor search hit (D-33).

    The narrowed replacement for the old nested full ``ContributorOut`` on the
    ``/search`` wire: handle + display name only. No status, kind, sort name,
    disambiguation, aliases, or external ids ever reach this surface (AC 24).
    The ``/search`` wire is snake-case throughout (``ok(by_alias=False)``).
    """

    handle: str
    display_name: str

    model_config = ConfigDict(extra="forbid")


class SearchResultContributorOut(SearchResultBaseOut):
    """Typed search result for contributor identity hits."""

    type: Literal["contributor"]
    id: str
    contributor_handle: str
    contributor: SearchResultContributorIdentityOut


class SearchResultNoteBlockOut(SearchResultBaseOut):
    """Typed search result for note-block body hits."""

    type: Literal["note_block"]
    id: UUID
    body_text: str
    highlight_excerpt: str | None = None
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultNoteBlockOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultHighlightOut(SearchResultBaseOut):
    """Typed search result for a saved source highlight."""

    type: Literal["highlight"]
    id: UUID
    color: str
    exact: str
    source: SearchResultSourceOut
    citation_label: str | None = None
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultHighlightOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultPageOut(SearchResultBaseOut):
    """Typed search result for note pages."""

    type: Literal["page"]
    id: UUID


class SearchResultMessageOut(SearchResultBaseOut):
    """Typed search result for conversation message hits."""

    type: Literal["message"]
    id: UUID
    conversation_id: UUID
    seq: int
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultMessageOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultEvidenceSpanOut(SearchResultBaseOut):
    """Typed search result for one durable evidence span."""

    type: Literal["evidence_span"]
    id: UUID
    source: SearchResultSourceOut
    evidence_span_id: UUID
    citation_label: str
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultEvidenceSpanOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultReaderApparatusItemOut(SearchResultBaseOut):
    """Typed search result for source-authored reader apparatus rows."""

    type: Literal["reader_apparatus_item"]
    id: UUID
    source: SearchResultSourceOut
    apparatus_kind: str
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultReaderApparatusItemOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultConversationOut(SearchResultBaseOut):
    """Typed search result for visible conversations."""

    type: Literal["conversation"]
    id: UUID


class ConversationArtifactSearchOut(SearchResultBaseOut):
    """Typed search result for a current Conversation Dossier claim.

    The exact revision ref preserves historical selection while activation opens
    the Conversation subject and its workspace-local Dossier surface.
    """

    type: Literal["artifact"]
    id: UUID
    revision_id: UUID
    subject_ref: str


class SearchResultWebOut(SearchResultBaseOut):
    """Typed public-web result shape shared with chat web search."""

    type: Literal["web_result"]
    id: str
    result_type: Literal["web_result"]
    source_id: str
    result_ref: str
    url: str
    display_url: str | None = None
    extra_snippets: list[str] = Field(default_factory=list)
    published_at: str | None = None
    source_name: str | None = None
    rank: int | None = None
    provider: str | None = None
    provider_request_id: str | None = None
    locator: RetrievalLocator
    selected: bool

    @model_validator(mode="after")
    def validate_web_result_contract(self) -> "SearchResultWebOut":
        if self.context_ref.type != "web_result":
            raise ValueError("context_ref.type must be web_result")
        if str(self.context_ref.id) != self.source_id:
            raise ValueError("web_result context_ref.id must match source_id")
        validate_locator_for_result_type(self.type, self.locator)
        return self


SearchResultOut = Annotated[
    SearchResultMediaOut
    | SearchResultPodcastOut
    | SearchResultEpisodeOut
    | SearchResultVideoOut
    | SearchResultContentChunkOut
    | SearchResultFragmentOut
    | SearchResultContributorOut
    | SearchResultPageOut
    | SearchResultNoteBlockOut
    | SearchResultHighlightOut
    | SearchResultMessageOut
    | SearchResultEvidenceSpanOut
    | SearchResultReaderApparatusItemOut
    | SearchResultConversationOut
    | ConversationArtifactSearchOut
    | SearchResultWebOut,
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
