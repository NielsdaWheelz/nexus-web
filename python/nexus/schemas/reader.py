"""Reader profile and per-media reader state schemas."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]
FocusModeValue = Literal["off", "distraction_free", "paragraph", "sentence"]
HyphenationValue = Literal["auto", "off"]


class ReaderProfileOut(BaseModel):
    """Response schema for reader profile."""

    theme: ThemeValue
    font_size_px: int = Field(ge=12, le=28)
    line_height: float = Field(ge=1.2, le=2.2)
    font_family: FontFamilyValue
    column_width_ch: int = Field(ge=40, le=120)
    focus_mode: FocusModeValue
    hyphenation: HyphenationValue
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReaderProfilePatch(BaseModel):
    """PATCH body for reader profile (partial update)."""

    theme: ThemeValue | None = None
    font_size_px: int | None = Field(default=None, ge=12, le=28)
    line_height: float | None = Field(default=None, ge=1.2, le=2.2)
    font_family: FontFamilyValue | None = None
    column_width_ch: int | None = Field(default=None, ge=40, le=120)
    focus_mode: FocusModeValue | None = None
    hyphenation: HyphenationValue | None = None

    model_config = ConfigDict(extra="forbid")

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


class ReaderQuoteContext(ReaderStateModel):
    """Quote-context fields shared by non-PDF reader states."""

    quote: str | None
    quote_prefix: str | None
    quote_suffix: str | None

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
