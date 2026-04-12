"""Highlight and Annotation Pydantic schemas.

Contains request and response models for highlight and annotation endpoints.

S6 PR-04 additions:
- Typed anchor discriminated union (fragment_offsets / pdf_page_geometry)
- PDF highlight create/list/update request/response schemas
- Generic PATCH extended with backward-compatible pdf_bounds field
- Strict mutual exclusivity between fragment offset updates and pdf_bounds
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]


# =============================================================================
# Output Schemas
# =============================================================================


class AnnotationOut(BaseModel):
    """Response schema for an annotation."""

    id: UUID
    highlight_id: UUID
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --- Anchor discriminated union ---


class FragmentAnchorOut(BaseModel):
    """Fragment-offset anchor response."""

    type: Literal["fragment_offsets"] = "fragment_offsets"
    media_id: UUID
    fragment_id: UUID
    start_offset: int
    end_offset: int


class PdfQuadOut(BaseModel):
    """Single canonical quad/rect segment in page-space points."""

    x1: float
    y1: float
    x2: float
    y2: float
    x3: float
    y3: float
    x4: float
    y4: float


class PdfAnchorOut(BaseModel):
    """PDF page-geometry anchor response."""

    type: Literal["pdf_page_geometry"] = "pdf_page_geometry"
    media_id: UUID
    page_number: int
    quads: list[PdfQuadOut]


# --- Highlight output schemas ---


class LinkedConversationRef(BaseModel):
    """Conversation that references a highlight via message context."""

    conversation_id: UUID
    title: str


class HighlightOut(BaseModel):
    """Response schema for a fragment highlight (legacy fragment-route compat).

    S4 additive fields:
    - author_user_id: UUID of the highlight author
    - is_owner: viewer-local convenience boolean
    """

    id: UUID
    fragment_id: UUID
    start_offset: int
    end_offset: int
    color: str
    exact: str
    prefix: str
    suffix: str
    created_at: datetime
    updated_at: datetime
    annotation: AnnotationOut | None = None
    author_user_id: UUID
    is_owner: bool
    linked_conversations: list[LinkedConversationRef] = []

    model_config = ConfigDict(from_attributes=True)


class MediaHighlightOut(HighlightOut):
    """Response schema for media-wide highlight listing (book index mode)."""

    media_id: UUID
    fragment_idx: int


class MediaHighlightPageInfoOut(BaseModel):
    """Cursor pagination metadata for media-wide highlight listing."""

    has_more: bool
    next_cursor: str | None = None


class MediaHighlightListOut(BaseModel):
    """Envelope for media-wide highlight listing endpoint."""

    highlights: list[MediaHighlightOut]
    page: MediaHighlightPageInfoOut


class TypedHighlightOut(BaseModel):
    """Anchor-discriminated typed highlight response for generic/PDF routes."""

    id: UUID
    anchor: FragmentAnchorOut | PdfAnchorOut
    color: str
    exact: str
    prefix: str
    suffix: str
    created_at: datetime
    updated_at: datetime
    annotation: AnnotationOut | None = None
    author_user_id: UUID
    is_owner: bool

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# Request Schemas
# =============================================================================


class CreateHighlightRequest(BaseModel):
    """Request schema for creating a fragment highlight."""

    start_offset: int = Field(..., ge=0, description="Start offset (inclusive) in codepoints")
    end_offset: int = Field(..., gt=0, description="End offset (exclusive) in codepoints")
    color: HIGHLIGHT_COLORS = Field(..., description="Highlight color from palette")


class PdfQuadIn(BaseModel):
    """Input quad vertices in canonical page-space points."""

    x1: float
    y1: float
    x2: float
    y2: float
    x3: float
    y3: float
    x4: float
    y4: float


class CreatePdfHighlightRequest(BaseModel):
    """Request schema for creating a PDF geometry highlight."""

    page_number: int = Field(..., ge=1, description="1-based page number")
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = Field("", description="Text layer extracted text (may be empty)")
    color: HIGHLIGHT_COLORS = Field(..., description="Highlight color from palette")


class PdfBoundsUpdate(BaseModel):
    """Nested PDF bounds replacement payload for generic PATCH."""

    page_number: int = Field(..., ge=1, description="1-based page number")
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = Field("", description="Replacement exact text (may be empty)")


class UpdateHighlightRequest(BaseModel):
    """Request schema for updating a highlight (backward-compatible unified PATCH).

    Fragment fields (start_offset, end_offset) and pdf_bounds are mutually exclusive.
    """

    start_offset: int | None = Field(
        None, ge=0, description="New start offset (inclusive) in codepoints"
    )
    end_offset: int | None = Field(
        None, gt=0, description="New end offset (exclusive) in codepoints"
    )
    color: HIGHLIGHT_COLORS | None = Field(None, description="New highlight color from palette")
    pdf_bounds: PdfBoundsUpdate | None = Field(
        None, description="PDF bounds replacement (mutually exclusive with fragment offsets)"
    )

    @model_validator(mode="after")
    def validate_mutual_exclusivity(self) -> "UpdateHighlightRequest":
        has_fragment_offsets = self.start_offset is not None or self.end_offset is not None
        has_pdf_bounds = self.pdf_bounds is not None
        if has_fragment_offsets and has_pdf_bounds:
            raise ValueError("Fragment offset fields and pdf_bounds are mutually exclusive")
        return self


class UpsertAnnotationRequest(BaseModel):
    """Request schema for creating or updating an annotation."""

    body: str = Field(..., min_length=1, description="Annotation text content")
