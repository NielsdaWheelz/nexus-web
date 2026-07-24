"""Reader profile and per-media reader state schemas."""

import math
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.presence import Presence

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]
FocusModeValue = Literal["off", "distraction_free", "paragraph", "sentence"]
HyphenationValue = Literal["auto", "off"]


class ResolvedHighlightTargetModel(BaseModel):
    """Strict wire base for the one current, format-total highlight target."""

    model_config = ConfigDict(extra="forbid", strict=True)


class HighlightTargetTimeRangeOut(ResolvedHighlightTargetModel):
    start_ms: Annotated[int, Field(ge=0, le=2**53 - 1)]
    end_ms: Annotated[int, Field(ge=0, le=2**53 - 1)]

    @model_validator(mode="after")
    def validate_order(self) -> "HighlightTargetTimeRangeOut":
        if self.start_ms >= self.end_ms:
            raise ValueError("start_ms must be less than end_ms")
        return self


class HighlightTargetPdfQuadOut(ResolvedHighlightTargetModel):
    x1: float
    y1: float
    x2: float
    y2: float
    x3: float
    y3: float
    x4: float
    y4: float

    @model_validator(mode="after")
    def validate_finite(self) -> "HighlightTargetPdfQuadOut":
        if not all(
            math.isfinite(value)
            for value in (
                self.x1,
                self.y1,
                self.x2,
                self.y2,
                self.x3,
                self.y3,
                self.x4,
                self.y4,
            )
        ):
            raise ValueError("PDF quad coordinates must be finite")
        return self


class WebTextOffsetsTargetOut(ResolvedHighlightTargetModel):
    kind: Literal["WebTextOffsets"] = "WebTextOffsets"
    fragment_id: UUID
    start_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]
    end_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]

    @model_validator(mode="after")
    def validate_offsets(self) -> "WebTextOffsetsTargetOut":
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class EpubTextOffsetsTargetOut(ResolvedHighlightTargetModel):
    kind: Literal["EpubTextOffsets"] = "EpubTextOffsets"
    section_id: Annotated[str, Field(min_length=1, max_length=255)]
    fragment_id: UUID
    start_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]
    end_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]

    @model_validator(mode="after")
    def validate_offsets(self) -> "EpubTextOffsetsTargetOut":
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class TranscriptTextOffsetsTargetOut(ResolvedHighlightTargetModel):
    kind: Literal["TranscriptTextOffsets"] = "TranscriptTextOffsets"
    fragment_id: UUID
    start_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]
    end_offset: Annotated[int, Field(ge=0, le=2**31 - 1)]
    time_range: Presence[HighlightTargetTimeRangeOut]

    @model_validator(mode="after")
    def validate_offsets(self) -> "TranscriptTextOffsetsTargetOut":
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class PdfPageGeometryTargetOut(ResolvedHighlightTargetModel):
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


class ResolvedHighlightReaderTargetResponse(ResolvedHighlightTargetModel):
    data: ResolvedHighlightReaderTarget


class ReaderProfileOut(BaseModel):
    """Response schema for reader profile.

    Exactly the seven preference fields: creation metadata (``created_at``) is
    database-clock-only and never appears here.
    """

    theme: ThemeValue
    font_size_px: int = Field(ge=12, le=28)
    line_height: float = Field(ge=1.2, le=2.2)
    font_family: FontFamilyValue
    column_width_ch: int = Field(ge=40, le=120)
    focus_mode: FocusModeValue
    hyphenation: HyphenationValue

    model_config = ConfigDict(from_attributes=True, frozen=True)


class ReaderProfilePatch(BaseModel):
    """PATCH body for reader profile (partial update)."""

    theme: ThemeValue | None = None
    font_size_px: int | None = Field(default=None, ge=12, le=28)
    line_height: float | None = Field(default=None, ge=1.2, le=2.2)
    font_family: FontFamilyValue | None = None
    column_width_ch: int | None = Field(default=None, ge=40, le=120)
    focus_mode: FocusModeValue | None = None
    hyphenation: HyphenationValue | None = None

    # strict=True: numeric strings and non-integer numeric forms for the int
    # fields must fail validation rather than silently coerce.
    model_config = ConfigDict(strict=True, extra="forbid")

    @model_validator(mode="after")
    def reject_null_values(self) -> "ReaderProfilePatch":
        """Profile fields are non-nullable; explicit null should fail fast."""
        for field_name in (
            "theme",
            "font_size_px",
            "line_height",
            "font_family",
            "column_width_ch",
            "focus_mode",
            "hyphenation",
        ):
            if field_name in self.model_fields_set and getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self

    @model_validator(mode="after")
    def require_at_least_one_field(self) -> "ReaderProfilePatch":
        """An empty patch has nothing to apply and is rejected."""
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


def _reject_blank_string_fields(model: BaseModel, field_names: tuple[str, ...]) -> None:
    """Reject blank strings for the named fields on a model."""

    for field_name in field_names:
        value = getattr(model, field_name)
        if value is not None and not value.strip():
            raise ValueError(f"{field_name} cannot be blank")


class ReaderStateModel(BaseModel):
    """Base model for persisted reader resume state payloads."""

    model_config = ConfigDict(extra="forbid")

    def model_dump(
        self,
        *,
        mode: Literal["json", "python"] | str = "python",
        include: Any = None,
        exclude: Any = None,
        context: Any | None = None,
        by_alias: bool | None = None,
        exclude_unset: bool = False,
        exclude_defaults: bool = False,
        exclude_none: bool = False,
        exclude_computed_fields: bool = False,
        round_trip: bool = False,
        warnings: bool | Literal["none", "warn", "error"] = True,
        fallback: Any = None,
        serialize_as_any: bool = False,
    ) -> dict[str, Any]:
        """Keep explicit nulls in persisted reader-state payloads."""

        return super().model_dump(
            mode=mode,
            include=include,
            exclude=exclude,
            context=context,
            by_alias=by_alias,
            exclude_unset=exclude_unset,
            exclude_defaults=exclude_defaults,
            exclude_none=False,
            exclude_computed_fields=exclude_computed_fields,
            round_trip=round_trip,
            warnings=warnings,
            fallback=fallback,
            serialize_as_any=serialize_as_any,
        )


class ReaderTextLocations(ReaderStateModel):
    """Canonical text location fields shared by non-PDF reader states."""

    text_offset: int | None = Field(ge=0)
    progression: float | None = Field(ge=0.0, le=1.0)
    total_progression: float | None = Field(ge=0.0, le=1.0)
    position: int | None = Field(ge=1)


QUOTE_MAX_CODE_POINTS = 256
QUOTE_CONTEXT_MAX_CODE_POINTS = 128


class ReaderQuoteContext(ReaderStateModel):
    """Quote-context fields shared by non-PDF reader states."""

    quote: str | None = Field(max_length=QUOTE_MAX_CODE_POINTS)
    quote_prefix: str | None = Field(max_length=QUOTE_CONTEXT_MAX_CODE_POINTS)
    quote_suffix: str | None = Field(max_length=QUOTE_CONTEXT_MAX_CODE_POINTS)

    @model_validator(mode="after")
    def validate_quote_context(self) -> "ReaderQuoteContext":
        """Reject blank quote fields and require quote text for quote context."""

        _reject_blank_string_fields(self, ("quote", "quote_prefix", "quote_suffix"))
        if self.quote is None and (self.quote_prefix is not None or self.quote_suffix is not None):
            raise ValueError("quote_prefix and quote_suffix require quote")
        return self


class ReaderFragmentTarget(ReaderStateModel):
    """Target fragment for web and transcript resume state."""

    fragment_id: str

    @model_validator(mode="after")
    def validate_fragment_target(self) -> "ReaderFragmentTarget":
        """Reject blank fragment targets."""

        _reject_blank_string_fields(self, ("fragment_id",))
        return self


class ReaderEpubTarget(ReaderStateModel):
    """EPUB target fields for persisted resume state."""

    section_id: str
    href_path: str
    anchor_id: str | None

    @model_validator(mode="after")
    def validate_epub_target(self) -> "ReaderEpubTarget":
        """Reject blank EPUB target strings."""

        _reject_blank_string_fields(self, ("section_id", "href_path", "anchor_id"))
        return self


class PdfReaderResumeState(ReaderStateModel):
    """Persisted reader state for PDF media."""

    kind: Literal["pdf"]
    page: int = Field(ge=1)
    page_progression: float | None = Field(ge=0.0, le=1.0)
    zoom: float | None = Field(ge=0.25, le=4.0)
    position: int | None = Field(ge=1)


class WebReaderResumeState(ReaderStateModel):
    """Persisted reader state for web articles."""

    kind: Literal["web"]
    target: ReaderFragmentTarget
    locations: ReaderTextLocations
    text: ReaderQuoteContext


class TranscriptReaderResumeState(ReaderStateModel):
    """Persisted reader state for transcript readers."""

    kind: Literal["transcript"]
    target: ReaderFragmentTarget
    locations: ReaderTextLocations
    text: ReaderQuoteContext


class EpubReaderResumeState(ReaderStateModel):
    """Persisted reader state for EPUB readers."""

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
    """Snapshot for a user/media pair with no persisted cursor.

    Revision ``0`` is an API sentinel only; it is never persisted."""

    model_config = ConfigDict(extra="forbid")
    state: Literal["Empty"] = "Empty"
    revision: Literal[0] = 0


class ReaderCursorPositioned(BaseModel):
    """Snapshot of the one canonical cursor for a user/media pair."""

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
