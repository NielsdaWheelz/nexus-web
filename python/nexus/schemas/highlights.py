"""Highlight projection read shapes. Highlights are written only as authored commands."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.highlight_color import HighlightColor

HIGHLIGHT_COLORS = HighlightColor


class FragmentAnchorOut(BaseModel):
    type: Literal["fragment_offsets"] = "fragment_offsets"
    media_id: UUID
    fragment_id: UUID | None
    start_offset: int | None
    end_offset: int | None


class XCaptureAnchorOut(BaseModel):
    type: Literal["x_capture_offsets"] = "x_capture_offsets"
    capture_id: UUID
    fragment_id: UUID
    start_offset: int
    end_offset: int


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


class HighlightAnnotationOut(BaseModel):
    body_pm_json: dict[str, object]
    body_text: str


class TypedHighlightOut(BaseModel):
    id: UUID
    anchor: FragmentAnchorOut | XCaptureAnchorOut | PdfAnchorOut
    color: HIGHLIGHT_COLORS
    exact: str
    prefix: str
    suffix: str
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID
    is_owner: bool
    linked_conversations: list[LinkedConversationRef] = Field(default_factory=list)
    annotation: HighlightAnnotationOut | None

    model_config = ConfigDict(
        from_attributes=True, json_schema_serialization_defaults_required=True
    )
