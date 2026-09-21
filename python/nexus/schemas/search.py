"""Search response schemas: one envelope and its typed variants.

The web decoder asserts exact key sets per variant, so every field here is on
the wire contract — including ones no component renders today.
"""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.retrieval import (
    LocatorBackedResultType,
    RetrievalLocator,
    validate_locator_for_result_type,
)
from nexus.schemas.search_types import SEARCH_RESULT_TYPES


class SearchResultSourceOut(BaseModel):
    """Source metadata shared by media-anchored rows."""

    media_id: UUID
    media_kind: str
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    original_published_date: Presence[PublicationDate]
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


class SearchResultActivationOut(BaseModel):
    """Search-owned snake-case occurrence activation.

    A local DTO so the response's ``by_alias=True`` dump cannot leak the
    resource-items activation aliases onto this boundary.
    """

    resource_ref: str
    kind: Literal["route", "external", "none"]
    href: str | None = None
    unresolved_reason: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResultBaseOut(BaseModel):
    """Envelope fields shared by every typed variant."""

    score: float
    snippet: str
    title: str
    source_label: str | None = None
    media_id: UUID | None = None
    media_kind: str | None = None
    resource_ref: str
    owner_resource_ref: str
    action_subject_ref: str = Field(alias="actionSubjectRef")
    activation: SearchResultActivationOut
    citation_target: str | None
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SearchResultLocatorBackedOut[ResultTypeT: LocatorBackedResultType](SearchResultBaseOut):
    """Envelope for the variants carrying a locator bound to their result type."""

    type: ResultTypeT
    locator: RetrievalLocator

    @model_validator(mode="after")
    def validate_locator_contract(self) -> "SearchResultLocatorBackedOut[ResultTypeT]":
        validate_locator_for_result_type(self.type, self.locator)
        return self


class SearchResultMediaOut(SearchResultBaseOut):
    """A media hit; the discriminant names the document's format family."""

    type: Literal["media", "episode", "video"]
    id: UUID
    source: SearchResultSourceOut


class SearchResultPodcastOut(SearchResultBaseOut):
    """A visible podcast hit."""

    type: Literal["podcast"]
    id: UUID
    contributors: list[ContributorCreditOut] = Field(default_factory=list)


class SearchResultContentChunkOut(SearchResultLocatorBackedOut[Literal["content_chunk"]]):
    """An indexed document passage."""

    id: UUID
    source_kind: str
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source: SearchResultSourceOut
    citation_label: str


class SearchResultFragmentOut(SearchResultLocatorBackedOut[Literal["fragment"]]):
    """A readable source fragment."""

    id: UUID
    source: SearchResultSourceOut
    citation_label: str | None = None


class SearchResultContributorIdentityOut(BaseModel):
    """Handle + display name only: no status, aliases, or external ids."""

    handle: str
    display_name: str

    model_config = ConfigDict(extra="forbid")


class SearchResultContributorOut(SearchResultBaseOut):
    """A contributor identity hit."""

    type: Literal["contributor"]
    id: str
    contributor_handle: str
    contributor: SearchResultContributorIdentityOut


class SearchResultNoteBlockOut(SearchResultLocatorBackedOut[Literal["note_block"]]):
    """A note-block body hit."""

    id: UUID
    body_text: str
    highlight_excerpt: str | None = None
    note_origin: Literal["note", "highlight_note"]


class SearchResultHighlightOut(SearchResultLocatorBackedOut[Literal["highlight"]]):
    """A saved source highlight."""

    id: UUID
    color: str
    exact: str
    source: SearchResultSourceOut
    citation_label: str | None = None


class SearchResultPageOut(SearchResultBaseOut):
    """A note page."""

    type: Literal["page"]
    id: UUID


class SearchResultMessageOut(SearchResultLocatorBackedOut[Literal["message"]]):
    """A conversation message hit."""

    id: UUID
    conversation_id: UUID
    seq: int


class SearchResultEvidenceSpanOut(SearchResultLocatorBackedOut[Literal["evidence_span"]]):
    """One durable evidence span, produced only by citation reopen."""

    id: UUID
    source: SearchResultSourceOut
    evidence_span_id: UUID
    citation_label: str


class SearchResultReaderApparatusItemOut(
    SearchResultLocatorBackedOut[Literal["reader_apparatus_item"]]
):
    """A source-authored reader apparatus row."""

    id: UUID
    source: SearchResultSourceOut
    apparatus_kind: str


class SearchResultConversationOut(SearchResultBaseOut):
    """A visible conversation."""

    type: Literal["conversation"]
    id: UUID


class ConversationArtifactSearchOut(SearchResultBaseOut):
    """A current Conversation Dossier claim; the exact revision ref preserves
    historical selection while activation opens the conversation subject."""

    type: Literal["artifact"]
    id: UUID
    revision_id: UUID
    subject_ref: str


class SearchResultWebOut(SearchResultLocatorBackedOut[Literal["web_result"]]):
    """A persisted public-web result, shaped as chat web search returns it."""

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
    selected: bool


SearchResultOut = Annotated[
    SearchResultMediaOut
    | SearchResultPodcastOut
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
    """Offset pagination, encoded as a base64url JSON cursor."""

    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class SearchResponse(BaseModel):
    """A mixed, ordered page of typed search results."""

    results: list[SearchResultOut] = Field(default_factory=list)
    page: SearchPageInfo = Field(default_factory=SearchPageInfo)

    model_config = ConfigDict(extra="forbid")
