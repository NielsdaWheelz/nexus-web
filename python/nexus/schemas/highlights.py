"""Highlight projection read shapes. Highlights are written only as authored commands."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.resource_items import ResourceItemOut

HIGHLIGHT_COLORS = HighlightColor


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
    """One independently attached note, by its exact link, in the highlight's order."""

    link_id: UUID
    note_block_id: UUID
    body_pm_json: dict[str, object]
    body_text: str
    embedded_item: ResourceItemOut | None = None


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

    model_config = ConfigDict(
        from_attributes=True, json_schema_serialization_defaults_required=True
    )
