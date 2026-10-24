"""Finite collection snapshots, absolute state writes, exact inverse receipts and Lectern batches.

Nullable keys are required. Apply and inverse arrays are nonempty and unique; the
client retains the exact request or acknowledged inverse, never a server replay ledger.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.collection_order import OrderRevision


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PodcastCollectionTarget(_Closed):
    kind: Literal["Podcast"]
    podcast_id: UUID


class LibraryCollectionTarget(_Closed):
    kind: Literal["Library"]
    library_id: UUID


type CollectionTarget = Annotated[
    PodcastCollectionTarget | LibraryCollectionTarget, Field(discriminator="kind")
]


class PodcastCollectionSelection(PodcastCollectionTarget):
    state: Literal["all", "unplayed", "in_progress", "played"]


type CollectionSelection = Annotated[
    PodcastCollectionSelection | LibraryCollectionTarget, Field(discriminator="kind")
]
type _Revision = Annotated[int, Field(strict=True, ge=1)]
type _Count = Annotated[int, Field(strict=True, ge=0)]
type _Status = Literal["finished", "unread"]


class StateItem(_Closed):
    media_id: UUID
    expected_override_revision: _Revision | None


class UndoItem(_Closed):
    media_id: UUID
    applied_override_revision: _Revision
    prior_status: _Status | None
    created_completion_id: UUID | None


class CollectionConsumptionPrepareRequest(_Closed):
    selection: CollectionSelection


class CollectionConsumptionPreparedOut(_Closed):
    label: str
    items: list[StateItem]


class CollectionConsumptionRequest(_Closed):
    target: CollectionTarget
    desired_state: _Status
    items: list[StateItem] = Field(min_length=1)

    @model_validator(mode="after")
    def require_unique_media(self) -> "CollectionConsumptionRequest":
        if len({item.media_id for item in self.items}) != len(self.items):
            raise ValueError("Duplicate media ids")
        return self


class CollectionConsumptionUndoReceipt(_Closed):
    # The acknowledged inverse is exactly the next request body, in both schema modes.
    model_config = ConfigDict(json_schema_mode_override="validation")

    applied_status: _Status
    items: list[UndoItem] = Field(min_length=1)

    @model_validator(mode="after")
    def require_inverse(self) -> "CollectionConsumptionUndoReceipt":
        if len({item.media_id for item in self.items}) != len(self.items):
            raise ValueError("Duplicate media ids")
        for item in self.items:
            if item.prior_status == self.applied_status:
                raise ValueError("Prior status must differ from applied status")
            if self.applied_status == "unread" and item.created_completion_id is not None:
                raise ValueError("Unread cannot create a completion fact")
        return self


class CollectionConsumptionOut(_Closed):
    matched_count: _Count
    changed_count: _Count
    undo: CollectionConsumptionUndoReceipt | None


class CollectionConsumptionUndoOut(_Closed):
    restored_count: _Count


class CollectionLecternPrepareRequest(_Closed):
    target: CollectionTarget


class CollectionLecternPreparedOut(_Closed):
    label: str
    media_ids: list[UUID]
    expected_order_revision: OrderRevision
    already_present_count: _Count
    available_slots: _Count


class CollectionLecternRequest(_Closed):
    target: CollectionTarget
    media_ids: list[UUID] = Field(min_length=1)
    expected_order_revision: OrderRevision

    @model_validator(mode="after")
    def require_unique_media(self) -> "CollectionLecternRequest":
        if len(set(self.media_ids)) != len(self.media_ids):
            raise ValueError("Duplicate media ids")
        return self


class CollectionLecternOut(_Closed):
    order_revision: OrderRevision
    matched_count: _Count
    added_count: _Count
