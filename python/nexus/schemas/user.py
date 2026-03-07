"""User-related Pydantic schemas.

Contains request and response models for user endpoints.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class UserSearchOut(BaseModel):
    """Response schema for a user search result."""

    user_id: UUID
    email: str | None
    display_name: str | None

    model_config = ConfigDict(from_attributes=True)


class UserProfileOut(BaseModel):
    """Response schema for user profile from GET /me."""

    user_id: UUID
    default_library_id: UUID
    email: str | None
    display_name: str | None

    model_config = ConfigDict(from_attributes=True)


class UpdateProfileRequest(BaseModel):
    """Request body for PATCH /me."""

    display_name: str | None = Field(
        default=...,
        max_length=100,
        description="Display name (1-100 chars, or null to clear)",
    )
