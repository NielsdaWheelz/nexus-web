"""Lectern, consumption command, player and listening wire contracts: strict camelCase, owned
absence via :mod:`nexus.schemas.presence`."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, model_validator

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption_activity import CamelIn, CamelOut, CommandIn, CompletionHandle
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence
from nexus.schemas.reader import ReaderCursorSnapshot

ConsumptionStateValue = Literal["Unread", "InProgress", "Finished"]
NextCapability = Literal["Stop", "FooterAudio", "Readable"]
PauseShorteningMode = Literal["Off", "Natural"]
PlaybackRate = Annotated[float, Field(strict=True, ge=0.5, le=3)]
_NonNegInt32 = Annotated[int, Field(ge=0, le=2_147_483_647)]


class ChapterOut(CamelOut):
    title: str = Field(min_length=1, max_length=300)
    start_ms: _NonNegInt32
    end_ms: Presence[_NonNegInt32]


class PodcastPlaybackPreference(CamelOut):
    podcast_id: UUID
    value: Presence[PlaybackRate]


class PlaybackRateResolution(CamelOut):
    value: PlaybackRate
    source: Literal["Episode", "Podcast", "Product"]
    podcast_preference: Presence[PodcastPlaybackPreference]

    @model_validator(mode="after")
    def _validate_source(self) -> PlaybackRateResolution:
        if self.source == "Podcast":
            if (
                self.podcast_preference.kind != "Present"
                or self.podcast_preference.value.value.kind != "Present"
                or self.podcast_preference.value.value.value != self.value
            ):
                raise ValueError("Podcast source must equal the present podcast preference")
        if self.source == "Product":
            if self.value != 1:
                raise ValueError("Product source must resolve to 1")
            if (
                self.podcast_preference.kind == "Present"
                and self.podcast_preference.value.value.kind == "Present"
            ):
                raise ValueError("a present podcast preference must resolve from Podcast")
        return self


class FooterAudioActivation(CamelOut):
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


class ReadableActivation(CamelOut):
    kind: Literal["Readable"] = "Readable"


class OpenPaneActivation(CamelOut):
    kind: Literal["OpenPane"] = "OpenPane"


LecternActivation = Annotated[
    FooterAudioActivation | ReadableActivation | OpenPaneActivation, Field(discriminator="kind")
]


class ConsumptionOut(CamelOut):
    state: ConsumptionStateValue
    progress: Presence[Annotated[float, Field(ge=0, le=1)]]
    progress_resettable: bool


class PlayerDisplay(CamelOut):
    title: str
    subtitle: Presence[str]


class LecternItemOut(CamelOut):
    item_id: UUID
    media_summary: MediaSummaryOut
    href: str
    added_at: AwareDatetime
    consumption: ConsumptionOut
    activation: LecternActivation
    player_display: Presence[PlayerDisplay]


class LecternSnapshot(CamelOut):
    items: list[LecternItemOut] = Field(max_length=2000)


class PlayerDescriptor(CamelOut):
    media_id: UUID
    title: str
    subtitle: Presence[str]
    activation: FooterAudioActivation


class FirstPlacement(CamelIn):
    kind: Literal["First"]


class AfterPlacement(CamelIn):
    kind: Literal["After"]
    item_id: UUID


class LastPlacement(CamelIn):
    kind: Literal["Last"]


Placement = Annotated[FirstPlacement | AfterPlacement | LastPlacement, Field(discriminator="kind")]


class PlaceItemsCommand(CommandIn):
    kind: Literal["PlaceItems"]
    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    placement: Placement


class RemoveItemCommand(CommandIn):
    kind: Literal["RemoveItem"]
    item_id: UUID


class SetOrderCommand(CommandIn):
    kind: Literal["SetOrder"]
    item_ids: list[UUID] = Field(min_length=0, max_length=2000)


LecternCommand = Annotated[
    PlaceItemsCommand | RemoveItemCommand | SetOrderCommand, Field(discriminator="kind")
]


class PlacedOutcome(CamelOut):
    kind: Literal["Placed"] = "Placed"
    item_ids: list[UUID]


class RemovedOutcome(CamelOut):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID


class OrderedOutcome(CamelOut):
    kind: Literal["Ordered"] = "Ordered"


LecternOutcome = Annotated[
    PlacedOutcome | RemovedOutcome | OrderedOutcome, Field(discriminator="kind")
]


class LecternResult(CamelOut):
    outcome: LecternOutcome
    lectern: LecternSnapshot


class EnsureMediaFinishedCommand(CommandIn):
    kind: Literal["EnsureMediaFinished"]
    media_id: UUID


class FinishLecternItemCommand(CommandIn):
    kind: Literal["FinishLecternItem"]
    media_id: UUID
    item_id: UUID
    next_capability: NextCapability


class SetUnreadCommand(CommandIn):
    kind: Literal["SetUnread"]
    media_id: UUID


class ResetProgressCommand(CommandIn):
    kind: Literal["ResetProgress"]
    media_id: UUID


class UndoCompletionCommand(CommandIn):
    kind: Literal["UndoCompletion"]
    completion_handle: CompletionHandle


class SetBatchStateCommand(CommandIn):
    kind: Literal["SetBatchState"]
    media_ids: list[UUID] = Field(min_length=1, max_length=1000)
    state: Literal["Finished", "Unread"]


class DirectNaturalEndOrigin(CamelIn):
    kind: Literal["Direct"]


class LecternNaturalEndOrigin(CamelIn):
    kind: Literal["Lectern"]
    item_id: UUID


NaturalEndOrigin = Annotated[
    DirectNaturalEndOrigin | LecternNaturalEndOrigin, Field(discriminator="kind")
]


class TerminalListeningIn(CamelIn):
    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    episode_playback_rate: Presence[PlaybackRate]
    expected_write_revision: _NonNegInt32
    expected_reset_epoch: _NonNegInt32


class SettleNaturalEndCommand(CommandIn):
    kind: Literal["SettleNaturalEnd"]
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


class ConsumptionStateOutcome(CamelOut):
    kind: ConsumptionOutcomeKind


class ConsumptionRemovedOutcome(CamelOut):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID
    next_item_id: Presence[UUID]


ConsumptionOutcome = Annotated[
    ConsumptionStateOutcome | ConsumptionRemovedOutcome, Field(discriminator="kind")
]


class ListeningStateOut(CamelOut):
    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
    episode_playback_rate: Presence[PlaybackRate]
    write_revision: _NonNegInt32
    reset_epoch: _NonNegInt32


class MediaProgressState(CamelOut):
    media_id: UUID
    reader_cursor: ReaderCursorSnapshot
    listening_state: Presence[ListeningStateOut]


class ConsumptionResult(CamelOut):
    outcome: ConsumptionOutcome
    lectern: LecternSnapshot
    next_item: Presence[LecternItemOut]
    progress_state: Presence[MediaProgressState]
    completion_handle: Presence[CompletionHandle]
    library_entries_collection_revision: CollectionRevision


class ListeningHeartbeatIn(TerminalListeningIn):
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32


class ListeningHeartbeatResult(CamelOut):
    listening_state: ListeningStateOut
    heartbeat_generation: UUID
    heartbeat_sequence: _NonNegInt32


class PreviewPositionIn(CamelIn):
    position_ms: _NonNegInt32
    duration_ms: Presence[_NonNegInt32]
