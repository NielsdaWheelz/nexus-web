"""Highlight wire shapes."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    body_version: int


class TypedHighlightOut(BaseModel):
    id: UUID
    anchor: FragmentAnchorOut | PdfAnchorOut
    color: HIGHLIGHT_COLORS
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


class FragmentAnchorUpdateRequest(FragmentOffsets):
    type: Literal["fragment_offsets"] = "fragment_offsets"


class PdfBoundsUpdate(BaseModel):
    page_number: int = Field(ge=1)
    quads: list[PdfQuadIn] = Field(min_length=1, max_length=512)
    exact: str = ""

    model_config = ConfigDict(extra="forbid")


class TextHighlightAnchorIn(FragmentOffsets):
    """A span of one reader unit (fragment) of the media."""

    kind: Literal["text"]
    unit_id: UUID


class PdfHighlightAnchorIn(PdfBoundsUpdate):
    kind: Literal["pdf"]


class CreateMediaHighlightRequest(BaseModel):
    """One highlight model on the wire: a text span or page quads, and a colour."""

    anchor: Annotated[TextHighlightAnchorIn | PdfHighlightAnchorIn, Field(discriminator="kind")]
    color: HIGHLIGHT_COLORS

    model_config = ConfigDict(extra="forbid")


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
