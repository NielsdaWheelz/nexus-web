"""Highlight schemas."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.resource_items import validate_note_body_pm_json

HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]


def _validate_fragment_offset_range(start_offset: int, end_offset: int) -> None:
    if end_offset <= start_offset:
        raise ValueError("end_offset must be greater than start_offset")


# =============================================================================
# Output Schemas
# =============================================================================


# --- Anchor discriminated union ---


class FragmentAnchorOut(BaseModel):
    """Fragment-offset anchor response.

    ``fragment_id``/``start_offset``/``end_offset`` are the disposable locator
    cache, not highlight identity. They are None when the cached fragment row
    vanished (reindex/refresh) and the quote no longer resolves uniquely: the
    highlight stays visible but carries no locator, so it is never painted at a
    wrong location.
    """

    type: Literal["fragment_offsets"] = "fragment_offsets"
    media_id: UUID
    fragment_id: UUID | None
    start_offset: int | None
    end_offset: int | None


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


class LinkedNoteBlockRef(BaseModel):
    """Note block linked to a highlight."""

    note_block_id: UUID
    body_pm_json: dict[str, object]
    body_text: str


class TypedHighlightOut(BaseModel):
    """Canonical highlight item response."""

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


# =============================================================================
# Request Schemas
# =============================================================================


class CreateHighlightRequest(BaseModel):
    """Request schema for creating a fragment highlight."""

    start_offset: int = Field(..., ge=0, description="Start offset (inclusive) in codepoints")
    end_offset: int = Field(..., gt=0, description="End offset (exclusive) in codepoints")
    color: HIGHLIGHT_COLORS = Field(..., description="Highlight color from palette")

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offset_range(self) -> "CreateHighlightRequest":
        _validate_fragment_offset_range(self.start_offset, self.end_offset)
        return self


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

    model_config = ConfigDict(extra="forbid")


class CreatePdfHighlightRequest(BaseModel):
    """Request schema for creating a PDF geometry highlight."""

    page_number: int = Field(..., ge=1, description="1-based page number")
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = Field("", description="Text layer extracted text (may be empty)")
    color: HIGHLIGHT_COLORS = Field(..., description="Highlight color from palette")

    model_config = ConfigDict(extra="forbid")


class FragmentAnchorUpdateRequest(BaseModel):
    """Typed fragment anchor update payload."""

    type: Literal["fragment_offsets"] = "fragment_offsets"
    start_offset: int = Field(..., ge=0, description="New start offset (inclusive) in codepoints")
    end_offset: int = Field(..., gt=0, description="New end offset (exclusive) in codepoints")

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offset_range(self) -> "FragmentAnchorUpdateRequest":
        _validate_fragment_offset_range(self.start_offset, self.end_offset)
        return self


class PdfAnchorUpdateRequest(BaseModel):
    """Typed PDF anchor update payload."""

    page_number: int = Field(..., ge=1, description="1-based page number")
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    type: Literal["pdf_page_geometry"] = "pdf_page_geometry"

    model_config = ConfigDict(extra="forbid")


class PdfBoundsUpdate(BaseModel):
    """Internal PDF anchor replacement payload."""

    page_number: int = Field(..., ge=1, description="1-based page number")
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = Field("", description="Replacement exact text (may be empty)")

    model_config = ConfigDict(extra="forbid")


HighlightAnchorUpdate = Annotated[
    FragmentAnchorUpdateRequest | PdfAnchorUpdateRequest,
    Field(discriminator="type"),
]


class UpdateHighlightRequest(BaseModel):
    """Canonical highlight PATCH payload."""

    color: HIGHLIGHT_COLORS | None = Field(None, description="New highlight color from palette")
    exact: str | None = Field(
        None,
        description="Replacement exact text for PDF geometry updates. May be empty.",
    )
    anchor: HighlightAnchorUpdate | None = Field(
        None,
        description="Typed anchor replacement for fragment or PDF highlights",
    )

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_anchor_payload(self) -> "UpdateHighlightRequest":
        if self.anchor is None:
            if self.exact is not None:
                raise ValueError("exact requires an anchor update")
            return self

        if self.anchor.type == "fragment_offsets" and self.exact is not None:
            raise ValueError("exact is only valid for pdf_page_geometry anchor updates")

        if self.anchor.type == "pdf_page_geometry" and self.exact is None:
            raise ValueError("exact is required for pdf_page_geometry anchor updates")

        return self


class SetHighlightNoteRequest(BaseModel):
    """Product-level highlight note save payload."""

    note_block_id: UUID = Field(
        ...,
        validation_alias=AliasChoices("note_block_id", "noteBlockId", "id"),
        serialization_alias="noteBlockId",
    )
    client_mutation_id: str = Field(
        ...,
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    body_pm_json: dict[str, Any] = Field(
        ...,
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = validate_note_body_pm_json(value)
        if validated is None:
            raise ValueError("body_pm_json is required")
        return validated
