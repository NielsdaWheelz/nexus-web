"""Library-related request and response schemas."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.services.podcasts.types import PodcastSyncStatus
from nexus.services.sealed_handles import LibraryInvitationHandle, UserHandle

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
LibraryGovernanceCursor = Annotated[str, Field(min_length=1)]
LibraryEntryKind = Literal["media", "podcast"]

_INT32_MAX = 2_147_483_647
_PositiveInt32 = Annotated[int, Field(strict=True, ge=1, le=_INT32_MAX)]


class _Camel(BaseModel):
    """camelCase wire model: every response key the web decodes exactly."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class _CamelRow(_Camel):
    """camelCase wire model built straight from a DB row or context object."""

    model_config = ConfigDict(
        from_attributes=True, alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class _CamelIn(BaseModel):
    """camelCase request model: aliases only, never the python field name."""

    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_alias=True, validate_by_name=False, extra="forbid"
    )


class _Snake(BaseModel):
    """snake_case wire model nested inside a camelCase envelope."""

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


class TransferLibraryOwnershipRequest(_CamelIn):
    new_owner_user_handle: UserHandle


class LibraryEntryOrderRequest(BaseModel):
    entry_ids: list[UUID] = Field(min_length=1, max_length=500)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_entry_ids(self) -> "LibraryEntryOrderRequest":
        if len(set(self.entry_ids)) != len(self.entry_ids):
            raise ValueError("entry_ids must not contain duplicates")
        return self


class UserLibraryInvitee(_CamelIn):
    kind: Literal["User"]
    user_handle: UserHandle


class CreateLibraryInviteRequest(BaseModel):
    invitee: UserLibraryInvitee
    role: LibraryRole = Field(
        ..., description="Role to assign to the invitee ('admin' or 'member')"
    )

    model_config = ConfigDict(extra="forbid")


class LibraryOut(_CamelRow):
    id: UUID
    name: str
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


class LibraryRenameOut(_Camel):
    library: LibraryOut
    collection_revision: CollectionRevision


class LibraryDeleteOut(_Camel):
    library_id: UUID
    collection_revision: CollectionRevision


class LibraryEntryRemovalOut(_Camel):
    library_entries_collection_revision: CollectionRevision


class PodcastPlacementRemovalOut(_Camel):
    outcome: Literal["Removed", "AlreadyAbsent"]
    library_entries_collection_revision: CollectionRevision


class PodcastPlacementAdditionOut(_Camel):
    outcome: Literal["Added", "AlreadyPresent"]
    library_entries_collection_revision: CollectionRevision


class LibraryIdentityOut(_Camel):
    id: UUID
    name: str


class SavedInNexusLibraryPlacementDestinationOut(_Camel):
    kind: Literal["SavedInNexus"] = "SavedInNexus"


class LibraryLibraryPlacementDestinationOut(_Camel):
    kind: Literal["Library"] = "Library"
    library: LibraryIdentityOut


LibraryPlacementDestinationOut = Annotated[
    SavedInNexusLibraryPlacementDestinationOut | LibraryLibraryPlacementDestinationOut,
    Field(discriminator="kind"),
]


class AbsentLibraryPlacementRelationOut(_Camel):
    kind: Literal["Absent"] = "Absent"


class DirectLibraryPlacementRelationOut(_Camel):
    kind: Literal["Direct"] = "Direct"


class InheritedLibraryPlacementRelationOut(_Camel):
    kind: Literal["Inherited"] = "Inherited"
    provenance: list[LibraryIdentityOut] = Field(min_length=1)


LibraryPlacementRelationOut = Annotated[
    AbsentLibraryPlacementRelationOut
    | DirectLibraryPlacementRelationOut
    | InheritedLibraryPlacementRelationOut,
    Field(discriminator="kind"),
]


class AvailableLibraryPlacementAvailabilityOut(_Camel):
    kind: Literal["Available"] = "Available"


class BlockedLibraryPlacementAvailabilityOut(_Camel):
    kind: Literal["Blocked"] = "Blocked"
    reason: Literal["RequiresAdmin", "RequiresSubscription", "SystemManaged", "Inherited"]


LibraryPlacementAvailabilityOut = Annotated[
    AvailableLibraryPlacementAvailabilityOut | BlockedLibraryPlacementAvailabilityOut,
    Field(discriminator="kind"),
]


class LibraryPlacementOptionOut(_Camel):
    destination: LibraryPlacementDestinationOut
    relation: LibraryPlacementRelationOut
    availability: LibraryPlacementAvailabilityOut


class LibraryPageInfo(BaseModel):
    # `has_more` is derived from `next_cursor`, but `client.ts` requires the field
    # and asserts the two agree, so it stays on the wire.
    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class LibraryGovernancePageInfo(_Camel):
    next_cursor: Presence[LibraryGovernanceCursor]


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryEntryPodcastOut(_Camel):
    id: UUID
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    unplayed_count: int = Field(ge=0, default=0)
    published_date: Presence[datetime]


class LibraryEntryPodcastSubscriptionOut(_Camel):
    default_playback_speed: Presence[PlaybackRate]
    pause_shortening_mode: Presence[PauseShorteningMode]
    auto_queue: bool = False
    sync_status: PodcastSyncStatus


class LibraryEntryMediaCapabilitiesOut(_Snake):
    can_quote: bool
    can_retry: bool
    can_refresh_source: bool
    can_retry_metadata: bool
    can_edit_authors: bool
    can_delete: bool


class LibraryEntryMediaOut(_Snake):
    id: UUID
    kind: Literal["web_article", "epub", "pdf", "podcast_episode", "video"]
    title: str
    created_at: datetime
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    author_mode: Literal["automatic", "manual"]
    original_published_date: Presence[PublicationDate]
    canonical_source_url: str | None
    processing_status: Literal["pending", "extracting", "ready_for_reading", "failed", "suspended"]
    read_state: Literal["unread", "in_progress", "finished"]
    progress_fraction: float | None = Field(default=None, ge=0, le=1)
    progress_resettable: bool
    last_engaged_at: datetime | None = None
    capabilities: LibraryEntryMediaCapabilitiesOut


class ReadingTimeEstimateOut(_Camel):
    total_minutes: _PositiveInt32
    remaining_minutes: Presence[_PositiveInt32]


class LibraryEntryPlacementOut(_Camel):
    library_entry_id: UUID
    position: int = Field(ge=0)


class LibraryMediaListItemOut(_Camel):
    kind: Literal["media"]
    placement: Presence[LibraryEntryPlacementOut]
    added_at: datetime
    media: LibraryEntryMediaOut
    reading_time_estimate: Presence[ReadingTimeEstimateOut]


class LibraryPodcastListItemOut(_Camel):
    kind: Literal["podcast"]
    placement: Presence[LibraryEntryPlacementOut]
    added_at: datetime
    podcast: LibraryEntryPodcastOut
    subscription: Presence[LibraryEntryPodcastSubscriptionOut]
    reading_time_estimate: Presence[ReadingTimeEstimateOut]


LibraryEntryListItemOut = Annotated[
    LibraryMediaListItemOut | LibraryPodcastListItemOut,
    Field(discriminator="kind"),
]


class LibraryMemberOut(_CamelRow):
    user_handle: UserHandle
    role: LibraryRole
    is_owner: bool
    email: Presence[str]
    display_name: Presence[str]
    created_at: datetime


class LibraryInvitationOut(_CamelRow):
    invitation_handle: LibraryInvitationHandle
    library_id: UUID
    inviter_user_handle: UserHandle
    invitee_user_handle: UserHandle
    role: LibraryRole
    status: LibraryInvitationStatusValue
    invitee_email: Presence[str]
    invitee_display_name: Presence[str]
    created_at: datetime
    responded_at: Presence[datetime]


class ViewerLibraryInvitationOut(LibraryInvitationOut):
    library_name: str


class InviteAcceptMembershipOut(_CamelRow):
    library_id: UUID
    user_handle: UserHandle
    role: LibraryRole


class AcceptLibraryInviteResponse(_CamelRow):
    invite: LibraryInvitationOut
    membership: InviteAcceptMembershipOut
    idempotent: bool


class DeclineLibraryInviteResponse(_CamelRow):
    invite: LibraryInvitationOut
    idempotent: bool
