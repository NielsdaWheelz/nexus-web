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

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from nexus.schemas.contributors import ContributorCreditOut, ContributorOut
from nexus.schemas.retrieval import RetrievalLocator, validate_locator_for_result_type

# Valid search result types
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
    "artifact_part",
    "web_result",
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


class SearchResultQuoteHighlightOut(BaseModel):
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


class SearchResultEpisodeOut(BaseModel):
    """Typed search result for podcast episode media hits."""

    type: Literal["episode"]
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


class SearchResultVideoOut(BaseModel):
    """Typed search result for video media hits."""

    type: Literal["video"]
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
    source_version: str = Field(min_length=1)
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source: SearchResultSourceOut
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    citation_label: str
    locator: RetrievalLocator
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultContentChunkOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultFragmentOut(BaseModel):
    """Typed search result for a readable source fragment."""

    type: Literal["fragment"]
    id: UUID
    score: float
    snippet: str
    source: SearchResultSourceOut
    source_version: str = Field(min_length=1)
    citation_label: str | None = None
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultFragmentOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


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
    highlight_excerpt: str | None = None
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultNoteBlockOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultHighlightOut(BaseModel):
    """Typed search result for a saved source highlight."""

    type: Literal["highlight"]
    id: UUID
    score: float
    snippet: str
    color: str
    exact: str
    source: SearchResultSourceOut
    source_version: str = Field(min_length=1)
    citation_label: str | None = None
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultHighlightOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultPageOut(BaseModel):
    """Typed search result for note pages."""

    type: Literal["page"]
    id: UUID
    score: float
    snippet: str
    description: str | None = None
    source_version: str = Field(min_length=1)
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
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultMessageOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultEvidenceSpanOut(BaseModel):
    """Typed search result for one durable evidence span."""

    type: Literal["evidence_span"]
    id: UUID
    score: float
    snippet: str
    source: SearchResultSourceOut
    evidence_span_id: UUID
    source_version: str = Field(min_length=1)
    citation_label: str
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultEvidenceSpanOut":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultConversationOut(BaseModel):
    """Typed search result for visible conversations."""

    type: Literal["conversation"]
    id: UUID
    score: float
    snippet: str
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultArtifactOut(BaseModel):
    """Typed search result for durable generated artifacts."""

    type: Literal["artifact"]
    id: UUID
    score: float
    snippet: str
    conversation_id: UUID
    message_id: UUID
    artifact_kind: str
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResultWebOut(BaseModel):
    """Typed public-web result shape shared with chat web search."""

    type: Literal["web_result"]
    id: str
    result_type: Literal["web_result"]
    score: float
    snippet: str
    source_id: str
    result_ref: str
    title: str
    url: str
    display_url: str | None = None
    extra_snippets: list[str] = Field(default_factory=list)
    published_at: str | None = None
    source_name: str | None = None
    rank: int | None = None
    provider: str | None = None
    provider_request_id: str | None = None
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    selected: bool
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_web_result_contract(self) -> "SearchResultWebOut":
        if self.context_ref.type != "web_result":
            raise ValueError("context_ref.type must be web_result")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultArtifactPartOut(BaseModel):
    """Typed search result for generated artifact part hits."""

    type: Literal["artifact_part"]
    id: UUID
    score: float
    snippet: str
    artifact_id: UUID
    message_id: UUID
    conversation_id: UUID
    artifact_kind: str
    artifact_title: str | None = None
    part_key: str | None = None
    part_type: str | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    deep_link: str
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_artifact_part_contract(self) -> "SearchResultArtifactPartOut":
        if self.context_ref.type != "artifact_part":
            raise ValueError("context_ref.type must be artifact_part")
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
    | SearchResultConversationOut
    | SearchResultArtifactOut
    | SearchResultWebOut
    | SearchResultArtifactPartOut,
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


class SearchResolveRequest(BaseModel):
    """Request body for resolving a durable search result ref."""

    result_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid")


class SearchResolveResponse(BaseModel):
    """Single typed search result resolution response."""

    result: SearchResultOut

    model_config = ConfigDict(extra="forbid")
