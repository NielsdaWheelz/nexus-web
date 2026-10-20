"""The application schemas 0293's frozen code validates against, from d6f04890c.

Each section is copied from the d6f04890c module named above it, narrowed to the
definitions 0293 reaches.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, NotRequired, TypedDict
from uuid import UUID

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    TypeAdapter,
    WithJsonSchema,
    model_validator,
    with_config,
)

# python/nexus/schemas/document_embeds.py
DocumentEmbedProvider = Literal[
    "youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"
]
DocumentEmbedKind = Literal["video", "post", "audio", "link_preview", "unknown"]
DocumentEmbedSourceShape = Literal[
    "iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"
]


# python/nexus/schemas/x_source.py
Nonempty = Annotated[str, Field(min_length=1)]
RevisionId = Annotated[str, Field(pattern=r"^[0-9]+$")]
type XSourceScope = Literal["author_thread", "post"]
type XReferenceKind = Literal["quoted", "replied_to", "retweeted"]


class _SourceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class XSourceAuthor(_SourceModel):
    id: Nonempty
    name: str
    username: Nonempty


class XSourceUrl(_SourceModel):
    url: Nonempty
    expanded_url: str | None
    display_url: str | None
    title: str | None
    attachment_media_key: str | None


class XSourceAttachment(_SourceModel):
    media_key: Nonempty
    type: Nonempty
    url: str | None
    preview_image_url: str | None
    alt_text: str | None


class XSourceReference(_SourceModel):
    kind: XReferenceKind
    target_revision_id: RevisionId


class XPostContent(_SourceModel):
    """Provider-authored content only; identity and observation times live outside it."""

    author: XSourceAuthor
    text: str
    created_at: AwareDatetime | None
    language: str | None
    conversation_id: RevisionId | None
    in_reply_to_user_id: Nonempty | None
    urls: tuple[XSourceUrl, ...]
    attachments: tuple[XSourceAttachment, ...]
    references: tuple[XSourceReference, ...]

    @model_validator(mode="after")
    def validate_references(self) -> XPostContent:
        keys = [(item.kind, item.target_revision_id) for item in self.references]
        if len(keys) != len(set(keys)):
            raise ValueError("post references must be unique")
        if sum(item.kind == "replied_to" for item in self.references) > 1:
            raise ValueError("a post has at most one direct reply parent")
        if len({item.media_key for item in self.attachments}) != len(self.attachments):
            raise ValueError("post attachment keys must be unique")
        return self


class XSourcePost(_SourceModel):
    source_revision_id: RevisionId
    logical_post_id: RevisionId | None
    edit_history_ids: tuple[RevisionId, ...] | None
    content: XPostContent
    availability: Literal["available", "unavailable"]
    body_captured_at: AwareDatetime | None
    checked_at: AwareDatetime | None

    @model_validator(mode="after")
    def validate_lineage(self) -> XSourcePost:
        if self.edit_history_ids is None:
            if self.logical_post_id is not None:
                raise ValueError("logical identity requires proved edit lineage")
            return self
        history = self.edit_history_ids
        if not history or len(set(history)) != len(history):
            raise ValueError("edit lineage must be nonempty and unique")
        if self.logical_post_id != history[0] or self.source_revision_id not in history:
            raise ValueError("source revision and logical identity must agree with edit lineage")
        if tuple(sorted(history, key=int)) != history:
            raise ValueError("edit lineage must be in revision order")
        return self


# python/nexus/schemas/reader.py
QUOTE_MAX_CODE_POINTS = 256
QUOTE_CONTEXT_MAX_CODE_POINTS = 128


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("value cannot be blank")
    return value


NonBlankStr = Annotated[str, AfterValidator(_non_blank)]


class ReaderStateModel(BaseModel):
    """Base model for persisted reader resume state payloads."""

    model_config = ConfigDict(extra="forbid")


class ReaderTextLocations(ReaderStateModel):
    text_offset: int | None = Field(ge=0)
    progression: float | None = Field(ge=0.0, le=1.0)
    total_progression: float | None = Field(ge=0.0, le=1.0)
    position: int | None = Field(ge=1)


class ReaderQuoteContext(ReaderStateModel):
    quote: NonBlankStr | None = Field(max_length=QUOTE_MAX_CODE_POINTS)
    quote_prefix: NonBlankStr | None = Field(max_length=QUOTE_CONTEXT_MAX_CODE_POINTS)
    quote_suffix: NonBlankStr | None = Field(max_length=QUOTE_CONTEXT_MAX_CODE_POINTS)

    @model_validator(mode="after")
    def validate_quote_context(self) -> "ReaderQuoteContext":
        if self.quote is None and (self.quote_prefix is not None or self.quote_suffix is not None):
            raise ValueError("quote_prefix and quote_suffix require quote")
        return self


class ReaderFragmentTarget(ReaderStateModel):
    fragment_id: NonBlankStr


class ReaderEpubTarget(ReaderStateModel):
    fragment_id: UUID
    href_path: NonBlankStr
    anchor_id: Annotated[str, Field(min_length=1), AfterValidator(_non_blank)] | None


class PdfReaderResumeState(ReaderStateModel):
    kind: Literal["pdf"]
    page: int = Field(ge=1)
    page_progression: float | None = Field(ge=0.0, le=1.0)
    zoom: float | None = Field(ge=0.25, le=4.0)
    position: int | None = Field(ge=1)


class WebReaderResumeState(ReaderStateModel):
    kind: Literal["web"]
    target: ReaderFragmentTarget
    locations: ReaderTextLocations
    text: ReaderQuoteContext


class XReaderResumeState(ReaderStateModel):
    """A displayed occurrence of one canonical X post, inside its reading publication."""

    kind: Literal["x"]
    occurrence_id: NonBlankStr
    post_media_id: UUID
    source_revision_id: NonBlankStr
    locations: ReaderTextLocations
    text: ReaderQuoteContext


class TranscriptReaderResumeState(ReaderStateModel):
    kind: Literal["transcript"]
    target: ReaderFragmentTarget
    locations: ReaderTextLocations
    text: ReaderQuoteContext


class EpubReaderResumeState(ReaderStateModel):
    kind: Literal["epub"]
    target: ReaderEpubTarget
    locations: ReaderTextLocations
    text: ReaderQuoteContext


ReaderResumeState = Annotated[
    PdfReaderResumeState
    | WebReaderResumeState
    | TranscriptReaderResumeState
    | EpubReaderResumeState
    | XReaderResumeState,
    Field(discriminator="kind"),
]


class ReaderUnresolvedPosition(BaseModel):
    """Frozen evidence of the last position, never replaced by a guessed current location."""

    model_config = ConfigDict(extra="forbid")
    previous_locator: ReaderResumeState
    from_generation: int = Field(ge=1)
    post_media_id: UUID | None
    source_revision_id: str | None
    excerpt: str
    offset_in_excerpt: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_excerpt(self) -> "ReaderUnresolvedPosition":
        if self.offset_in_excerpt > len(self.excerpt):
            raise ValueError("saved position exceeds its frozen excerpt")
        return self


class StoredReaderCursorPositioned(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tag: Literal["Positioned"] = "Positioned"
    locator: ReaderResumeState


class StoredReaderCursorUnresolved(ReaderUnresolvedPosition):
    tag: Literal["Unresolved"] = "Unresolved"


StoredReaderCursor = Annotated[
    StoredReaderCursorPositioned | StoredReaderCursorUnresolved, Field(discriminator="tag")
]


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


class NavigationTextPointOut(_Strict):
    """An exact canonical codepoint boundary within one source fragment."""

    fragment_id: UUID
    offset: int = Field(ge=0, strict=True)


class NavigationTextRangeOut(_Strict):
    """A semantic extent, potentially spanning several canonical fragments."""

    start: NavigationTextPointOut
    end: NavigationTextPointOut


# python/nexus/schemas/reader_apparatus.py
class NotesGroup(BaseModel):
    range: NavigationTextRangeOut
    heading: NavigationTextPointOut | None
    provenance: Literal["Declared", "Inferred"]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> "NotesGroup":
        start, end = self.range.start, self.range.end
        if start.fragment_id == end.fragment_id and start.offset >= end.offset:
            raise ValueError("note group requires a nonempty range")
        if self.heading is not None and (
            (self.heading.fragment_id == start.fragment_id and self.heading.offset < start.offset)
            or (self.heading.fragment_id == end.fragment_id and self.heading.offset >= end.offset)
        ):
            raise ValueError("note group heading must lie within its range")
        return self


# python/nexus/schemas/retrieval.py
@with_config(ConfigDict(extra="allow", strict=True))
class _TextQuoteGrammar(TypedDict):
    exact: str
    prefix: NotRequired[str]
    suffix: NotRequired[str]


_TEXT_QUOTE_ADAPTER = TypeAdapter(_TextQuoteGrammar)


def _validate_text_quote(value: dict[str, Any]) -> dict[str, Any]:
    _TEXT_QUOTE_ADAPTER.validate_python(value, strict=True)
    # The dictionary serializer preserves extension values, omission and key order.
    return value


type TextQuoteSelector = Annotated[
    dict[str, Any],
    AfterValidator(_validate_text_quote),
    WithJsonSchema(_TEXT_QUOTE_ADAPTER.json_schema()),
]


class WebTextOffsetsLocator(BaseModel):
    type: Literal["web_text_offsets"]
    media_id: UUID | str
    fragment_id: UUID | str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    media_kind: str | None = None
    text_quote_selector: TextQuoteSelector | None = None

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
    text_quote_selector: TextQuoteSelector | None = None

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
    text_quote_selector: TextQuoteSelector | None = None
    body_version: int | None = Field(default=None, ge=1)

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


class PdfPageLocator(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["pdf_page"] = "pdf_page"
    media_id: UUID | str
    page_number: int = Field(ge=1)


class PdfPageGeometryLocator(BaseModel):
    type: Literal["pdf_page_geometry"]
    media_id: UUID | str
    page_number: int = Field(ge=1)
    quads: list[PdfGeometryQuad] = Field(min_length=1, max_length=512)
    exact: str
    prefix: str | None = None
    suffix: str | None = None
    text_quote_selector: TextQuoteSelector | None = None
    projection: Literal["proportional_text_offsets"] | None = None

    model_config = ConfigDict(extra="forbid")


class TranscriptTimeRangeLocator(BaseModel):
    type: Literal["transcript_time_range"]
    media_id: UUID | str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    text_quote_selector: TextQuoteSelector | None = None

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
    text_quote_selector: TextQuoteSelector | None = None

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


RetrievalLocator = Annotated[
    WebTextOffsetsLocator
    | EpubFragmentOffsetsLocator
    | NoteBlockOffsetsLocator
    | PdfPageGeometryLocator
    | PdfPageLocator
    | TranscriptTimeRangeLocator
    | PlaybackTimeRangeLocator
    | MessageOffsetsLocator
    | ExternalUrlLocator,
    Field(discriminator="type"),
]


_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)


def retrieval_locator_json(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return _LOCATOR_ADAPTER.validate_python(value).model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )
