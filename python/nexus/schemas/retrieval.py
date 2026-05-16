"""Shared retrieval ref and locator contracts for chat/search evidence."""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, TypeAdapter, model_validator


class RetrievalContextRef(BaseModel):
    type: Literal[
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
        "artifact",
        "artifact_part",
    ]
    id: UUID | str
    evidence_span_ids: list[UUID | str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class MediaRetrievalResultRef(BaseModel):
    type: Literal["media"]
    id: UUID | str
    result_type: Literal["media"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_media_ref(self) -> MediaRetrievalResultRef:
        if self.context_ref.type != "media":
            raise ValueError("media context_ref.type must be media")
        return self


class PodcastRetrievalResultRef(BaseModel):
    type: Literal["podcast"]
    id: UUID | str
    result_type: Literal["podcast"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: None = None
    media_kind: None = None
    contributors: list[dict[str, Any]] = Field(default_factory=list)
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_podcast_ref(self) -> PodcastRetrievalResultRef:
        if self.context_ref.type != "podcast":
            raise ValueError("podcast context_ref.type must be podcast")
        return self


class EpisodeRetrievalResultRef(BaseModel):
    type: Literal["episode"]
    id: UUID | str
    result_type: Literal["episode"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_episode_ref(self) -> EpisodeRetrievalResultRef:
        if self.context_ref.type != "media":
            raise ValueError("episode context_ref.type must be media")
        return self


class VideoRetrievalResultRef(BaseModel):
    type: Literal["video"]
    id: UUID | str
    result_type: Literal["video"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_video_ref(self) -> VideoRetrievalResultRef:
        if self.context_ref.type != "media":
            raise ValueError("video context_ref.type must be media")
        return self


class ContentChunkRetrievalResultRef(BaseModel):
    type: Literal["content_chunk"]
    id: UUID | str
    result_type: Literal["content_chunk"]
    source_id: str
    source_kind: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    citation_label: str
    context_ref: RetrievalContextRef
    evidence_span_id: UUID | str | None = None
    evidence_span_ids: list[UUID | str] = Field(default_factory=list)
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_content_chunk_ref(self) -> ContentChunkRetrievalResultRef:
        if self.context_ref.type != "content_chunk":
            raise ValueError("content_chunk context_ref.type must be content_chunk")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class FragmentRetrievalResultRef(BaseModel):
    type: Literal["fragment"]
    id: UUID | str
    result_type: Literal["fragment"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    citation_label: str | None = None
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_fragment_ref(self) -> FragmentRetrievalResultRef:
        if self.context_ref.type != "fragment":
            raise ValueError("fragment context_ref.type must be fragment")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class ContributorRetrievalResultRef(BaseModel):
    type: Literal["contributor"]
    id: str
    result_type: Literal["contributor"]
    source_id: str
    contributor_handle: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_contributor_ref(self) -> ContributorRetrievalResultRef:
        if self.context_ref.type != "contributor":
            raise ValueError("contributor context_ref.type must be contributor")
        return self


class PageRetrievalResultRef(BaseModel):
    type: Literal["page"]
    id: UUID | str
    result_type: Literal["page"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    description: str | None = None
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: None = None
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_page_ref(self) -> PageRetrievalResultRef:
        if self.context_ref.type != "page":
            raise ValueError("page context_ref.type must be page")
        return self


class NoteBlockRetrievalResultRef(BaseModel):
    type: Literal["note_block"]
    id: UUID | str
    result_type: Literal["note_block"]
    source_id: str
    page_id: UUID | str
    page_title: str
    body_text: str
    highlight_excerpt: str | None = None
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_note_block_ref(self) -> NoteBlockRetrievalResultRef:
        if self.context_ref.type != "note_block":
            raise ValueError("note_block context_ref.type must be note_block")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class HighlightRetrievalResultRef(BaseModel):
    type: Literal["highlight"]
    id: UUID | str
    result_type: Literal["highlight"]
    source_id: str
    color: str
    exact: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    citation_label: str | None = None
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: UUID | str | None = None
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_highlight_ref(self) -> HighlightRetrievalResultRef:
        if self.context_ref.type != "highlight":
            raise ValueError("highlight context_ref.type must be highlight")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class MessageRetrievalResultRef(BaseModel):
    type: Literal["message"]
    id: UUID | str
    result_type: Literal["message"]
    source_id: str
    conversation_id: UUID | str
    seq: int
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_message_ref(self) -> MessageRetrievalResultRef:
        if self.context_ref.type != "message":
            raise ValueError("message context_ref.type must be message")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class WebRetrievalResultRef(BaseModel):
    type: Literal["web_result"]
    id: str
    result_type: Literal["web_result"]
    result_ref: str
    source_id: str
    title: str
    url: str
    display_url: str | None = None
    deep_link: str
    snippet: str
    extra_snippets: list[str] = Field(default_factory=list)
    published_at: str | None = None
    source_name: str | None = None
    rank: int | None = None
    provider: str | None = None
    provider_request_id: str | None = None
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    context_ref: RetrievalContextRef
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_web_ref(self) -> WebRetrievalResultRef:
        if self.context_ref.type != "web_result":
            raise ValueError("web context_ref.type must be web_result")
        if self.locator.type != "external_url":
            raise ValueError("web_result locator must be external_url")
        return self


class ArtifactPartRetrievalResultRef(BaseModel):
    type: Literal["artifact_part"]
    id: UUID | str
    result_type: Literal["artifact_part"]
    source_id: str
    artifact_id: UUID | str
    message_id: UUID | str
    conversation_id: UUID | str
    artifact_kind: str
    artifact_title: str | None = None
    part_key: str | None = None
    part_type: str | None = None
    title: str
    source_label: str | None = None
    snippet: str | None = None
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_artifact_part_ref(self) -> ArtifactPartRetrievalResultRef:
        if self.context_ref.type != "artifact_part":
            raise ValueError("artifact_part context_ref.type must be artifact_part")
        if self.locator.type != "artifact_part_ref":
            raise ValueError("artifact_part result_ref locator must be artifact_part_ref")
        return self


class EvidenceSpanRetrievalResultRef(BaseModel):
    type: Literal["evidence_span"]
    id: UUID | str
    result_type: Literal["evidence_span"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    citation_label: str
    context_ref: RetrievalContextRef
    evidence_span_id: UUID | str
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    media_id: UUID | str
    media_kind: str | None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_evidence_span_ref(self) -> EvidenceSpanRetrievalResultRef:
        if self.context_ref.type != "evidence_span":
            raise ValueError("evidence_span context_ref.type must be evidence_span")
        validate_locator_for_result_type(self.type, self.locator)
        return self


class ConversationRetrievalResultRef(BaseModel):
    type: Literal["conversation"]
    id: UUID | str
    result_type: Literal["conversation"]
    source_id: str
    title: str
    source_label: str | None = None
    snippet: str
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_conversation_ref(self) -> ConversationRetrievalResultRef:
        if self.context_ref.type != "conversation":
            raise ValueError("conversation context_ref.type must be conversation")
        return self


class ArtifactRetrievalResultRef(BaseModel):
    type: Literal["artifact"]
    id: UUID | str
    result_type: Literal["artifact"]
    source_id: str
    conversation_id: UUID | str
    message_id: UUID | str
    artifact_kind: str
    title: str
    source_label: str | None = None
    snippet: str | None = None
    deep_link: str
    context_ref: RetrievalContextRef
    source_version: None = None
    locator: None = None
    media_id: None = None
    media_kind: None = None
    score: float | None = None
    selected: bool = False

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_artifact_ref(self) -> ArtifactRetrievalResultRef:
        if self.context_ref.type != "artifact":
            raise ValueError("artifact context_ref.type must be artifact")
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
    | ArtifactPartRetrievalResultRef
    | EvidenceSpanRetrievalResultRef
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
    page_id: UUID | str
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
    transcript_version_id: UUID | str | None = None
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    text_quote_selector: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_time_range(self) -> TranscriptTimeRangeLocator:
        if self.t_end_ms <= self.t_start_ms:
            raise ValueError("t_end_ms must be greater than t_start_ms")
        return self


class AudioTimeRangeLocator(BaseModel):
    type: Literal["audio_time_range"]
    media_id: UUID | str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    transcript_version_id: UUID | str | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_time_range(self) -> AudioTimeRangeLocator:
        if self.t_end_ms <= self.t_start_ms:
            raise ValueError("t_end_ms must be greater than t_start_ms")
        return self


class VideoTimeRangeLocator(BaseModel):
    type: Literal["video_time_range"]
    media_id: UUID | str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    transcript_version_id: UUID | str | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_time_range(self) -> VideoTimeRangeLocator:
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


class ArtifactPartRefLocator(BaseModel):
    type: Literal["artifact_part_ref"]
    artifact_id: UUID | str
    artifact_part_id: UUID | str
    message_id: UUID | str
    conversation_id: UUID | str
    part_key: str | None = None

    model_config = ConfigDict(extra="forbid")


TypedRetrievalLocator = Annotated[
    WebTextOffsetsLocator
    | EpubFragmentOffsetsLocator
    | NoteBlockOffsetsLocator
    | PdfPageGeometryLocator
    | TranscriptTimeRangeLocator
    | AudioTimeRangeLocator
    | VideoTimeRangeLocator
    | MessageOffsetsLocator
    | ExternalUrlLocator
    | ArtifactPartRefLocator,
    Field(discriminator="type"),
]

RetrievalLocator = TypedRetrievalLocator


_CONTEXT_REF_ADAPTER = TypeAdapter(RetrievalContextRef)
_RESULT_REF_ADAPTER = TypeAdapter(RetrievalResultRef)
_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)


def validate_locator_for_result_type(result_type: str, locator: RetrievalLocator) -> None:
    source_locator_types = {
        "web_text_offsets",
        "epub_fragment_offsets",
        "pdf_page_geometry",
        "transcript_time_range",
        "audio_time_range",
        "video_time_range",
    }
    match result_type:
        case "content_chunk" | "fragment" | "highlight" | "evidence_span":
            expected = source_locator_types
        case "note_block":
            expected = {"note_block_offsets"}
        case "message":
            expected = {"message_offsets"}
        case "web_result":
            expected = {"external_url"}
        case "artifact_part":
            expected = {"artifact_part_ref"}
        case _:
            raise ValueError(f"{result_type} locator is not supported")
    if locator.type not in expected:
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
