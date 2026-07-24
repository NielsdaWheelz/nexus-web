"""Library-related request and response schemas."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.media import MediaOut
from nexus.schemas.presence import Presence
from nexus.services.sealed_handles import LibraryInvitationHandle, UserHandle

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
LibraryEntryKind = Literal["media", "podcast"]
PodcastSubscriptionStatusValue = Literal["active", "unsubscribed"]
PodcastSyncStatusValue = Literal[
    "pending", "running", "partial", "complete", "source_limited", "failed"
]

_INT32_MAX = 2_147_483_647
_PositiveInt32 = Annotated[int, Field(strict=True, ge=1, le=_INT32_MAX)]


class CreateLibraryRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Library name (1-100 chars)")


class UpdateLibraryRequest(BaseModel):
    name: str = Field(
        ..., min_length=1, max_length=100, description="New library name (1-100 chars)"
    )


class AddPodcastRequest(BaseModel):
    podcast_id: UUID = Field(..., description="ID of the podcast to add")


class ItemLibraryMembershipOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None
    is_in_library: bool
    can_add: bool
    can_remove: bool


class LibraryEntryOrderRequest(BaseModel):
    entry_ids: list[UUID] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_entry_ids(self) -> "LibraryEntryOrderRequest":
        if len(set(self.entry_ids)) != len(self.entry_ids):
            raise ValueError("entry_ids must not contain duplicates")
        return self

    model_config = ConfigDict(extra="forbid")


class UpdateLibraryMemberRequest(BaseModel):
    role: LibraryRole = Field(..., description="New role for the member ('admin' or 'member')")


class TransferLibraryOwnershipRequest(BaseModel):
    new_owner_user_handle: UserHandle

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
    )


class LibraryOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None
    owner_user_handle: UserHandle
    is_default: bool
    role: LibraryRole
    system_key: str | None = None
    can_rename: bool
    can_delete: bool
    can_edit_entries: bool
    can_manage_members: bool
    can_transfer_ownership: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryPageInfo(BaseModel):
    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryPodcastOut(BaseModel):
    id: UUID
    provider: str
    provider_podcast_id: str
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    feed_url: str
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    unplayed_count: int = Field(ge=0, default=0)


class LibraryPodcastSubscriptionOut(BaseModel):
    status: PodcastSubscriptionStatusValue
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool = False
    sync_status: PodcastSyncStatusValue
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int = Field(ge=0)
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime


class ReadingTimeEstimateOut(BaseModel):
    total_minutes: _PositiveInt32
    remaining_minutes: Presence[_PositiveInt32]

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class LibraryEntryOut(BaseModel):
    id: UUID
    library_id: UUID
    kind: LibraryEntryKind
    position: int = Field(ge=0)
    created_at: datetime
    media: MediaOut | None = None
    podcast: LibraryPodcastOut | None = None
    subscription: LibraryPodcastSubscriptionOut | None = None
    reading_time_estimate: Presence[ReadingTimeEstimateOut] = Field(
        serialization_alias="readingTimeEstimate"
    )

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class LibraryMemberOut(BaseModel):
    user_handle: UserHandle
    role: LibraryRole
    is_owner: bool
    email: str | None = None
    display_name: str | None = None
    created_at: datetime

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryInvitationOut(BaseModel):
    invitation_handle: LibraryInvitationHandle
    library_id: UUID
    inviter_user_handle: UserHandle
    invitee_user_handle: UserHandle
    role: LibraryRole
    status: LibraryInvitationStatusValue
    invitee_email: str | None = None
    invitee_display_name: str | None = None
    created_at: datetime
    responded_at: datetime | None

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class ViewerLibraryInvitationOut(LibraryInvitationOut):
    library_name: str


class UserLibraryInvitee(BaseModel):
    kind: Literal["User"]
    user_handle: UserHandle

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
    )


class EmailLibraryInvitee(BaseModel):
    kind: Literal["Email"]
    email: str

    model_config = ConfigDict(extra="forbid")


LibraryInvitee = Annotated[
    UserLibraryInvitee | EmailLibraryInvitee,
    Field(discriminator="kind"),
]


class CreateLibraryInviteRequest(BaseModel):
    invitee: LibraryInvitee
    role: LibraryRole = Field(
        ..., description="Role to assign to the invitee ('admin' or 'member')"
    )

    model_config = ConfigDict(extra="forbid")


class InviteAcceptMembershipOut(BaseModel):
    library_id: UUID
    user_handle: UserHandle
    role: LibraryRole

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class AcceptLibraryInviteResponse(BaseModel):
    invite: LibraryInvitationOut
    membership: InviteAcceptMembershipOut
    idempotent: bool

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class DeclineLibraryInviteResponse(BaseModel):
    invite: LibraryInvitationOut
    idempotent: bool

    model_config = ConfigDict(
        from_attributes=True,
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )
