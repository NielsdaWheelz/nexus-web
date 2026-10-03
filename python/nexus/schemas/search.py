"""Search response schemas: one envelope and its typed variants.

FastAPI generates the browser wire contract from these models. All result fields
are sent; only the context reference serializer intentionally omits empty fields.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.resource_items import ResourceActivationOut
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
    contributors: list[ContributorCreditOut]
    original_published_date: Presence[PublicationDate]
    summary_md: str | None

    model_config = ConfigDict(extra="forbid")


class SearchResultContextRefOut(BaseModel):
    """Backend-owned context reference for model retrieval and citations."""

    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    locator: RetrievalLocator | None = None

    # Keep the model's schema: an untyped wrap return retains the typed fields
    # and their optional keys instead of replacing them with a generic JSON map.
    @model_serializer(mode="wrap")
    def serialize(self, handler: SerializerFunctionWrapHandler):
        payload = handler(self)
        payload["id"] = str(self.id)
        if self.evidence_span_ids:
            payload["evidence_span_ids"] = [str(value) for value in self.evidence_span_ids]
        else:
            payload.pop("evidence_span_ids", None)
        if self.locator is not None:
            payload["locator"] = self.locator.model_dump(mode="json", exclude_none=True)
        else:
            payload.pop("locator", None)
        return payload

    model_config = ConfigDict(extra="forbid")


class SearchResultBaseOut(BaseModel):
    """Envelope fields shared by every typed variant."""

    score: float
    snippet: str
    resource_ref: str
    owner_resource_ref: str
    action_subject_ref: str = Field(alias="actionSubjectRef")
    activation: ResourceActivationOut
    citation_target: str | None
    context_ref: SearchResultContextRefOut

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SearchResultTitledOut(SearchResultBaseOut):
    title: str
    source_label: str | None
    media_id: UUID | None
    media_kind: str | None


class SearchResultLocatorBackedOut[ResultTypeT: LocatorBackedResultType](SearchResultTitledOut):
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
    media_summary: MediaSummaryOut = Field(alias="mediaSummary")


class SearchResultPodcastOut(SearchResultTitledOut):
    """A visible podcast hit."""

    type: Literal["podcast"]
    id: UUID
    contributors: list[ContributorCreditOut]


class SearchResultContentChunkOut(SearchResultLocatorBackedOut[Literal["content_chunk"]]):
    """An indexed document passage."""

    id: UUID
    source_kind: str
    evidence_span_ids: list[UUID]
    source: SearchResultSourceOut
    citation_label: str


class SearchResultFragmentOut(SearchResultLocatorBackedOut[Literal["fragment"]]):
    """A readable source fragment."""

    id: UUID
    source: SearchResultSourceOut
    citation_label: str | None


class SearchResultContributorIdentityOut(BaseModel):
    """Handle + display name only: no status, aliases, or external ids."""

    handle: str
    display_name: str

    model_config = ConfigDict(extra="forbid")


class SearchResultContributorOut(SearchResultTitledOut):
    """A contributor identity hit."""

    type: Literal["contributor"]
    id: str
    contributor_handle: str
    contributor: SearchResultContributorIdentityOut


class SearchResultNoteBlockOut(SearchResultLocatorBackedOut[Literal["note_block"]]):
    """A note-block body hit."""

    id: UUID
    body_text: str
    highlight_excerpt: str | None
    note_origin: Literal["note", "highlight_note"]


class SearchResultHighlightOut(SearchResultLocatorBackedOut[Literal["highlight"]]):
    """A saved source highlight."""

    id: UUID
    color: str
    exact: str
    source: SearchResultSourceOut
    citation_label: str | None


class SearchResultPageOut(SearchResultTitledOut):
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


class SearchResultConversationOut(SearchResultTitledOut):
    """A visible conversation."""

    type: Literal["conversation"]
    id: UUID


class ConversationArtifactSearchOut(SearchResultTitledOut):
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
    display_url: str | None
    extra_snippets: list[str]
    published_at: str | None
    source_name: str | None
    rank: int | None
    provider: str | None
    provider_request_id: str | None
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
    next_cursor: str | None

    model_config = ConfigDict(extra="forbid")


class SearchResponse(BaseModel):
    """A mixed, ordered page of typed search results."""

    results: list[SearchResultOut]
    page: SearchPageInfo

    model_config = ConfigDict(extra="forbid")
