"""Immutable episode capture: source presentation, consumption baseline and optional content."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from nexus.schemas.consumption import (
    ChapterOut,
    Closed,
    EpisodeConsumptionObservation,
    PauseShorteningMode,
    PlaybackRate,
)


class EpisodeRenditionOut(Closed):
    title: str
    subtitle: str | None
    podcast_id: UUID | None
    stream_url: str
    artwork_url: str | None
    duration_ms: int | None
    chapters: list[ChapterOut]


class EpisodePlaybackBaselineOut(Closed):
    observation: EpisodeConsumptionObservation
    playback_rate: PlaybackRate
    pause_shortening_mode: PauseShorteningMode | None


class EpisodeContentAbsent(Closed):
    kind: Literal["Absent"]


class EpisodeContentUnavailable(Closed):
    kind: Literal["Unavailable"]
    reason: Literal["TooLarge", "E_MEDIA_NOT_READY"]


class EpisodeShowNotesAvailable(Closed):
    kind: Literal["Available"]
    html: str


class EpisodeTranscriptAvailable(Closed):
    kind: Literal["Available"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_count: int = Field(ge=1, le=8 * 1024 * 1024)
    coverage: Literal["partial", "full"]


class EpisodeDownloadOut(Closed):
    format_version: Literal[1]
    media_id: UUID
    captured_at: datetime
    source_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    rendition: EpisodeRenditionOut
    playback_baseline: EpisodePlaybackBaselineOut
    show_notes: Annotated[
        EpisodeContentAbsent | EpisodeShowNotesAvailable | EpisodeContentUnavailable,
        Field(discriminator="kind"),
    ]
    transcript: Annotated[
        EpisodeContentAbsent | EpisodeTranscriptAvailable | EpisodeContentUnavailable,
        Field(discriminator="kind"),
    ]
