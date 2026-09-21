"""Reader target, profile, and persisted resume-state schemas."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, FiniteFloat, model_validator

from nexus.schemas.presence import Presence

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]
FocusModeValue = Literal["off", "distraction_free", "paragraph", "sentence"]
HyphenationValue = Literal["auto", "off"]
QUOTE_MAX_CODE_POINTS = 256
QUOTE_CONTEXT_MAX_CODE_POINTS = 128


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("value cannot be blank")
    return value


NonBlankStr = Annotated[str, AfterValidator(_non_blank)]


class ReaderTargetModel(BaseModel):
    """Strict wire base for current reader navigation targets."""

    model_config = ConfigDict(extra="forbid", strict=True)


class ReaderTimeRange(ReaderTargetModel):
    start_ms: Annotated[int, Field(ge=0, le=2**53 - 1)]
    end_ms: Annotated[int, Field(ge=0, le=2**53 - 1)]

    @model_validator(mode="after")
    def validate_order(self) -> "ReaderTimeRange":
        if self.start_ms >= self.end_ms:
            raise ValueError("start_ms must be less than end_ms")
        return self


class HighlightTargetPdfQuadOut(ReaderTargetModel):
    x1: FiniteFloat
    y1: FiniteFloat
    x2: FiniteFloat
    y2: FiniteFloat
    x3: FiniteFloat
    y3: FiniteFloat
    x4: FiniteFloat
    y4: FiniteFloat


class ReaderTextOffsets(ReaderTargetModel):
    start_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]
    end_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]

    @model_validator(mode="after")
    def validate_offsets(self) -> "ReaderTextOffsets":
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class WebTextOffsetsTargetOut(ReaderTextOffsets):
    kind: Literal["WebTextOffsets"] = "WebTextOffsets"
    fragment_id: UUID


class EpubTextOffsetsTargetOut(ReaderTextOffsets):
    kind: Literal["EpubTextOffsets"] = "EpubTextOffsets"
    fragment_id: UUID


class TranscriptTextOffsetsTargetOut(ReaderTextOffsets):
    kind: Literal["TranscriptTextOffsets"] = "TranscriptTextOffsets"
    fragment_id: UUID
    time_range: Presence[ReaderTimeRange]


class PdfPageGeometryTargetOut(ReaderTargetModel):
    kind: Literal["PdfPageGeometry"] = "PdfPageGeometry"
    page_number: Annotated[int, Field(ge=1, le=2**31 - 1)]
    quads: Annotated[list[HighlightTargetPdfQuadOut], Field(min_length=1, max_length=512)]


ResolvedHighlightReaderTarget = Annotated[
    WebTextOffsetsTargetOut
    | EpubTextOffsetsTargetOut
    | TranscriptTextOffsetsTargetOut
    | PdfPageGeometryTargetOut,
    Field(discriminator="kind"),
]


class ResolvedHighlightReaderTargetResponse(ReaderTargetModel):
    data: ResolvedHighlightReaderTarget


class ReaderProfileOut(BaseModel):
    """Exactly the seven preference fields; ``created_at`` never appears here."""

    theme: ThemeValue
    font_size_px: int = Field(ge=12, le=28)
    line_height: float = Field(ge=1.2, le=2.2)
    font_family: FontFamilyValue
    column_width_ch: int = Field(ge=40, le=120)
    focus_mode: FocusModeValue
    hyphenation: HyphenationValue

    model_config = ConfigDict(from_attributes=True, frozen=True)


class ReaderProfilePatch(BaseModel):
    """Partial update; numeric strings must fail rather than silently coerce."""

    theme: ThemeValue | None = None
    font_size_px: int | None = Field(default=None, ge=12, le=28)
    line_height: float | None = Field(default=None, ge=1.2, le=2.2)
    font_family: FontFamilyValue | None = None
    column_width_ch: int | None = Field(default=None, ge=40, le=120)
    focus_mode: FocusModeValue | None = None
    hyphenation: HyphenationValue | None = None

    model_config = ConfigDict(strict=True, extra="forbid")

    @model_validator(mode="after")
    def validate_patch(self) -> "ReaderProfilePatch":
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


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
    anchor_id: Presence[Annotated[str, Field(min_length=1), AfterValidator(_non_blank)]]


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
    | EpubReaderResumeState,
    Field(discriminator="kind"),
]


class ReaderCursorEmpty(BaseModel):
    """No positioned cursor: an absent row is revision 0, a tombstone is >= 1."""

    model_config = ConfigDict(extra="forbid")
    state: Literal["Empty"] = "Empty"
    revision: int = Field(default=0, ge=0)


class ReaderCursorPositioned(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["Positioned"] = "Positioned"
    revision: int = Field(ge=1)
    locator: ReaderResumeState


ReaderCursorSnapshot = ReaderCursorEmpty | ReaderCursorPositioned


class CursorWrite(BaseModel):
    """Conditional cursor replacement against an acknowledged base revision."""

    model_config = ConfigDict(extra="forbid")
    locator: ReaderResumeState
    base_revision: int = Field(ge=0)
