"""Consumption wire: camelCase bases, activity capture, the Lectern, the player descriptor,
listening writes and the consumption commands. Absence is owned via :mod:`nexus.schemas.presence`.

The capture body is posted by the web and the Android app; raw device ids arrive only through
the BFF.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Absent, Presence
from nexus.schemas.reader import ReaderCursorSnapshot

ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
PauseShorteningMode = Literal["Off", "Natural"]
PlaybackRate = Annotated[float, Field(strict=True, ge=0.5, le=3)]
_Int32 = Annotated[int, Field(ge=0, le=2_147_483_647)]
_Position = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
_Progress = Annotated[float, Field(ge=0, le=1)]


class CamelIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")


class CamelOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class _Tagged(CamelOut):
    """An output variant whose defaulted ``kind`` the generated wire still marks required."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class CommandIn(CamelIn):
    """A write that replays by its ``clientMutationId``."""

    client_mutation_id: UUID


# ---- activity capture ----


class _SpanIn(CamelIn):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: int = Field(gt=0, le=30_000)

    @model_validator(mode="after")
    def _paired(self) -> Self:
        """Each ``*_start`` measurement is present exactly when its ``*_end`` is."""
        for start in (name for name in type(self).model_fields if "_start" in name):
            end = start.replace("_start", "_end")
            if isinstance(getattr(self, start), Absent) != isinstance(getattr(self, end), Absent):
                raise ValueError(
                    f"{to_camel(start)} and {to_camel(end)} must have the same presence"
                )
        return self


class ViewingActivitySpanIn(_SpanIn):
    pass


class ReadingActivitySpanIn(_SpanIn):
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]
    word_start: Presence[_Position]
    word_end: Presence[_Position]


class ListeningActivitySpanIn(_SpanIn):
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]
    media_position_start_ms: Presence[_Position]
    media_position_end_ms: Presence[_Position]


class ReadingActivityBatchIn(CamelIn):
    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(CamelIn):
    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(CamelIn):
    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]


class ActivityRecordIn(CamelIn):
    media_ref: str = Field(min_length=1, max_length=100)
    device_id: str = Field(min_length=1, max_length=200)
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn

    @model_validator(mode="after")
    def _distinct_capture_keys(self) -> Self:
        keys = [span.capture_key for span in self.batch.spans]
        if len(keys) != len(set(keys)):
            raise ValueError("captureKey must be unique within one activity batch")
        return self


# ---- the player descriptor and the Lectern ----


class ChapterOut(CamelOut):
    title: str = Field(min_length=1, max_length=300)
    start_ms: _Int32
    end_ms: Presence[_Int32]


class PlayerDescriptor(CamelOut):
    """What a device needs to play one episode; ``position_ms`` is the server's resume point."""

    media_id: UUID
    title: str = Field(max_length=300)
    subtitle: Presence[str]
    artwork_url: Presence[str]
    stream_url: str
    position_ms: _Int32
    duration_ms: Presence[_Int32]
    reset_epoch: _Int32
    consumption_override_revision: Presence[_Int32]
    playback_rate: PlaybackRate
    podcast_id: Presence[UUID]
    pause_shortening_mode: Presence[PauseShorteningMode]
    chapters: list[ChapterOut] = Field(max_length=100)


class FooterAudioActivation(_Tagged):
    kind: Literal["FooterAudio"] = "FooterAudio"
    descriptor: PlayerDescriptor


class ReadableActivation(_Tagged):
    kind: Literal["Readable"] = "Readable"


class OpenPaneActivation(_Tagged):
    kind: Literal["OpenPane"] = "OpenPane"


class LecternItemOut(CamelOut):
    item_id: UUID
    media_summary: MediaSummaryOut
    href: str
    added_at: AwareDatetime
    activation: Annotated[
        FooterAudioActivation | ReadableActivation | OpenPaneActivation,
        Field(discriminator="kind"),
    ]


class LecternSnapshot(CamelOut):
    items: list[LecternItemOut] = Field(max_length=2000)


# ---- Lectern commands ----


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
    item_ids: list[UUID] = Field(max_length=2000)


LecternCommand = Annotated[
    PlaceItemsCommand | RemoveItemCommand | SetOrderCommand, Field(discriminator="kind")
]


class PlacedOutcome(_Tagged):
    kind: Literal["Placed"] = "Placed"
    item_ids: list[UUID]


class RemovedOutcome(_Tagged):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID


class OrderedOutcome(_Tagged):
    kind: Literal["Ordered"] = "Ordered"


LecternOutcome = Annotated[
    PlacedOutcome | RemovedOutcome | OrderedOutcome, Field(discriminator="kind")
]


class LecternResult(CamelOut):
    outcome: LecternOutcome
    lectern: LecternSnapshot


# ---- listening ----


class ListeningIn(CamelIn):
    """One listening sample. An absent rate keeps the stored episode rate; an absent duration
    keeps the stored duration."""

    position_ms: _Int32
    duration_ms: Presence[_Int32]
    episode_playback_rate: Presence[PlaybackRate]
    expected_reset_epoch: _Int32


class PreviewPositionIn(CamelIn):
    position_ms: _Int32
    duration_ms: Presence[_Int32]


# ---- consumption commands ----


class EnsureMediaFinishedCommand(CommandIn):
    kind: Literal["EnsureMediaFinished"]
    media_id: UUID


class DoneCommand(CommandIn):
    """Finish, leave the Lectern and name the next readable row."""

    kind: Literal["Done"]
    media_id: UUID


class SetUnreadCommand(CommandIn):
    kind: Literal["SetUnread"]
    media_id: UUID


class ResetProgressCommand(CommandIn):
    kind: Literal["ResetProgress"]
    media_id: UUID


class UndoRestoreIn(CamelIn):
    """The Lectern row a Done removed: put back with its id and added time."""

    item_id: UUID
    added_at: AwareDatetime
    after: Presence[UUID]


class UndoFinishCommand(CommandIn):
    """Undo the finish ``finish_id`` names (its ``finishId``): the override it replaced and the
    first-completion fact it recorded, as the server stored them, and the row a Done removed."""

    kind: Literal["UndoFinish"]
    media_id: UUID
    finish_id: UUID
    restore: Presence[UndoRestoreIn]


class SettleNaturalEndCommand(CommandIn):
    """Fenced finish of an episode the device heard end; names the next audio row."""

    kind: Literal["SettleNaturalEnd"]
    media_id: UUID
    terminal_listening: ListeningIn
    expected_consumption_override_revision: Presence[_Int32]


ConsumptionCommand = Annotated[
    EnsureMediaFinishedCommand
    | DoneCommand
    | SetUnreadCommand
    | ResetProgressCommand
    | UndoFinishCommand
    | SettleNaturalEndCommand,
    Field(discriminator="kind"),
]


class ListeningPositionOut(CamelOut):
    position_ms: _Int32
    reset_epoch: _Int32
    consumption_override_revision: Presence[_Int32]


class MediaProgressState(CamelOut):
    media_id: UUID
    reader_cursor: ReaderCursorSnapshot
    listening_state: Presence[ListeningPositionOut]


class ConsumptionResult(CamelOut):
    outcome: Literal["Done", "Superseded", "Gone"]
    lectern: LecternSnapshot
    next_item: Presence[LecternItemOut]
    # the finish this command made (EnsureMediaFinished, Done), for UndoFinish
    finish_id: Presence[UUID]
    progress_state: Presence[MediaProgressState]
    library_entries_collection_revision: CollectionRevision
