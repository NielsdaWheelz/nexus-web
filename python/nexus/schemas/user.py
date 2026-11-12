"""User-related Pydantic schemas.

Contains request and response models for user endpoints.
"""

from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.collection_order import OrderRevision

DISPLAY_NAME_MAX_LENGTH = 100
READING_BRIEF_MAX_LENGTH = 8000


class UserSearchOut(BaseModel):
    """One person found by people search; `email` only when the query was it exactly."""

    user_id: UUID
    email: str | None
    display_name: str | None


class UserProfileOut(BaseModel):
    """Authenticated account profile returned by GET and PATCH /me."""

    user_id: UUID
    default_library_id: UUID
    email: str | None
    display_name: str | None
    calendar_time_zone: str
    chat_deletion_revision: OrderRevision
    reading_brief: str | None
    reading_brief_version: OrderRevision
    email_ingest_address: str | None = None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


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

    reading_brief: str | None = Field(default=None, max_length=READING_BRIEF_MAX_LENGTH)
    expected_reading_brief_version: OrderRevision | None = None

    @field_validator("reading_brief")
    @classmethod
    def blank_brief_is_absent(cls, value: str | None) -> str | None:
        return value if value is not None and value.strip() else None

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
        brief = "reading_brief" in self.model_fields_set
        version = "expected_reading_brief_version" in self.model_fields_set
        if brief != version or (brief and self.expected_reading_brief_version is None):
            raise ValueError("reading_brief and its expected version are required together")
        return self
