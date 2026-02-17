"""Highlight and Annotation Pydantic schemas.

Contains request and response models for highlight and annotation endpoints.
These schemas are introduced in Slice 2 (Web Articles + Highlights).

Note: No validation logic beyond basic field typing - business validation
occurs in later PRs (PR-06+).
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Valid highlight colors - must match DB constraint
HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]


# =============================================================================
# Output Schemas
# =============================================================================


class AnnotationOut(BaseModel):
    """Response schema for an annotation.

    An annotation is an optional note attached to a highlight (0..1).
    Ownership is derived from highlights.user_id.
    """

    id: UUID
    highlight_id: UUID
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class HighlightOut(BaseModel):
    """Response schema for a highlight.

    Offsets are half-open [start_offset, end_offset) in Unicode codepoints
    over fragment.canonical_text.

    The annotation field is included when fetching highlights - it will be
    None if no annotation exists, or the annotation object if one exists.

    S4 additive fields (PR-07):
    - author_user_id: UUID of the highlight author
    - is_owner: viewer-local convenience boolean (True iff viewer authored this highlight)
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

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# Request Schemas
# =============================================================================


class CreateHighlightRequest(BaseModel):
    """Request schema for creating a highlight.

    Client sends offsets + color only. Server derives exact/prefix/suffix
    from fragment.canonical_text.
    """

    start_offset: int = Field(..., ge=0, description="Start offset (inclusive) in codepoints")
    end_offset: int = Field(..., gt=0, description="End offset (exclusive) in codepoints")
    color: HIGHLIGHT_COLORS = Field(..., description="Highlight color from palette")


class UpdateHighlightRequest(BaseModel):
    """Request schema for updating a highlight.

    All fields are optional. If offsets change, server re-derives
    exact/prefix/suffix from fragment.canonical_text.
    """

    start_offset: int | None = Field(
        None, ge=0, description="New start offset (inclusive) in codepoints"
    )
    end_offset: int | None = Field(
        None, gt=0, description="New end offset (exclusive) in codepoints"
    )
    color: HIGHLIGHT_COLORS | None = Field(None, description="New highlight color from palette")


class UpsertAnnotationRequest(BaseModel):
    """Request schema for creating or updating an annotation.

    Used with PUT for upsert semantics - creates if not exists,
    updates if exists.
    """

    body: str = Field(..., min_length=1, description="Annotation text content")
