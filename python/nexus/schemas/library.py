"""Library-related Pydantic schemas.

Contains request and response models for library endpoints.
All schemas must match s0_spec.md exactly.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# MediaOut is defined in schemas/media.py - import from there
from nexus.schemas.media import MediaOut

__all__ = [
    "CreateLibraryRequest",
    "UpdateLibraryRequest",
    "AddMediaRequest",
    "LibraryOut",
    "LibraryMediaOut",
    "MediaOut",
]

# =============================================================================
# Request Schemas
# =============================================================================


class CreateLibraryRequest(BaseModel):
    """Request body for creating a new library."""

    name: str = Field(..., min_length=1, max_length=100, description="Library name (1-100 chars)")


class UpdateLibraryRequest(BaseModel):
    """Request body for updating a library."""

    name: str = Field(
        ..., min_length=1, max_length=100, description="New library name (1-100 chars)"
    )


class AddMediaRequest(BaseModel):
    """Request body for adding media to a library."""

    media_id: UUID = Field(..., description="ID of the media to add")


# =============================================================================
# Response Schemas
# =============================================================================


class LibraryOut(BaseModel):
    """Response schema for a library.

    Note: The `role` field is the viewer's membership role, not a property
    of the library itself. Must be computed via JOIN with memberships table.
    """

    id: UUID
    name: str
    owner_user_id: UUID
    is_default: bool
    role: str  # "admin" or "member" — viewer's role in this library
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryMediaOut(BaseModel):
    """Response schema for a library-media association."""

    library_id: UUID
    media_id: UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
