"""Library-related request and response schemas."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.media import MediaOut

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
BackfillJobStatusValue = Literal["pending", "running", "completed", "failed"]
LibraryEntryKind = Literal["media", "podcast"]
PodcastSubscriptionStatusValue = Literal["active", "unsubscribed"]
PodcastSyncStatusValue = Literal[
    "pending", "running", "partial", "complete", "source_limited", "failed"
]

__all__ = [
    "AddMediaRequest",
    "AddPodcastRequest",
    "AcceptLibraryInviteResponse",
    "BackfillJobStatusValue",
    "CreateLibraryInviteRequest",
    "CreateLibraryRequest",
    "DeclineLibraryInviteResponse",
    "DefaultLibraryBackfillJobOut",
    "InviteAcceptMembershipOut",
    "LibraryEntryKind",
    "LibraryEntryOrderRequest",
    "LibraryEntryOut",
    "LibraryInvitationOut",
    "LibraryInvitationStatusValue",
    "LibraryMemberOut",
    "LibraryOut",
    "LibraryPodcastOut",
    "LibraryPodcastSubscriptionOut",
    "LibraryRole",
    "RequeueDefaultLibraryBackfillJobRequest",
    "TransferLibraryOwnershipRequest",
    "UpdateLibraryMemberRequest",
    "UpdateLibraryRequest",
]


class CreateLibraryRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Library name (1-100 chars)")


class UpdateLibraryRequest(BaseModel):
    name: str = Field(
        ..., min_length=1, max_length=100, description="New library name (1-100 chars)"
    )


class AddMediaRequest(BaseModel):
    media_id: UUID = Field(..., description="ID of the media to add")


class AddPodcastRequest(BaseModel):
    podcast_id: UUID = Field(..., description="ID of the podcast to add")


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
    new_owner_user_id: UUID = Field(..., description="User ID of the new owner")


class LibraryOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None
    owner_user_id: UUID
    is_default: bool
    role: LibraryRole
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryPodcastOut(BaseModel):
    id: UUID
    provider: str
    provider_podcast_id: str
    title: str
    author: str | None = None
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


class LibraryEntryOut(BaseModel):
    id: UUID
    library_id: UUID
    kind: LibraryEntryKind
    position: int = Field(ge=0)
    created_at: datetime
    media: MediaOut | None = None
    podcast: LibraryPodcastOut | None = None
    subscription: LibraryPodcastSubscriptionOut | None = None

    model_config = ConfigDict(from_attributes=True)


class LibraryMemberOut(BaseModel):
    user_id: UUID
    role: LibraryRole
    is_owner: bool
    email: str | None = None
    display_name: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryInvitationOut(BaseModel):
    id: UUID
    library_id: UUID
    inviter_user_id: UUID
    invitee_user_id: UUID
    role: LibraryRole
    status: LibraryInvitationStatusValue
    invitee_email: str | None = None
    invitee_display_name: str | None = None
    created_at: datetime
    responded_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class CreateLibraryInviteRequest(BaseModel):
    invitee_user_id: UUID | None = Field(default=None, description="User ID of the invitee")
    invitee_email: str | None = Field(default=None, description="Email of the invitee")
    role: LibraryRole = Field(
        ..., description="Role to assign to the invitee ('admin' or 'member')"
    )

    @model_validator(mode="after")
    def require_identifier(self) -> "CreateLibraryInviteRequest":
        if self.invitee_user_id is None and self.invitee_email is None:
            raise ValueError("Either invitee_user_id or invitee_email is required")
        return self


class InviteAcceptMembershipOut(BaseModel):
    library_id: UUID
    user_id: UUID
    role: LibraryRole

    model_config = ConfigDict(from_attributes=True)


class AcceptLibraryInviteResponse(BaseModel):
    invite: LibraryInvitationOut
    membership: InviteAcceptMembershipOut
    idempotent: bool
    backfill_job_status: str

    model_config = ConfigDict(from_attributes=True)


class DeclineLibraryInviteResponse(BaseModel):
    invite: LibraryInvitationOut
    idempotent: bool

    model_config = ConfigDict(from_attributes=True)


class RequeueDefaultLibraryBackfillJobRequest(BaseModel):
    default_library_id: UUID = Field(..., description="Default library ID")
    source_library_id: UUID = Field(..., description="Source (non-default) library ID")
    user_id: UUID = Field(..., description="User ID who owns the default library")


class DefaultLibraryBackfillJobOut(BaseModel):
    default_library_id: UUID
    source_library_id: UUID
    user_id: UUID
    status: BackfillJobStatusValue
    attempts: int
    last_error_code: str | None
    updated_at: datetime
    finished_at: datetime | None
    idempotent: bool
    enqueue_dispatched: bool

    model_config = ConfigDict(from_attributes=True)
