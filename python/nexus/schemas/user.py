"""User-related Pydantic schemas.

Contains request and response models for user endpoints.
"""

from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Presence
from nexus.services.sealed_handles import UserHandle

DISPLAY_NAME_MAX_LENGTH = 100


class UserSearchOut(BaseModel):
    """Response schema for a user search result."""

    user_handle: UserHandle
    email: Presence[str]
    display_name: Presence[str]

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
    calendar_time_zone: str
    email_ingest_address: str | None = None

    model_config = ConfigDict(from_attributes=True)


class UpdateProfileRequest(BaseModel):
    """Request body for PATCH /me."""

    display_name: str | None = Field(
        default=None,
        max_length=DISPLAY_NAME_MAX_LENGTH,
        description="Display name (1-100 chars, or null to clear)",
    )
    calendar_time_zone: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        description="IANA timezone used to resolve account-local calendar dates",
    )

    @field_validator("calendar_time_zone", mode="before")
    @classmethod
    def validate_calendar_time_zone(cls, value: object) -> object:
        if value is None:
            raise ValueError("calendar_time_zone cannot be null")
        if not isinstance(value, str):
            return value
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("calendar_time_zone must be an IANA timezone") from exc
        return value

    @model_validator(mode="after")
    def require_profile_field(self) -> "UpdateProfileRequest":
        if not self.model_fields_set:
            raise ValueError("At least one profile field is required")
        return self
