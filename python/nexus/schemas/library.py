"""Library-related request and response schemas."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.podcast import PodcastSyncStatus
from nexus.schemas.reading_time import ReadingTimeEstimateOut
from nexus.services.sealed_handles import LibraryInvitationHandle, UserHandle

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
LibraryGovernanceCursor = Annotated[str, Field(min_length=1)]
LibraryEntryKind = Literal["media", "podcast"]


class _Out(BaseModel):
    """Output model with every serialized field declared."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_serialization_defaults_required=True,
    )


class _Row(_Out):
    """Output model built straight from a DB row or context object."""

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateLibraryRequest(BaseModel):
    library_id: UUID
    name: str = Field(..., min_length=1, max_length=100, description="Library name (1-100 chars)")

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdateLibraryRequest(BaseModel):
    name: str = Field(
        ..., min_length=1, max_length=100, description="New library name (1-100 chars)"
    )


class UpdateLibraryMemberRequest(BaseModel):
    role: LibraryRole = Field(..., description="New role for the member ('admin' or 'member')")


class TransferLibraryOwnershipRequest(_In):
    new_owner_user_handle: UserHandle


class LibraryEntryOrderRequest(BaseModel):
    entry_ids: list[UUID] = Field(min_length=1, max_length=500)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_entry_ids(self) -> "LibraryEntryOrderRequest":
        if len(set(self.entry_ids)) != len(self.entry_ids):
            raise ValueError("entry_ids must not contain duplicates")
        return self


class UserLibraryInvitee(_In):
    kind: Literal["User"]
    user_handle: UserHandle


class CreateLibraryInviteRequest(BaseModel):
    invitee: UserLibraryInvitee
    role: LibraryRole = Field(
        ..., description="Role to assign to the invitee ('admin' or 'member')"
    )

    model_config = ConfigDict(extra="forbid")


class LibraryOut(_Row):
    id: UUID
    name: str
    owner_user_handle: UserHandle
    is_default: bool
    role: LibraryRole
    system_key: str | None
    can_rename: bool
    can_delete: bool
    can_edit_entries: bool
    can_manage_members: bool
    can_transfer_ownership: bool
    created_at: datetime
    updated_at: datetime


class PodcastPlacementRemovalOut(_Out):
    outcome: Literal["Removed", "AlreadyAbsent"]


class PodcastPlacementAdditionOut(_Out):
    outcome: Literal["Added", "AlreadyPresent"]


class LibraryIdentityOut(_Out):
    id: UUID
    name: str


class SavedInNexusLibraryPlacementDestinationOut(_Out):
    kind: Literal["SavedInNexus"] = "SavedInNexus"


class LibraryLibraryPlacementDestinationOut(_Out):
    kind: Literal["Library"] = "Library"
    library: LibraryIdentityOut


LibraryPlacementDestinationOut = Annotated[
    SavedInNexusLibraryPlacementDestinationOut | LibraryLibraryPlacementDestinationOut,
    Field(discriminator="kind"),
]


class AbsentLibraryPlacementRelationOut(_Out):
    kind: Literal["Absent"] = "Absent"


class DirectLibraryPlacementRelationOut(_Out):
    kind: Literal["Direct"] = "Direct"


class InheritedLibraryPlacementRelationOut(_Out):
    kind: Literal["Inherited"] = "Inherited"
    provenance: list[LibraryIdentityOut] = Field(min_length=1)


LibraryPlacementRelationOut = Annotated[
    AbsentLibraryPlacementRelationOut
    | DirectLibraryPlacementRelationOut
    | InheritedLibraryPlacementRelationOut,
    Field(discriminator="kind"),
]


class AvailableLibraryPlacementAvailabilityOut(_Out):
    kind: Literal["Available"] = "Available"


class BlockedLibraryPlacementAvailabilityOut(_Out):
    kind: Literal["Blocked"] = "Blocked"
    reason: Literal["RequiresAdmin", "RequiresSubscription", "SystemManaged", "Inherited"]


LibraryPlacementAvailabilityOut = Annotated[
    AvailableLibraryPlacementAvailabilityOut | BlockedLibraryPlacementAvailabilityOut,
    Field(discriminator="kind"),
]


class LibraryPlacementOptionOut(_Out):
    destination: LibraryPlacementDestinationOut
    relation: LibraryPlacementRelationOut
    availability: LibraryPlacementAvailabilityOut


class LibraryPageInfo(BaseModel):
    # `has_more` is derived from `next_cursor`, but `client.ts` requires the field
    # and asserts the two agree, so it stays on the wire.
    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class LibraryGovernancePageInfo(_Out):
    next_cursor: LibraryGovernanceCursor | None


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryEntryPodcastOut(_Out):
    id: UUID
    title: str
    contributors: list[ContributorCreditOut]
    unplayed_count: int = Field(ge=0, default=0)
    published_date: datetime | None


class LibraryEntryPodcastSubscriptionOut(_Out):
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None
    auto_queue: bool = False
    sync_status: PodcastSyncStatus


class LibraryEntryMediaCapabilitiesOut(_Out):
    can_quote: bool
    can_retry: bool
    can_refresh_source: bool
    can_retry_metadata: bool
    can_edit_authors: bool
    can_delete: bool


class LibraryEntryMediaOut(_Out):
    id: UUID
    created_at: datetime
    author_mode: Literal["automatic", "manual"]
    canonical_source_url: str | None
    last_engaged_at: datetime | None
    capabilities: LibraryEntryMediaCapabilitiesOut


class LibraryEntryPlacementOut(_Out):
    library_entry_id: UUID
    position: int = Field(ge=0)


class LibraryMediaListItemOut(_Out):
    kind: Literal["media"]
    media_summary: MediaSummaryOut
    placement: LibraryEntryPlacementOut | None
    added_at: datetime
    media: LibraryEntryMediaOut


class LibraryPodcastListItemOut(_Out):
    kind: Literal["podcast"]
    placement: LibraryEntryPlacementOut | None
    added_at: datetime
    podcast: LibraryEntryPodcastOut
    subscription: LibraryEntryPodcastSubscriptionOut | None
    reading_time_estimate: ReadingTimeEstimateOut | None


LibraryEntryListItemOut = Annotated[
    LibraryMediaListItemOut | LibraryPodcastListItemOut,
    Field(discriminator="kind"),
]


class LibraryMemberOut(_Row):
    user_handle: UserHandle
    role: LibraryRole
    is_owner: bool
    email: str | None
    display_name: str | None
    created_at: datetime


class LibraryInvitationOut(_Row):
    invitation_handle: LibraryInvitationHandle
    library_id: UUID
    inviter_user_handle: UserHandle
    invitee_user_handle: UserHandle
    role: LibraryRole
    status: LibraryInvitationStatusValue
    invitee_email: str | None
    invitee_display_name: str | None
    created_at: datetime
    responded_at: datetime | None


class ViewerLibraryInvitationOut(LibraryInvitationOut):
    library_name: str


class InviteAcceptMembershipOut(_Row):
    library_id: UUID
    user_handle: UserHandle
    role: LibraryRole


class AcceptLibraryInviteResponse(_Row):
    invite: LibraryInvitationOut
    membership: InviteAcceptMembershipOut
    idempotent: bool


class DeclineLibraryInviteResponse(_Row):
    invite: LibraryInvitationOut
    idempotent: bool
