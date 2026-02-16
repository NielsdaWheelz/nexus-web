"""Library-related Pydantic schemas.

Contains request and response models for library endpoints.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# MediaOut is defined in schemas/media.py - import from there
from nexus.schemas.media import MediaOut

# --- S4 typed aliases ---

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]

__all__ = [
    "CreateLibraryRequest",
    "UpdateLibraryRequest",
    "AddMediaRequest",
    "UpdateLibraryMemberRequest",
    "TransferLibraryOwnershipRequest",
    "LibraryOut",
    "LibraryMediaOut",
    "MediaOut",
    # S4 types
    "LibraryRole",
    "LibraryInvitationStatusValue",
    "LibraryMemberOut",
    "LibraryInvitationOut",
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


class UpdateLibraryMemberRequest(BaseModel):
    """Request body for updating a library member's role."""

    role: LibraryRole = Field(..., description="New role for the member ('admin' or 'member')")


class TransferLibraryOwnershipRequest(BaseModel):
    """Request body for transferring library ownership."""

    new_owner_user_id: UUID = Field(..., description="User ID of the new owner")


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


# =============================================================================
# S4 Response Schemas
# =============================================================================


class LibraryMemberOut(BaseModel):
    """Response schema for a library member."""

    user_id: UUID
    role: LibraryRole
    is_owner: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryInvitationOut(BaseModel):
    """Response schema for a library invitation."""

    id: UUID
    library_id: UUID
    inviter_user_id: UUID
    invitee_user_id: UUID
    role: LibraryRole
    status: LibraryInvitationStatusValue
    created_at: datetime
    responded_at: datetime | None

    model_config = ConfigDict(from_attributes=True)
