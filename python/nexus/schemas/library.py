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
from nexus.services.podcasts.types import PodcastSyncStatus
from nexus.services.sealed_handles import LibraryInvitationHandle, UserHandle

LibraryRole = Literal["admin", "member"]
LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
LibraryGovernanceCursor = Annotated[str, Field(min_length=1)]
LibraryEntryKind = Literal["media", "podcast"]

_INT32_MAX = 2_147_483_647
_PositiveInt32 = Annotated[int, Field(strict=True, ge=1, le=_INT32_MAX)]


class CreateLibraryRequest(BaseModel):
    library_id: UUID
    name: str = Field(..., min_length=1, max_length=100, description="Library name (1-100 chars)")

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdateLibraryRequest(BaseModel):
    name: str = Field(
        ..., min_length=1, max_length=100, description="New library name (1-100 chars)"
    )


_LIBRARY_MUTATION_OUT_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
)


class LibraryDeleteOut(BaseModel):
    model_config = _LIBRARY_MUTATION_OUT_CONFIG

    library_id: UUID
    collection_revision: CollectionRevision


class LibraryEntryRemovalOut(BaseModel):
    model_config = _LIBRARY_MUTATION_OUT_CONFIG

    library_entries_collection_revision: CollectionRevision


class PodcastPlacementRemovalOut(BaseModel):
    model_config = _LIBRARY_MUTATION_OUT_CONFIG

    outcome: Literal["Removed", "AlreadyAbsent"]
    library_entries_collection_revision: CollectionRevision


class PodcastPlacementAdditionOut(BaseModel):
    model_config = _LIBRARY_MUTATION_OUT_CONFIG

    outcome: Literal["Added", "AlreadyPresent"]
    library_entries_collection_revision: CollectionRevision


_LIBRARY_PLACEMENT_OUT_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
)


class LibraryIdentityOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


class SavedInNexusLibraryPlacementDestinationOut(BaseModel):
    kind: Literal["SavedInNexus"] = "SavedInNexus"

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


class LibraryLibraryPlacementDestinationOut(BaseModel):
    kind: Literal["Library"] = "Library"
    library: LibraryIdentityOut

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


LibraryPlacementDestinationOut = Annotated[
    SavedInNexusLibraryPlacementDestinationOut | LibraryLibraryPlacementDestinationOut,
    Field(discriminator="kind"),
]


class AbsentLibraryPlacementRelationOut(BaseModel):
    kind: Literal["Absent"] = "Absent"

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


class DirectLibraryPlacementRelationOut(BaseModel):
    kind: Literal["Direct"] = "Direct"

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


class InheritedLibraryPlacementRelationOut(BaseModel):
    kind: Literal["Inherited"] = "Inherited"
    provenance: list[LibraryIdentityOut] = Field(min_length=1)

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


LibraryPlacementRelationOut = Annotated[
    AbsentLibraryPlacementRelationOut
    | DirectLibraryPlacementRelationOut
    | InheritedLibraryPlacementRelationOut,
    Field(discriminator="kind"),
]


class AvailableLibraryPlacementAvailabilityOut(BaseModel):
    kind: Literal["Available"] = "Available"

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


class BlockedLibraryPlacementAvailabilityOut(BaseModel):
    kind: Literal["Blocked"] = "Blocked"
    reason: Literal[
        "RequiresAdmin",
        "RequiresSubscription",
        "SystemManaged",
        "Inherited",
    ]

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


LibraryPlacementAvailabilityOut = Annotated[
    AvailableLibraryPlacementAvailabilityOut | BlockedLibraryPlacementAvailabilityOut,
    Field(discriminator="kind"),
]


class LibraryPlacementOptionOut(BaseModel):
    destination: LibraryPlacementDestinationOut
    relation: LibraryPlacementRelationOut
    availability: LibraryPlacementAvailabilityOut

    model_config = _LIBRARY_PLACEMENT_OUT_CONFIG


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


class LibraryRenameOut(BaseModel):
    model_config = _LIBRARY_MUTATION_OUT_CONFIG

    library: LibraryOut
    collection_revision: CollectionRevision


class LibraryPageInfo(BaseModel):
    has_more: bool = False
    next_cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class LibraryGovernancePageInfo(BaseModel):
    next_cursor: Presence[LibraryGovernanceCursor]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LibraryEntryPodcastOut(BaseModel):
    id: UUID
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    unplayed_count: int = Field(ge=0, default=0)
    published_date: Presence[datetime]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryEntryPodcastSubscriptionOut(BaseModel):
    default_playback_speed: Presence[PlaybackRate]
    pause_shortening_mode: Presence[PauseShorteningMode]
    auto_queue: bool = False
    sync_status: PodcastSyncStatus

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryEntryMediaCapabilitiesOut(BaseModel):
    can_quote: bool
    can_retry: bool
    can_refresh_source: bool
    can_retry_metadata: bool
    can_edit_authors: bool
    can_delete: bool

    model_config = ConfigDict(extra="forbid")


class LibraryEntryMediaOut(BaseModel):
    id: UUID
    kind: Literal["web_article", "epub", "pdf", "podcast_episode", "video"]
    title: str
    created_at: datetime
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    author_mode: Literal["automatic", "manual"]
    published_date: str | None
    canonical_source_url: str | None
    processing_status: Literal[
        "pending",
        "extracting",
        "ready_for_reading",
        "failed",
        "suspended",
    ]
    read_state: Literal["unread", "in_progress", "finished"]
    progress_fraction: float | None = Field(default=None, ge=0, le=1)
    progress_resettable: bool
    last_engaged_at: datetime | None = None
    capabilities: LibraryEntryMediaCapabilitiesOut

    model_config = ConfigDict(extra="forbid")


class ReadingTimeEstimateOut(BaseModel):
    total_minutes: _PositiveInt32
    remaining_minutes: Presence[_PositiveInt32]

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class LibraryEntryPlacementOut(BaseModel):
    library_entry_id: UUID
    position: int = Field(ge=0)

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryMediaListItemOut(BaseModel):
    kind: Literal["media"]
    placement: Presence[LibraryEntryPlacementOut]
    added_at: datetime
    media: LibraryEntryMediaOut
    reading_time_estimate: Presence[ReadingTimeEstimateOut] = Field(
        serialization_alias="readingTimeEstimate"
    )

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LibraryPodcastListItemOut(BaseModel):
    kind: Literal["podcast"]
    placement: Presence[LibraryEntryPlacementOut]
    added_at: datetime
    podcast: LibraryEntryPodcastOut
    subscription: Presence[LibraryEntryPodcastSubscriptionOut]
    reading_time_estimate: Presence[ReadingTimeEstimateOut] = Field(
        serialization_alias="readingTimeEstimate"
    )

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


LibraryEntryListItemOut = Annotated[
    LibraryMediaListItemOut | LibraryPodcastListItemOut,
    Field(discriminator="kind"),
]


class LibraryMemberOut(BaseModel):
    user_handle: UserHandle
    role: LibraryRole
    is_owner: bool
    email: Presence[str]
    display_name: Presence[str]
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
    invitee_email: Presence[str]
    invitee_display_name: Presence[str]
    created_at: datetime
    responded_at: Presence[datetime]

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
