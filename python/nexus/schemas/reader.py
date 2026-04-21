"""Reader profile and per-media reader state schemas."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]


# =============================================================================
# Reader Profile (per-user defaults)
# =============================================================================


class ReaderProfileOut(BaseModel):
    """Response schema for reader profile."""

    theme: ThemeValue
    font_size_px: int = Field(ge=12, le=28)
    line_height: float = Field(ge=1.2, le=2.2)
    font_family: FontFamilyValue
    column_width_ch: int = Field(ge=40, le=120)
    focus_mode: bool
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReaderProfilePatch(BaseModel):
    """PATCH body for reader profile (partial update)."""

    theme: ThemeValue | None = None
    font_size_px: int | None = Field(default=None, ge=12, le=28)
    line_height: float | None = Field(default=None, ge=1.2, le=2.2)
    font_family: FontFamilyValue | None = None
    column_width_ch: int | None = Field(default=None, ge=40, le=120)
    focus_mode: bool | None = None

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
        ):
            if field_name in self.model_fields_set and getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


# =============================================================================
# Reader Media State (per user + media)
# =============================================================================


class FragmentOffsetLocator(BaseModel):
    """Canonical fragment-offset resume locator."""

    type: Literal["fragment_offset"] = "fragment_offset"
    fragment_id: UUID | None = None
    offset: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def reject_null_fragment_id(self) -> "FragmentOffsetLocator":
        """Explicit null should be omitted instead of serialized."""
        if "fragment_id" in self.model_fields_set and self.fragment_id is None:
            raise ValueError("fragment_id cannot be null")
        return self


class EpubSectionLocator(BaseModel):
    """EPUB navigation resume locator."""

    type: Literal["epub_section"] = "epub_section"
    section_id: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class PdfPageLocator(BaseModel):
    """PDF page resume locator."""

    type: Literal["pdf_page"] = "pdf_page"
    page: int = Field(ge=1)
    zoom: float | None = Field(default=None, ge=0.25, le=4.0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def reject_null_zoom(self) -> "PdfPageLocator":
        """Explicit null should be omitted instead of serialized."""
        if "zoom" in self.model_fields_set and self.zoom is None:
            raise ValueError("zoom cannot be null")
        return self


ReaderLocator = Annotated[
    FragmentOffsetLocator | EpubSectionLocator | PdfPageLocator,
    Field(discriminator="type"),
]


class ReaderMediaStateOut(BaseModel):
    """Response schema for per-media reader state."""

    id: UUID | None = None
    media_id: UUID
    locator: ReaderLocator | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)

    @field_serializer("locator", when_used="json")
    def serialize_locator(self, locator: ReaderLocator | None) -> dict | None:
        """Emit compact typed locator payloads without null-only keys."""
        if locator is None:
            return None
        return locator.model_dump(mode="json", exclude_none=True)


class ReaderMediaStatePut(BaseModel):
    """PUT body for per-media reader state."""

    locator: ReaderLocator | None

    model_config = ConfigDict(extra="forbid")
