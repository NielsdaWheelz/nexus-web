"""Library wire: collections, their entries and where an item is filed.

Snake keys and plain nullable values; requests forbid unknown keys. Membership and
invitation models live in `schemas/library_members.py`.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.podcast import PodcastSyncStatus

LibraryRole = Literal["admin", "member"]
LibraryName = Annotated[str, Field(min_length=1, max_length=100)]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CreateLibraryRequest(_In):
    """Retry: resend the same client-minted id."""

    id: UUID
    name: LibraryName


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
    """`replace_episodes` confirms that a show replaces its directly filed episodes."""

    replace_episodes: bool


class LibraryOut(BaseModel):
    id: UUID
    name: str
    is_default: bool
    role: LibraryRole
    # rename, file, reorder and manage members: an admin of a named, non-system library.
    can_manage: bool
    # delete and transfer: its owner.
    can_delete: bool
    can_transfer_ownership: bool
    # leave: any member of a mutable library but its owner.
    can_leave: bool


class LibraryDestinationOut(BaseModel):
    id: UUID
    name: str


class LibraryMediaEntryOut(BaseModel):
    kind: Literal["media"]
    # null on All, whose rows are a live union rather than stored entries.
    entry_id: UUID | None
    added_at: datetime
    media_summary: MediaSummaryOut


class LibraryPodcastEntryOut(BaseModel):
    kind: Literal["podcast"]
    entry_id: UUID | None
    added_at: datetime
    podcast_id: UUID
    title: str
    contributors: list[ContributorCreditOut]
    unplayed_count: int = Field(ge=0)
    published_date: datetime | None
    sync_status: PodcastSyncStatus | None


LibraryEntryOut = Annotated[
    LibraryMediaEntryOut | LibraryPodcastEntryOut, Field(discriminator="kind")
]


class LibraryEntriesPageOut(CollectionPage[LibraryEntryOut]):
    """Only the unfiltered manual-order view carries a structural revision."""

    order_revision: OrderRevision | None


class LibraryPlacementOut(BaseModel):
    """One library the item could sit in; `is_default` is the viewer's All (Saved in
    Nexus). Inherited: an episode included through its filed show."""

    library_id: UUID
    name: str
    is_default: bool
    relation: Literal["Absent", "Direct", "Inherited"]
    blocked: Literal["RequiresAdmin", "RequiresSubscription", "SystemManaged"] | None
