"""Shared retrieval ref and locator contracts for chat/search evidence."""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, NewType, cast
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    TypeAdapter,
    model_validator,
)

from nexus.schemas.search_types import SEARCH_RESULT_TYPES

ProviderResultRef = NewType("ProviderResultRef", str)
ExternalSnapshotId = NewType("ExternalSnapshotId", UUID)


class RetrievalContextRef(BaseModel):
    type: SEARCH_RESULT_TYPES
    id: UUID | str
    evidence_span_ids: list[UUID | str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class RetrievalResultRefBase(BaseModel):
    """Envelope fields shared by every typed retrieval result ref.

    ``context_ref_type`` is the context scheme this result type addresses; it is
    the result type itself except for episode/video, which both address media.
    """

    context_ref_type: ClassVar[SEARCH_RESULT_TYPES]

    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    citation_target: str | None = None
    context_ref: RetrievalContextRef
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_envelope(self) -> RetrievalResultRefBase:
        if self.context_ref.type != self.context_ref_type:
            raise ValueError(f"context_ref.type must be {self.context_ref_type}")
        # Only the locator-backed result types declare a locator, and each of
        # those addresses a context scheme of its own name.
        locator = getattr(self, "locator", None)
        if locator is not None:
            validate_locator_for_result_type(
                cast(LocatorBackedResultType, self.context_ref_type), locator
            )
        return self


class MediaRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "media"

    type: Literal["media"]
    id: UUID | str
    result_type: Literal["media"]
    source_id: str
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None


class PodcastRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "podcast"

    type: Literal["podcast"]
    id: UUID | str
    result_type: Literal["podcast"]
    source_id: str
    locator: None = None
    media_id: None = None
    media_kind: None = None
    contributors: list[dict[str, Any]] = Field(default_factory=list)


class EpisodeRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "media"

    type: Literal["episode"]
    id: UUID | str
    result_type: Literal["episode"]
    source_id: str
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None


class VideoRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "media"

    type: Literal["video"]
    id: UUID | str
    result_type: Literal["video"]
    source_id: str
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None


class ContentChunkRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "content_chunk"

    type: Literal["content_chunk"]
    id: UUID | str
    result_type: Literal["content_chunk"]
    source_id: str
    source_kind: str
    citation_label: str
    evidence_span_id: UUID | str | None = None
    evidence_span_ids: list[UUID | str] = Field(default_factory=list)
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None


class FragmentRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "fragment"

    type: Literal["fragment"]
    id: UUID | str
    result_type: Literal["fragment"]
    source_id: str
    citation_label: str | None = None
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None


class ContributorRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "contributor"

    type: Literal["contributor"]
    id: str
    result_type: Literal["contributor"]
    source_id: str
    contributor_handle: str
    locator: None = None
    media_id: None = None
    media_kind: None = None


class PageRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "page"

    type: Literal["page"]
    id: UUID | str
    result_type: Literal["page"]
    source_id: str
    locator: None = None
    media_id: None = None
    media_kind: None = None


class NoteBlockRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "note_block"

    type: Literal["note_block"]
    id: UUID | str
    result_type: Literal["note_block"]
    source_id: str
    body_text: str
    highlight_excerpt: str | None = None
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None


class HighlightRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "highlight"

    type: Literal["highlight"]
    id: UUID | str
    result_type: Literal["highlight"]
    source_id: str
    color: str
    exact: str
    citation_label: str | None = None
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None


class MessageRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "message"

    type: Literal["message"]
    id: UUID | str
    result_type: Literal["message"]
    source_id: str
    conversation_id: UUID | str
    seq: int
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None


class WebRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "web_result"

    type: Literal["web_result"]
    id: ExternalSnapshotId
    result_type: Literal["web_result"]
    result_ref: ProviderResultRef
    source_id: ExternalSnapshotId
    url: str
    display_url: str | None = None
    extra_snippets: list[str] = Field(default_factory=list)
    published_at: str | None = None
    source_name: str | None = None
    rank: int | None = None
    provider: str | None = None
    provider_request_id: str | None = None
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None

    @model_validator(mode="after")
    def validate_snapshot_identity(self) -> WebRetrievalResultRef:
        if self.id != self.source_id:
            raise ValueError("web_result id must match source_id")
        if str(self.context_ref.id) != str(self.source_id):
            raise ValueError("web_result context_ref.id must match source_id")
        return self


class EvidenceSpanRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "evidence_span"

    type: Literal["evidence_span"]
    id: UUID | str
    result_type: Literal["evidence_span"]
    source_id: str
    citation_label: str
    evidence_span_id: UUID | str
    locator: RetrievalLocator
    media_id: UUID | str
    media_kind: str | None = None


class ReaderApparatusItemRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "reader_apparatus_item"

    type: Literal["reader_apparatus_item"]
    id: UUID | str
    result_type: Literal["reader_apparatus_item"]
    source_id: str
    apparatus_kind: str
    locator: RetrievalLocator
    media_id: UUID | str
    media_kind: str | None = None


class ConversationRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "conversation"

    type: Literal["conversation"]
    id: UUID | str
    result_type: Literal["conversation"]
    source_id: str
    locator: None = None
    media_id: None = None
    media_kind: None = None


class ArtifactRetrievalResultRef(RetrievalResultRefBase):
    context_ref_type: ClassVar[SEARCH_RESULT_TYPES] = "artifact"

    type: Literal["artifact"]
    id: UUID | str
    result_type: Literal["artifact"]
    source_id: str
    revision_id: UUID | str
    subject_ref: str
    locator: None = None
    media_id: None = None
    media_kind: None = None

    @model_validator(mode="after")
    def validate_subject_identity(self) -> ArtifactRetrievalResultRef:
        if str(self.id) != self.source_id or str(self.context_ref.id) != self.source_id:
            raise ValueError("artifact id, source_id, and context_ref.id must match")
        if self.subject_ref != f"conversation:{self.source_id}":
            raise ValueError("artifact subject_ref must identify its conversation")
        return self


RetrievalResultRef = Annotated[
    MediaRetrievalResultRef
    | PodcastRetrievalResultRef
    | EpisodeRetrievalResultRef
    | VideoRetrievalResultRef
    | ContentChunkRetrievalResultRef
    | FragmentRetrievalResultRef
    | ContributorRetrievalResultRef
    | PageRetrievalResultRef
    | NoteBlockRetrievalResultRef
    | HighlightRetrievalResultRef
    | MessageRetrievalResultRef
    | WebRetrievalResultRef
    | EvidenceSpanRetrievalResultRef
    | ReaderApparatusItemRetrievalResultRef
    | ConversationRetrievalResultRef
    | ArtifactRetrievalResultRef,
    Field(discriminator="type"),
]


class WebTextOffsetsLocator(BaseModel):
    type: Literal["web_text_offsets"]
    media_id: UUID | str
    fragment_id: UUID | str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    media_kind: str | None = None
    text_quote_selector: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> WebTextOffsetsLocator:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class EpubFragmentOffsetsLocator(BaseModel):
    type: Literal["epub_fragment_offsets"]
    media_id: UUID | str
    section_id: UUID | str | None = None
    fragment_id: UUID | str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    media_kind: str | None = None
    text_quote_selector: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> EpubFragmentOffsetsLocator:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class NoteBlockOffsetsLocator(BaseModel):
    type: Literal["note_block_offsets"]
    block_id: UUID | str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> NoteBlockOffsetsLocator:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class PdfGeometryQuad(BaseModel):
    x1: FiniteFloat
    y1: FiniteFloat
    x2: FiniteFloat
    y2: FiniteFloat
    x3: FiniteFloat
    y3: FiniteFloat
    x4: FiniteFloat
    y4: FiniteFloat

    model_config = ConfigDict(extra="forbid")


class PdfPageGeometryLocator(BaseModel):
    type: Literal["pdf_page_geometry"]
    media_id: UUID | str
    page_number: int = Field(ge=1)
    quads: list[PdfGeometryQuad] = Field(min_length=1, max_length=512)
    exact: str
    prefix: str | None = None
    suffix: str | None = None
    text_quote_selector: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")


class TranscriptTimeRangeLocator(BaseModel):
    type: Literal["transcript_time_range"]
    media_id: UUID | str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    text_quote_selector: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_time_range(self) -> TranscriptTimeRangeLocator:
        if self.t_end_ms <= self.t_start_ms:
            raise ValueError("t_end_ms must be greater than t_start_ms")
        return self


class PlaybackTimeRangeLocator(BaseModel):
    type: Literal["audio_time_range", "video_time_range"]
    media_id: UUID | str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_time_range(self) -> PlaybackTimeRangeLocator:
        if self.t_end_ms <= self.t_start_ms:
            raise ValueError("t_end_ms must be greater than t_start_ms")
        return self


class MessageOffsetsLocator(BaseModel):
    type: Literal["message_offsets"]
    conversation_id: UUID | str
    message_id: UUID | str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    message_seq: int | None = Field(default=None, ge=1)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> MessageOffsetsLocator:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class ExternalUrlLocator(BaseModel):
    type: Literal["external_url"]
    url: str
    title: str | None = None
    display_url: str | None = None
    accessed_at: str | None = None

    model_config = ConfigDict(extra="forbid")


MediaRetrievalLocator = Annotated[
    WebTextOffsetsLocator
    | EpubFragmentOffsetsLocator
    | PdfPageGeometryLocator
    | TranscriptTimeRangeLocator
    | PlaybackTimeRangeLocator,
    Field(discriminator="type"),
]


RetrievalLocator = Annotated[
    WebTextOffsetsLocator
    | EpubFragmentOffsetsLocator
    | NoteBlockOffsetsLocator
    | PdfPageGeometryLocator
    | TranscriptTimeRangeLocator
    | PlaybackTimeRangeLocator
    | MessageOffsetsLocator
    | ExternalUrlLocator,
    Field(discriminator="type"),
]

LocatorBackedResultType = Literal[
    "content_chunk",
    "fragment",
    "highlight",
    "evidence_span",
    "note_block",
    "message",
    "web_result",
    "reader_apparatus_item",
]
RetrievalLocatorType = Literal[
    "web_text_offsets",
    "epub_fragment_offsets",
    "pdf_page_geometry",
    "transcript_time_range",
    "audio_time_range",
    "video_time_range",
    "note_block_offsets",
    "message_offsets",
    "external_url",
]

_SOURCE_LOCATOR_TYPES: frozenset[RetrievalLocatorType] = frozenset(
    {
        "web_text_offsets",
        "epub_fragment_offsets",
        "pdf_page_geometry",
        "transcript_time_range",
        "audio_time_range",
        "video_time_range",
    }
)
_NOTE_LOCATOR_TYPES: frozenset[RetrievalLocatorType] = frozenset({"note_block_offsets"})
_LOCATOR_TYPES_BY_RESULT_TYPE: dict[LocatorBackedResultType, frozenset[RetrievalLocatorType]] = {
    "content_chunk": _SOURCE_LOCATOR_TYPES,
    "fragment": _SOURCE_LOCATOR_TYPES,
    "highlight": _SOURCE_LOCATOR_TYPES,
    "evidence_span": _SOURCE_LOCATOR_TYPES | _NOTE_LOCATOR_TYPES,
    "note_block": _NOTE_LOCATOR_TYPES,
    "message": frozenset({"message_offsets"}),
    "web_result": frozenset({"external_url"}),
    "reader_apparatus_item": _SOURCE_LOCATOR_TYPES,
}


_CONTEXT_REF_ADAPTER = TypeAdapter(RetrievalContextRef)
_RESULT_REF_ADAPTER = TypeAdapter(RetrievalResultRef)
_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)


def validate_locator_for_result_type(
    result_type: LocatorBackedResultType,
    locator: RetrievalLocator,
) -> None:
    if locator.type not in _LOCATOR_TYPES_BY_RESULT_TYPE[result_type]:
        raise ValueError(f"{result_type} locator type is invalid")


def retrieval_context_ref_json(value: dict[str, Any]) -> dict[str, Any]:
    return _CONTEXT_REF_ADAPTER.validate_python(value).model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )


def retrieval_result_ref_json(value: dict[str, Any]) -> dict[str, Any]:
    return _RESULT_REF_ADAPTER.validate_python(value).model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )


def retrieval_locator_json(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return _LOCATOR_ADAPTER.validate_python(value).model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )
