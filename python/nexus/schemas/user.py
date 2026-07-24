"""User-related Pydantic schemas.

Contains request and response models for user endpoints.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.services.sealed_handles import UserHandle

DISPLAY_NAME_MAX_LENGTH = 100


class UserSearchOut(BaseModel):
    """Response schema for a user search result."""

    user_handle: UserHandle
    email: str | None
    display_name: str | None

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class UserProfileOut(BaseModel):
    """Response schema for user profile from GET /me."""

    user_id: UUID
    default_library_id: UUID
    email: str | None
    display_name: str | None
    email_ingest_address: str | None = None

    model_config = ConfigDict(from_attributes=True)


class UpdateProfileRequest(BaseModel):
    """Request body for PATCH /me."""

    display_name: str | None = Field(
        default=...,
        max_length=DISPLAY_NAME_MAX_LENGTH,
        description="Display name (1-100 chars, or null to clear)",
    )
