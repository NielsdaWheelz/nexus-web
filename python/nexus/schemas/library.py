"""Library wire: collections, their entries and where an item is filed.

Snake keys and plain nullable values; requests forbid unknown keys. Membership and
invitation models live in `schemas/library_members.py`.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.podcast import LibraryPodcastIndexOut

LibraryRole = Literal["admin", "member"]
LibraryName = Annotated[str, Field(min_length=1, max_length=100)]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CreateLibraryRequest(_In):
    """Retry: resend the same client-minted id."""

    id: UUID
    name: LibraryName
    initial_items: list[str]
    expected_removal_revision: OrderRevision | None

    @model_validator(mode="after")
    def _guard(self) -> "CreateLibraryRequest":
        if bool(self.initial_items) != (self.expected_removal_revision is not None):
            raise ValueError(
                "Initial items require a removal revision; empty creation requires null"
            )
        return self


class RenameLibraryRequest(_In):
    """`expected_name` is the name the client last read (the expected version)."""

    name: LibraryName
    expected_name: str


class MoveEntryRequest(_In):
    """Put the entry immediately before `before_entry_id`; null puts it last."""

    before_entry_id: UUID | None
    expected_order_revision: OrderRevision


class LibraryOrderOut(BaseModel):
    order_revision: OrderRevision
    entry_ids: list[UUID]


class PlaceItemRequest(_In):
    """One absolute media placement with frozen guards."""

    included: bool
    expected_order_revision: OrderRevision
    expected_removal_revision: OrderRevision | None

    @model_validator(mode="after")
    def _guard(self) -> "PlaceItemRequest":
        if self.included != (self.expected_removal_revision is not None):
            raise ValueError("Inclusion requires a removal revision; exclusion requires null")
        return self


class LibraryOut(BaseModel):
    id: UUID
    name: str
    is_default: bool
    role: LibraryRole
    order_revision: OrderRevision
    can_add_content: bool
    # rename, file, reorder and manage members: an admin of a named, non-system library.
    can_manage: bool
    # delete and transfer: its owner.
    can_delete: bool
    can_transfer_ownership: bool
    # leave: any member of a mutable library but its owner.
    can_leave: bool


class LibraryMetadataOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    library: LibraryOut
    kind: Literal["personal", "named", "system"]
    created_at: datetime
    updated_at: datetime
    media_count: int = Field(ge=0)


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str
    order_revision: OrderRevision


class LibraryDestinationsOut(BaseModel):
    removal_revision: OrderRevision
    destinations: list[LibraryDestinationOut]


class LibraryMediaEntryOut(BaseModel):
    kind: Literal["media"]
    # null on All, whose rows are a live union rather than stored entries.
    entry_id: UUID | None
    added_at: datetime
    media_summary: MediaSummaryOut


LibraryEntryOut = LibraryMediaEntryOut


class LibraryEntriesIndexOut(BaseModel):
    """Only the unfiltered manual-order view carries a structural revision."""

    library: LibraryOut
    items: list[LibraryEntryOut]
    order_revision: OrderRevision | None
    podcasts: LibraryPodcastIndexOut

    model_config = ConfigDict(extra="forbid")


class LibraryPlacementOut(BaseModel):
    """A named placement and its exact command precondition."""

    library_id: UUID
    name: str
    order_revision: OrderRevision
    relation: Literal["Absent", "Direct"]
    blocked: Literal["RequiresAdmin", "SystemManaged", "PodcastSubscription"] | None


class LibraryAllMembershipOut(BaseModel):
    """Effective all membership, addressed through the viewer's real personal library."""

    library_id: UUID
    order_revision: OrderRevision
    included: bool
    remove_blocked: Literal["RequiresAdmin", "PodcastSubscription"] | None


class LibraryPlacementsOut(BaseModel):
    removal_revision: OrderRevision
    all_membership: LibraryAllMembershipOut
    placements: list[LibraryPlacementOut]
