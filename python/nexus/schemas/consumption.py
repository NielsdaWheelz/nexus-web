"""Consumption/Lectern wire contracts.

Every model is strict camelCase. Command families are camel-in only; response
families are built with snake field names by the projection and serialized
``by_alias=True`` by the routes. All models ``extra="forbid"``; discriminator
values are PascalCase. Owned absence uses :mod:`nexus.schemas.presence` — null,
omission, and alternate casing are rejected.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption_activity import CompletionHandle
from nexus.schemas.presence import Presence
from nexus.schemas.reader import ReaderCursorSnapshot

_INT32_MAX = 2_147_483_647


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")


class _Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


ConsumptionStateValue = Literal["Unread", "InProgress", "Finished"]
NextCapability = Literal["Stop", "FooterAudio", "Readable"]
ConsumptionMediaKind = Literal["web_article", "epub", "pdf", "video", "podcast_episode"]
PauseShorteningMode = Literal["Off", "Natural"]
PlaybackRate = Annotated[float, Field(strict=True, ge=0.5, le=3)]
_NonNegInt32 = Annotated[int, Field(ge=0, le=_INT32_MAX)]


class ChapterOut(_Out):
    """One playable chapter marker (title clamped to 300 in the projection)."""

    title: str = Field(min_length=1, max_length=300)
    start_ms: _NonNegInt32
    end_ms: Presence[_NonNegInt32]


class PodcastPlaybackPreference(_Out):
    podcast_id: UUID
    value: Presence[PlaybackRate]


class PlaybackRateResolution(_Out):
    value: PlaybackRate
    source: Literal["Episode", "Podcast", "Product"]
    podcast_preference: Presence[PodcastPlaybackPreference]


class FooterAudioActivation(_Out):
    """The only footer-playable activation."""

    kind: Literal["FooterAudio"] = "FooterAudio"
    stream_url: str
    source_url: str
    position_ms: _NonNegInt32
    write_revision: _NonNegInt32
    reset_epoch: _NonNegInt32
    playback_rate: PlaybackRateResolution
    pause_shortening_mode: Presence[PauseShorteningMode]
    consumption_override_revision: Presence[_NonNegInt32]
    duration_ms: Presence[_NonNegInt32]
    artwork_url: Presence[str]
    chapters: list[ChapterOut] = Field(max_length=100)


class ReadableActivation(_Out):
    """Web article, EPUB, or PDF: opened in the reader, never footer-playable."""

    kind: Literal["Readable"] = "Readable"


class OpenPaneActivation(_Out):
    """Video or a podcast without audio: opens a media pane, never ``<audio>``."""

    kind: Literal["OpenPane"] = "OpenPane"


LecternActivation = Annotated[
    FooterAudioActivation | ReadableActivation | OpenPaneActivation,
    Field(discriminator="kind"),
]


class ConsumptionOut(_Out):
    state: ConsumptionStateValue
    progress: Presence[Annotated[float, Field(ge=0, le=1)]]
    progress_resettable: bool


class LecternItemOut(_Out):
    item_id: UUID
    media_id: UUID
    kind: ConsumptionMediaKind
    title: str
    subtitle: Presence[str]
    href: str
    added_at: AwareDatetime
    consumption: ConsumptionOut
    activation: LecternActivation


class LecternSnapshot(_Out):
    items: list[LecternItemOut] = Field(max_length=2000)


class PlayerDescriptor(_Out):
    """A footer-playable descriptor reused by every Play entry point."""

    media_id: UUID
    title: str
    subtitle: Presence[str]
    activation: FooterAudioActivation


class FirstPlacement(_In):
    kind: Literal["First"]


class AfterPlacement(_In):
    kind: Literal["After"]
    item_id: UUID


class LastPlacement(_In):
    kind: Literal["Last"]


Placement = Annotated[FirstPlacement | AfterPlacement | LastPlacement, Field(discriminator="kind")]


class PlaceItemsCommand(_In):
    kind: Literal["PlaceItems"]
    client_mutation_id: UUID
    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    placement: Placement


class RemoveItemCommand(_In):
    kind: Literal["RemoveItem"]
    client_mutation_id: UUID
    item_id: UUID


class SetOrderCommand(_In):
    kind: Literal["SetOrder"]
    client_mutation_id: UUID
    item_ids: list[UUID] = Field(min_length=0, max_length=2000)


LecternCommand = Annotated[
    PlaceItemsCommand | RemoveItemCommand | SetOrderCommand, Field(discriminator="kind")
]


class PlacedOutcome(_Out):
    kind: Literal["Placed"] = "Placed"
    item_ids: list[UUID]


class RemovedOutcome(_Out):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID


class OrderedOutcome(_Out):
    kind: Literal["Ordered"] = "Ordered"


LecternOutcome = Annotated[
    PlacedOutcome | RemovedOutcome | OrderedOutcome, Field(discriminator="kind")
]


class LecternResult(_Out):
    outcome: LecternOutcome
    lectern: LecternSnapshot


class EnsureMediaFinishedCommand(_In):
    kind: Literal["EnsureMediaFinished"]
    client_mutation_id: UUID
    media_id: UUID


class FinishLecternItemCommand(_In):
    kind: Literal["FinishLecternItem"]
    client_mutation_id: UUID
    media_id: UUID
    item_id: UUID
    next_capability: NextCapability


class SetUnreadCommand(_In):
    kind: Literal["SetUnread"]
    client_mutation_id: UUID
    media_id: UUID


class ResetProgressCommand(_In):
    kind: Literal["ResetProgress"]
    client_mutation_id: UUID
    media_id: UUID


class UndoCompletionCommand(_In):
    kind: Literal["UndoCompletion"]
    client_mutation_id: UUID
    completion_handle: CompletionHandle


class SetBatchStateCommand(_In):
    kind: Literal["SetBatchState"]
    client_mutation_id: UUID
    media_ids: list[UUID] = Field(min_length=1, max_length=1000)
    state: Literal["Finished", "Unread"]


class DirectNaturalEndOrigin(_In):
    kind: Literal["Direct"]


class LecternNaturalEndOrigin(_In):
    kind: Literal["Lectern"]
    item_id: UUID


NaturalEndOrigin = Annotated[
    DirectNaturalEndOrigin | LecternNaturalEndOrigin,
    Field(discriminator="kind"),
]


class TerminalListeningIn(_In):
    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    episode_playback_rate: Presence[PlaybackRate]
    expected_write_revision: _NonNegInt32
    expected_reset_epoch: _NonNegInt32


class SettleNaturalEndCommand(_In):
    kind: Literal["SettleNaturalEnd"]
    client_mutation_id: UUID
    media_id: UUID
    origin: NaturalEndOrigin
    terminal_listening: TerminalListeningIn
    expected_consumption_override_revision: Presence[_NonNegInt32]
    next_capability: Literal["FooterAudio"]


ConsumptionCommand = Annotated[
    EnsureMediaFinishedCommand
    | FinishLecternItemCommand
    | SetUnreadCommand
    | ResetProgressCommand
    | UndoCompletionCommand
    | SetBatchStateCommand
    | SettleNaturalEndCommand,
    Field(discriminator="kind"),
]

ConsumptionOutcomeKind = Literal[
    "StateOnly", "Completed", "CompletedWithoutAdvance", "Superseded", "TargetGone"
]


class ConsumptionStateOutcome(_Out):
    """The five payload-free outcomes; each serializes as ``{"kind": ...}`` alone."""

    kind: ConsumptionOutcomeKind


class ConsumptionRemovedOutcome(_Out):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID
    next_item_id: Presence[UUID]


ConsumptionOutcome = Annotated[
    ConsumptionStateOutcome | ConsumptionRemovedOutcome, Field(discriminator="kind")
]


class ListeningStateOut(_Out):
    """Position/duration/episode rate plus heartbeat fencing tokens."""

    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    episode_playback_rate: Presence[PlaybackRate]
    write_revision: _NonNegInt32
    reset_epoch: _NonNegInt32


class MediaProgressState(_Out):
    """Canonical current-progress snapshot installed after a reset."""

    media_id: UUID
    reader_cursor: ReaderCursorSnapshot
    listening_state: Presence[ListeningStateOut]


class ConsumptionResult(_Out):
    outcome: ConsumptionOutcome
    lectern: LecternSnapshot
    next_item: Presence[LecternItemOut]
    progress_state: Presence[MediaProgressState]
    completion_handle: Presence[CompletionHandle]
    library_entries_collection_revision: CollectionRevision


class ListeningHeartbeatIn(_In):
    """PUT body for ``/media/{id}/listening-state``: every field required."""

    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    episode_playback_rate: Presence[PlaybackRate]
    expected_write_revision: _NonNegInt32
    expected_reset_epoch: _NonNegInt32
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32


class ListeningHeartbeatResult(_Out):
    listening_state: ListeningStateOut
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32


class PreviewPositionIn(_In):
    """One post-acquisition transfer from an ephemeral Preview audio session."""

    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
