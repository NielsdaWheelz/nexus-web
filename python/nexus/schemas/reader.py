"""Reader profile and per-media reader resume schemas."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]
LocatorKindValue = Literal["fragment_offset", "epub_section", "pdf_page"]


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
# Reader Media Resume State (per user + media)
# =============================================================================


class ReaderResumeStateOut(BaseModel):
    """Response schema for per-media reader resume state."""

    locator_kind: LocatorKindValue | None = None
    fragment_id: UUID | None = None
    offset: int | None = None
    section_id: str | None = None
    page: int | None = None
    zoom: float | None = None
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReaderResumeStatePatch(BaseModel):
    """PATCH body for per-media reader resume state."""

    locator_kind: LocatorKindValue | None = None
    fragment_id: UUID | None = None
    offset: int | None = Field(default=None, ge=0)
    section_id: str | None = None
    page: int | None = Field(default=None, ge=1)
    zoom: float | None = Field(default=None, ge=0.25, le=4.0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_payload(self) -> "ReaderResumeStatePatch":
        """Ensure locator payloads are internally consistent."""
        locator_fields = {"fragment_id", "offset", "section_id", "page", "zoom"}
        kind_set = "locator_kind" in self.model_fields_set
        has_locator_fields = any(field in self.model_fields_set for field in locator_fields)
        kind = self.locator_kind

        if not kind_set and not has_locator_fields:
            return self
        if not kind_set and has_locator_fields:
            raise ValueError("locator_kind is required when providing locator fields")
        if kind_set and kind is None:
            if has_locator_fields and any(
                getattr(self, field_name) is not None for field_name in locator_fields
            ):
                raise ValueError("locator fields must be null when locator_kind is null")
            return self

        if kind == "fragment_offset":
            if self.offset is None:
                raise ValueError("offset is required for locator_kind='fragment_offset'")
            if self.section_id is not None or self.page is not None or self.zoom is not None:
                raise ValueError(
                    "section_id/page/zoom must be null for locator_kind='fragment_offset'"
                )
        elif kind == "epub_section":
            if not self.section_id:
                raise ValueError("section_id is required for locator_kind='epub_section'")
            if self.fragment_id is not None or self.offset is not None or self.page is not None:
                raise ValueError(
                    "fragment_id/offset/page must be null for locator_kind='epub_section'"
                )
        elif kind == "pdf_page":
            if self.page is None:
                raise ValueError("page is required for locator_kind='pdf_page'")
            if (
                self.fragment_id is not None
                or self.offset is not None
                or self.section_id is not None
            ):
                raise ValueError(
                    "fragment_id/offset/section_id must be null for locator_kind='pdf_page'"
                )

        return self
