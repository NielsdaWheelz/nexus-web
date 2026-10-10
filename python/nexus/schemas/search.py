"""``GET /search`` wire: one envelope and its typed variants (the browser's generated contract)."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    media_id: UUID
    media_kind: str
    title: str
    contributors: list[ContributorCreditOut]
    original_published_date: Presence[PublicationDate]

    model_config = ConfigDict(extra="forbid")


class SearchResultContextRefOut(BaseModel):
    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID]

    model_config = ConfigDict(extra="forbid")


class SearchResultBaseOut(BaseModel):
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
    type: Literal["podcast"]
    id: UUID
    contributors: list[ContributorCreditOut]


class SearchResultContentChunkOut(SearchResultLocatorBackedOut[Literal["content_chunk"]]):
    id: UUID
    source_kind: str
    evidence_span_ids: list[UUID]
    source: SearchResultSourceOut
    citation_label: str


class SearchResultFragmentOut(SearchResultLocatorBackedOut[Literal["fragment"]]):
    id: UUID
    source: SearchResultSourceOut
    citation_label: str | None


class SearchResultContributorIdentityOut(BaseModel):
    display_name: str

    model_config = ConfigDict(extra="forbid")


class SearchResultContributorOut(SearchResultTitledOut):
    """A contributor identity hit; its id is the handle."""

    type: Literal["contributor"]
    id: str
    contributor_handle: str
    contributor: SearchResultContributorIdentityOut


class SearchResultNoteBlockOut(SearchResultLocatorBackedOut[Literal["note_block"]]):
    id: UUID
    body_text: str
    highlight_excerpt: str | None
    note_origin: Literal["note", "highlight_note"]


class SearchResultHighlightOut(SearchResultLocatorBackedOut[Literal["highlight"]]):
    id: UUID
    color: str
    exact: str
    source: SearchResultSourceOut
    citation_label: str | None


class SearchResultPageOut(SearchResultTitledOut):
    type: Literal["page"]
    id: UUID


class SearchResultMessageOut(SearchResultLocatorBackedOut[Literal["message"]]):
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
    id: UUID
    source: SearchResultSourceOut
    apparatus_kind: str


class SearchResultConversationOut(SearchResultTitledOut):
    type: Literal["conversation"]
    id: UUID


class ConversationArtifactSearchOut(SearchResultTitledOut):
    """A Conversation Dossier claim; the revision ref keeps the exact cited text."""

    type: Literal["artifact"]
    id: UUID
    revision_id: UUID
    subject_ref: str


class SearchResultWebOut(SearchResultLocatorBackedOut[Literal["web_result"]]):
    """A persisted public-web result, one per external snapshot (``id`` is the snapshot)."""

    id: str
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


RESULT_MODELS: dict[str, type[SearchResultBaseOut]] = {
    "media": SearchResultMediaOut,
    "episode": SearchResultMediaOut,
    "video": SearchResultMediaOut,
    "podcast": SearchResultPodcastOut,
    "content_chunk": SearchResultContentChunkOut,
    "fragment": SearchResultFragmentOut,
    "contributor": SearchResultContributorOut,
    "page": SearchResultPageOut,
    "note_block": SearchResultNoteBlockOut,
    "highlight": SearchResultHighlightOut,
    "message": SearchResultMessageOut,
    "evidence_span": SearchResultEvidenceSpanOut,
    "reader_apparatus_item": SearchResultReaderApparatusItemOut,
    "conversation": SearchResultConversationOut,
    "artifact": ConversationArtifactSearchOut,
    "web_result": SearchResultWebOut,
}
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
    has_more: bool = False
    next_cursor: str | None

    model_config = ConfigDict(extra="forbid")


class SearchResponse(BaseModel):
    results: list[SearchResultOut]
    page: SearchPageInfo

    model_config = ConfigDict(extra="forbid")
