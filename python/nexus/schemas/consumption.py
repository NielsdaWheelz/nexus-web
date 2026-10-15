"""Consumption wire: the closed base, activity capture, the Lectern, the player descriptor,
listening writes and the consumption commands. Absence is null.

The capture body is posted by the web and the Android app; the device is the header the bff
stamps, never a body field.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.reader import ReaderCursorSnapshot

ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
PauseShorteningMode = Literal["Off", "Natural"]
PlaybackRate = Annotated[float, Field(strict=True, ge=0.5, le=3)]
_Int32 = Annotated[int, Field(ge=0, le=2_147_483_647)]
_Position = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
_Progress = Annotated[float, Field(ge=0, le=1)]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Tagged(Closed):
    """An output variant whose defaulted ``kind`` the generated wire still marks required."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class CommandIn(Closed):
    """A write that replays by its ``client_mutation_id``."""

    client_mutation_id: UUID


# ---- activity capture ----


class _SpanIn(Closed):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: int = Field(gt=0, le=30_000)

    @model_validator(mode="after")
    def _paired(self) -> Self:
        """Each ``*_start`` measurement is present exactly when its ``*_end`` is."""
        for start in (name for name in type(self).model_fields if "_start" in name):
            end = start.replace("_start", "_end")
            if (getattr(self, start) is None) != (getattr(self, end) is None):
                raise ValueError(f"{start} and {end} must have the same presence")
        return self


class ViewingActivitySpanIn(_SpanIn):
    pass


class ReadingActivitySpanIn(_SpanIn):
    progress_start: _Progress | None
    progress_end: _Progress | None
    word_start: _Position | None
    word_end: _Position | None


class ListeningActivitySpanIn(_SpanIn):
    progress_start: _Progress | None
    progress_end: _Progress | None
    media_position_start_ms: _Position | None
    media_position_end_ms: _Position | None


class ReadingActivityBatchIn(Closed):
    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(Closed):
    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(Closed):
    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]


class ActivityRecordIn(Closed):
    media_ref: str = Field(min_length=1, max_length=100)
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn

    @model_validator(mode="after")
    def _distinct_capture_keys(self) -> Self:
        keys = [span.capture_key for span in self.batch.spans]
        if len(keys) != len(set(keys)):
            raise ValueError("capture_key must be unique within one activity batch")
        return self


# ---- the player descriptor and the Lectern ----


class ChapterOut(Closed):
    title: str = Field(min_length=1, max_length=300)
    start_ms: _Int32
    end_ms: _Int32 | None


class PlayerDescriptor(Closed):
    """What a device needs to play one episode; ``position_ms`` is the server's resume point."""

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


class FooterAudioActivation(_Tagged):
    kind: Literal["FooterAudio"] = "FooterAudio"
    descriptor: PlayerDescriptor


class ReadableActivation(_Tagged):
    kind: Literal["Readable"] = "Readable"


class OpenPaneActivation(_Tagged):
    kind: Literal["OpenPane"] = "OpenPane"


class LecternItemOut(Closed):
    item_id: UUID
    media_summary: MediaSummaryOut
    href: str
    added_at: AwareDatetime
    activation: Annotated[
        FooterAudioActivation | ReadableActivation | OpenPaneActivation,
        Field(discriminator="kind"),
    ]


class LecternSnapshot(Closed):
    items: list[LecternItemOut] = Field(max_length=2000)
    at_capacity: bool


# ---- Lectern commands ----


class FirstPlacement(Closed):
    kind: Literal["First"]


class AfterPlacement(Closed):
    kind: Literal["After"]
    item_id: UUID


Placement = Annotated[FirstPlacement | AfterPlacement, Field(discriminator="kind")]


class EnsureItemCommand(CommandIn):
    kind: Literal["EnsureItem"]
    media_id: UUID


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
    EnsureItemCommand | PlaceItemsCommand | RemoveItemCommand | SetOrderCommand,
    Field(discriminator="kind"),
]


class EnsuredOutcome(_Tagged):
    kind: Literal["Ensured"] = "Ensured"


class PlacedOutcome(_Tagged):
    kind: Literal["Placed"] = "Placed"
    item_ids: list[UUID]


class RemovedOutcome(_Tagged):
    kind: Literal["Removed"] = "Removed"
    item_id: UUID


class OrderedOutcome(_Tagged):
    kind: Literal["Ordered"] = "Ordered"


LecternOutcome = Annotated[
    EnsuredOutcome | PlacedOutcome | RemovedOutcome | OrderedOutcome, Field(discriminator="kind")
]


class LecternResult(Closed):
    outcome: LecternOutcome
    lectern: LecternSnapshot


# ---- listening ----


class ListeningIn(Closed):
    """One listening sample. An absent rate keeps the stored episode rate; an absent duration
    keeps the stored duration."""

    position_ms: _Int32
    duration_ms: _Int32 | None
    episode_playback_rate: PlaybackRate | None
    expected_reset_epoch: _Int32


class PreviewPositionIn(Closed):
    position_ms: _Int32
    duration_ms: _Int32 | None


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


class UndoRestoreIn(Closed):
    """The Lectern row a Done removed: put back with its id and added time."""

    item_id: UUID
    added_at: AwareDatetime
    after: UUID | None


class UndoFinishCommand(CommandIn):
    """Undo the finish ``finish_id`` names: the override it replaced and the
    first-completion fact it recorded, as the server stored them, and the row a Done removed."""

    kind: Literal["UndoFinish"]
    media_id: UUID
    finish_id: UUID
    restore: UndoRestoreIn | None


class SettleNaturalEndCommand(CommandIn):
    """Fenced finish of an episode the device heard end; names the next audio row."""

    kind: Literal["SettleNaturalEnd"]
    media_id: UUID
    terminal_listening: ListeningIn
    expected_consumption_override_revision: _Int32 | None


ConsumptionCommand = Annotated[
    EnsureMediaFinishedCommand
    | DoneCommand
    | SetUnreadCommand
    | ResetProgressCommand
    | UndoFinishCommand
    | SettleNaturalEndCommand,
    Field(discriminator="kind"),
]


class ListeningPositionOut(Closed):
    position_ms: _Int32
    reset_epoch: _Int32
    consumption_override_revision: _Int32 | None


class MediaProgressState(Closed):
    media_id: UUID
    reader_cursor: ReaderCursorSnapshot
    listening_state: ListeningPositionOut | None


class ConsumptionResult(Closed):
    outcome: Literal["Done", "Superseded", "Gone"]
    lectern: LecternSnapshot
    next_item: LecternItemOut | None
    # the finish this command made (EnsureMediaFinished, Done), for UndoFinish
    finish_id: UUID | None
    progress_state: MediaProgressState | None
