"""The locator grammar: where a passage is, for chat, search, the reader and evidence.

One discriminated union, validated wherever a locator enters storage or a response,
and which locator kinds each locator-backed search result type may carry.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, NotRequired, TypedDict
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    TypeAdapter,
    WithJsonSchema,
    model_validator,
    with_config,
)

LocationPrecision = Literal["exact", "approximate", "page", "time"]


@with_config(ConfigDict(extra="allow", strict=True))
class _TextQuoteGrammar(TypedDict):
    exact: str
    prefix: NotRequired[str | None]
    suffix: NotRequired[str | None]


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


MediaRetrievalLocator = Annotated[
    WebTextOffsetsLocator
    | EpubFragmentOffsetsLocator
    | PdfPageGeometryLocator
    | PdfPageLocator
    | TranscriptTimeRangeLocator
    | PlaybackTimeRangeLocator,
    Field(discriminator="type"),
]


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
    "pdf_page",
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
        "pdf_page",
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


_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)


def validate_locator_for_result_type(
    result_type: LocatorBackedResultType,
    locator: RetrievalLocator,
) -> None:
    if locator.type not in _LOCATOR_TYPES_BY_RESULT_TYPE[result_type]:
        raise ValueError(f"{result_type} locator type is invalid")


def retrieval_locator_json(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return _LOCATOR_ADAPTER.validate_python(value).model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )
