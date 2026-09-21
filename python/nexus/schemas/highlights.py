"""Highlight wire shapes."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.resource_items import validate_note_body_pm_json

HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]


class FragmentAnchorOut(BaseModel):
    type: Literal["fragment_offsets"] = "fragment_offsets"
    media_id: UUID
    fragment_id: UUID | None
    start_offset: int | None
    end_offset: int | None


class PdfQuadOut(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    x3: float
    y3: float
    x4: float
    y4: float

    model_config = ConfigDict(from_attributes=True)


class PdfAnchorOut(BaseModel):
    type: Literal["pdf_page_geometry"] = "pdf_page_geometry"
    media_id: UUID
    page_number: int
    quads: list[PdfQuadOut]


class LinkedConversationRef(BaseModel):
    conversation_id: UUID
    title: str


class LinkedNoteBlockRef(BaseModel):
    note_block_id: UUID
    body_pm_json: dict[str, object]
    body_text: str


class TypedHighlightOut(BaseModel):
    id: UUID
    anchor: FragmentAnchorOut | PdfAnchorOut
    color: str
    exact: str
    prefix: str
    suffix: str
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID
    is_owner: bool
    linked_conversations: list[LinkedConversationRef] = Field(default_factory=list)
    linked_note_blocks: list[LinkedNoteBlockRef] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class PdfQuadIn(PdfQuadOut):
    model_config = ConfigDict(extra="forbid")


class FragmentOffsets(BaseModel):
    """Half-open codepoint span over ``fragment.canonical_text``."""

    start_offset: int = Field(ge=0)
    end_offset: int = Field(gt=0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def check_range(self) -> "FragmentOffsets":
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class CreateHighlightRequest(FragmentOffsets):
    color: HIGHLIGHT_COLORS


class FragmentAnchorUpdateRequest(FragmentOffsets):
    type: Literal["fragment_offsets"] = "fragment_offsets"


class PdfBoundsUpdate(BaseModel):
    page_number: int = Field(ge=1)
    quads: list[PdfQuadIn] = Field(min_length=1, max_length=512)
    exact: str = ""

    model_config = ConfigDict(extra="forbid")


class CreatePdfHighlightRequest(PdfBoundsUpdate):
    color: HIGHLIGHT_COLORS


class PdfAnchorUpdateRequest(BaseModel):
    type: Literal["pdf_page_geometry"] = "pdf_page_geometry"
    page_number: int = Field(ge=1)
    quads: list[PdfQuadIn] = Field(min_length=1, max_length=512)

    model_config = ConfigDict(extra="forbid")


HighlightAnchorUpdate = Annotated[
    FragmentAnchorUpdateRequest | PdfAnchorUpdateRequest, Field(discriminator="type")
]


class UpdateHighlightRequest(BaseModel):
    color: HIGHLIGHT_COLORS | None = None
    exact: str | None = None
    anchor: HighlightAnchorUpdate | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def check_exact(self) -> "UpdateHighlightRequest":
        pdf_update = self.anchor is not None and self.anchor.type == "pdf_page_geometry"
        if pdf_update != (self.exact is not None):
            raise ValueError("exact belongs to pdf_page_geometry anchor updates and only those")
        return self


class SetHighlightNoteRequest(BaseModel):
    note_block_id: UUID
    client_mutation_id: str = Field(min_length=1, max_length=120)
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def check_body(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = validate_note_body_pm_json(value)
        if validated is None:
            raise ValueError("body_pm_json is required")
        return validated
