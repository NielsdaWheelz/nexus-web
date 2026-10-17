"""Consumption wire: the player descriptor, listening, the Lectern and the read-state writes.
snake_case, absence is null (conventions). A summary's read state (``ConsumptionOut``) lives with
the media summary, which the Lectern's items embed."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.media_summary import MediaSummaryOut

PauseShorteningMode = Literal["Off", "Natural"]
PlaybackRate = Annotated[float, Field(strict=True, ge=0.5, le=3)]
_Int32 = Annotated[int, Field(ge=0, le=2_147_483_647)]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChapterOut(Closed):
    title: str = Field(min_length=1, max_length=300)
    start_ms: _Int32
    end_ms: _Int32 | None


class PlayerDescriptor(Closed):
    """What a device needs to play one episode; ``position_ms`` is the server's resume point and
    ``consumption_override_revision`` the version a natural end is fenced on."""

    media_id: UUID
    title: str = Field(max_length=300)
    subtitle: str | None
    artwork_url: str | None
    stream_url: str
    position_ms: _Int32
    duration_ms: _Int32 | None
    reset_epoch: _Int32
    consumption_override_revision: _Int32 | None
    playback_rate: PlaybackRate
    podcast_id: UUID | None
    pause_shortening_mode: PauseShorteningMode | None
    chapters: list[ChapterOut] = Field(max_length=100)


class ListeningIn(Closed):
    """One sample under its epoch; a null duration or rate keeps the stored one."""

    position_ms: _Int32
    duration_ms: _Int32 | None
    episode_playback_rate: PlaybackRate | None
    expected_reset_epoch: _Int32


class ListeningPositionOut(Closed):
    position_ms: _Int32
    reset_epoch: _Int32
    consumption_override_revision: _Int32 | None


class PreviewPositionIn(Closed):
    position_ms: _Int32
    duration_ms: _Int32 | None


# ---- the Lectern ----


class FooterAudioActivation(Closed):
    kind: Literal["FooterAudio"]
    descriptor: PlayerDescriptor


class ReadableActivation(Closed):
    kind: Literal["Readable"]


class OpenPaneActivation(Closed):
    kind: Literal["OpenPane"]


class LecternItemOut(Closed):
    media_summary: MediaSummaryOut
    added_at: AwareDatetime
    activation: Annotated[
        FooterAudioActivation | ReadableActivation | OpenPaneActivation,
        Field(discriminator="kind"),
    ]


class LecternOut(Closed):
    """The visible rows; ``at_capacity`` counts the whole membership, hidden rows included."""

    items: list[LecternItemOut] = Field(max_length=2000)
    at_capacity: bool
    order_revision: OrderRevision


class LecternWriteOut(Closed):
    order_revision: OrderRevision


class LecternOrderOut(Closed):
    order_revision: OrderRevision
    media_ids: list[UUID]


class MoveLecternItemRequest(Closed):
    before_media_id: UUID | None
    expected_order_revision: OrderRevision


class FirstPlacement(Closed):
    kind: Literal["First"]


class AfterPlacement(Closed):
    """After this media's visible row; first when it has none."""

    kind: Literal["After"]
    media_id: UUID


Placement = Annotated[FirstPlacement | AfterPlacement, Field(discriminator="kind")]


class PlaceIn(Closed):
    """A null placement only ensures membership: an absent media goes last, a present row stays."""

    placement: Placement | None
    expected_order_revision: OrderRevision


# ---- read-state writes ----


class FinishIn(Closed):
    leave_lectern: bool


class RemovedItem(Closed):
    """A Lectern row a finish removed: put back with its id and added time."""

    item_id: UUID
    added_at: datetime
    after_item_id: UUID | None


class Finish(Closed):
    """A finish's answer and its undo's body: the revision it wrote, the status it replaced, the
    completion fact it recorded and the row it removed."""

    revision: _Int32
    prior_status: Literal["finished", "unread"] | None
    completion_id: UUID | None
    removed: RemovedItem | None


class NaturalEndIn(Closed):
    terminal_listening: ListeningIn
    expected_override_revision: _Int32 | None
