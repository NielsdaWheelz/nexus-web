"""Reader profile and per-media reader locator schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ThemeValue = Literal["light", "dark"]
FontFamilyValue = Literal["serif", "sans"]


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


class ReaderLocator(BaseModel):
    """Flat layered locator stored in reader_media_state.locator."""

    source: str | None = None
    anchor: str | None = None
    text_offset: int | None = Field(default=None, ge=0)
    quote: str | None = None
    quote_prefix: str | None = None
    quote_suffix: str | None = None
    progression: float | None = Field(default=None, ge=0.0, le=1.0)
    total_progression: float | None = Field(default=None, ge=0.0, le=1.0)
    position: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
    page_progression: float | None = Field(default=None, ge=0.0, le=1.0)
    zoom: float | None = Field(default=None, ge=0.25, le=4.0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator(self) -> "ReaderLocator":
        """Reject blank or internally inconsistent locator payloads."""
        if not any(
            getattr(self, field_name) is not None
            for field_name in (
                "source",
                "anchor",
                "text_offset",
                "quote",
                "quote_prefix",
                "quote_suffix",
                "progression",
                "total_progression",
                "position",
                "page",
                "page_progression",
                "zoom",
            )
        ):
            raise ValueError("locator cannot be empty; send null to clear reader state")

        for field_name in ("source", "anchor", "quote", "quote_prefix", "quote_suffix"):
            value = getattr(self, field_name)
            if field_name in self.model_fields_set and value is not None and not value.strip():
                raise ValueError(f"{field_name} cannot be blank")

        if self.quote is None and (self.quote_prefix is not None or self.quote_suffix is not None):
            raise ValueError("quote_prefix and quote_suffix require quote")

        if self.page is None and (self.page_progression is not None or self.zoom is not None):
            raise ValueError("page is required when page_progression or zoom is provided")

        text_locator_fields_present = any(
            value is not None
            for value in (
                self.anchor,
                self.text_offset,
                self.quote,
                self.quote_prefix,
                self.quote_suffix,
                self.progression,
                self.total_progression,
            )
        ) or (self.position is not None and self.page is None)
        if text_locator_fields_present and self.source is None:
            raise ValueError("source is required for text locators")

        return self
