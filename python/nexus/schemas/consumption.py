"""Consumption/Lectern wire contracts (spec
``lectern-player-lifecycle-hard-cutover.md`` §§4–5).

Every model here is strict camelCase: ``alias_generator=to_camel`` with
``populate_by_name=False`` on request/command families (camel in only) and
``populate_by_name=True`` on response families (constructed with snake field
names by the projection, serialized ``by_alias=True`` by the routes). All models
``extra="forbid"``; discriminator values are ``PascalCase``. Owned absence uses
the repository-wide :mod:`nexus.schemas.presence` encoding — ``null``, omission,
and alternate casing are rejected.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Presence

# The signed 32-bit ceiling every non-negative integer wire field shares.
_INT32_MAX = 2_147_483_647

_IN_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")
_OUT_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

ConsumptionStateValue = Literal["Unread", "InProgress", "Finished"]
NextCapability = Literal["Stop", "FooterAudio", "Readable"]
ConsumptionMediaKind = Literal["web_article", "epub", "pdf", "video", "podcast_episode"]
RECENT_CONSUMPTION_MAX_ITEMS = 50

_NonNegInt32 = Annotated[int, Field(ge=0, le=_INT32_MAX)]


# ---------------------------------------------------------------------------
# Read model: Lectern snapshot + items
# ---------------------------------------------------------------------------


class ChapterOut(BaseModel):
    """One playable chapter marker (title clamped to 300 in the projection)."""

    model_config = _OUT_CONFIG

    title: str = Field(min_length=1, max_length=300)
    start_ms: _NonNegInt32
    end_ms: Presence[_NonNegInt32]


class FooterAudioActivation(BaseModel):
    """The only footer-playable activation (spec §3.2 invariant 5)."""

    model_config = _OUT_CONFIG

    kind: Literal["FooterAudio"] = "FooterAudio"
    stream_url: str
    source_url: str
    position_ms: _NonNegInt32
    write_revision: _NonNegInt32
    reset_epoch: _NonNegInt32
    playback_speed: float = Field(ge=0.25, le=3)
    duration_ms: Presence[_NonNegInt32]
    artwork_url: Presence[str]
    chapters: list[ChapterOut] = Field(max_length=100)


class ReadableActivation(BaseModel):
    """Web article, EPUB, or PDF: opened in the reader, never footer-playable."""

    model_config = _OUT_CONFIG

    kind: Literal["Readable"] = "Readable"


class OpenPaneActivation(BaseModel):
    """Video or a podcast without audio: opens a media pane, never ``<audio>``."""

    model_config = _OUT_CONFIG

    kind: Literal["OpenPane"] = "OpenPane"


LecternActivation = Annotated[
    FooterAudioActivation | ReadableActivation | OpenPaneActivation,
    Field(discriminator="kind"),
]


class ConsumptionOut(BaseModel):
    """Per-item derived consumption state plus finite progress fraction."""

    model_config = _OUT_CONFIG

    state: ConsumptionStateValue
    progress: Presence[Annotated[float, Field(ge=0, le=1)]]


class LecternItemOut(BaseModel):
    """One On-Lectern item, canonical and replaced wholesale by leaves."""

    model_config = _OUT_CONFIG

    item_id: UUID
    media_id: UUID
    kind: ConsumptionMediaKind
    title: str
    subtitle: Presence[str]
    href: str
    consumption: ConsumptionOut
    activation: LecternActivation


class LecternSnapshot(BaseModel):
    """The whole ordered Lectern for a viewer (visible rows only)."""

    model_config = _OUT_CONFIG

    items: list[LecternItemOut] = Field(max_length=2000)


class PlayerDescriptor(BaseModel):
    """A footer-playable descriptor reused by every Play entry point."""

    model_config = _OUT_CONFIG

    media_id: UUID
    title: str
    subtitle: Presence[str]
    activation: FooterAudioActivation


class RecentConsumptionItemOut(BaseModel):
    """One visible item with truthful reader/listener engagement recency."""

    model_config = _OUT_CONFIG

    media_id: UUID
    kind: ConsumptionMediaKind
    title: str
    href: str
    consumption: ConsumptionOut
    last_engaged_at: datetime
    player_descriptor: Presence[PlayerDescriptor]


class RecentConsumptionSnapshot(BaseModel):
    """Bounded daily-return surface; independent from the ordered Lectern."""

    model_config = _OUT_CONFIG

    items: list[RecentConsumptionItemOut] = Field(max_length=RECENT_CONSUMPTION_MAX_ITEMS)


# ---------------------------------------------------------------------------
# Lectern commands (POST /lectern/commands)
# ---------------------------------------------------------------------------


class FirstPlacement(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["First"]


class AfterPlacement(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["After"]
    item_id: UUID


class LastPlacement(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["Last"]


Placement = Annotated[FirstPlacement | AfterPlacement | LastPlacement, Field(discriminator="kind")]


class PlaceItemsCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["PlaceItems"]
    client_mutation_id: UUID
    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    placement: Placement


class RemoveItemCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["RemoveItem"]
    client_mutation_id: UUID
    item_id: UUID


class SetOrderCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["SetOrder"]
    client_mutation_id: UUID
    item_ids: list[UUID] = Field(min_length=0, max_length=2000)


LecternCommand = Annotated[
    PlaceItemsCommand | RemoveItemCommand | SetOrderCommand, Field(discriminator="kind")
]


class PlacedOutcome(BaseModel):
    model_config = _OUT_CONFIG
    kind: Literal["Placed"] = "Placed"
    item_ids: list[UUID]


class RemovedOutcome(BaseModel):
    model_config = _OUT_CONFIG
    kind: Literal["Removed"] = "Removed"
    item_id: UUID


class OrderedOutcome(BaseModel):
    model_config = _OUT_CONFIG
    kind: Literal["Ordered"] = "Ordered"


LecternOutcome = Annotated[
    PlacedOutcome | RemovedOutcome | OrderedOutcome, Field(discriminator="kind")
]


class LecternResult(BaseModel):
    model_config = _OUT_CONFIG
    outcome: LecternOutcome
    lectern: LecternSnapshot


# ---------------------------------------------------------------------------
# Consumption commands (POST /consumption/commands)
# ---------------------------------------------------------------------------


class EnsureMediaFinishedCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["EnsureMediaFinished"]
    client_mutation_id: UUID
    media_id: UUID


class FinishLecternItemCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["FinishLecternItem"]
    client_mutation_id: UUID
    media_id: UUID
    item_id: UUID
    next_capability: NextCapability


class SetUnreadCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["SetUnread"]
    client_mutation_id: UUID
    media_id: UUID


class SetBatchStateCommand(BaseModel):
    model_config = _IN_CONFIG
    kind: Literal["SetBatchState"]
    client_mutation_id: UUID
    media_ids: list[UUID] = Field(min_length=1, max_length=1000)
    state: Literal["Finished", "Unread"]


ConsumptionCommand = Annotated[
    EnsureMediaFinishedCommand | FinishLecternItemCommand | SetUnreadCommand | SetBatchStateCommand,
    Field(discriminator="kind"),
]


class ListeningStateOut(BaseModel):
    """Position/duration/speed plus heartbeat fencing tokens for one media."""

    model_config = _OUT_CONFIG

    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    playback_speed: float = Field(ge=0.25, le=3)
    write_revision: _NonNegInt32
    reset_epoch: _NonNegInt32


class ListeningStateEntry(BaseModel):
    """A ``(mediaId, state)`` pair for media reset by a logical Unread command."""

    model_config = _OUT_CONFIG

    media_id: UUID
    state: ListeningStateOut


class StateOnlyOutcome(BaseModel):
    model_config = _OUT_CONFIG
    kind: Literal["StateOnly"] = "StateOnly"


class ConsumptionRemovedOutcome(BaseModel):
    model_config = _OUT_CONFIG
    kind: Literal["Removed"] = "Removed"
    item_id: UUID
    next_item_id: Presence[UUID]


ConsumptionOutcome = Annotated[
    StateOnlyOutcome | ConsumptionRemovedOutcome, Field(discriminator="kind")
]


class ConsumptionResult(BaseModel):
    model_config = _OUT_CONFIG
    outcome: ConsumptionOutcome
    lectern: LecternSnapshot
    next_item: Presence[LecternItemOut]
    listening_states: list[ListeningStateEntry]


# ---------------------------------------------------------------------------
# Listening heartbeat (GET/PUT /media/{id}/listening-state)
# ---------------------------------------------------------------------------


class ListeningHeartbeatIn(BaseModel):
    """PUT body: all fields required, no completion field (spec §5.4)."""

    model_config = _IN_CONFIG

    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    playback_speed: float = Field(ge=0.25, le=3)
    expected_write_revision: _NonNegInt32
    expected_reset_epoch: _NonNegInt32
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32


class ListeningHeartbeatResult(BaseModel):
    model_config = _OUT_CONFIG

    listening_state: ListeningStateOut
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32
