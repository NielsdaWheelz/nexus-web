"""Podcast-only playback, directory-episode resolution and transcript wire."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.media_summary import MediaProcessingStatus
from nexus.services.sealed_handles import DiscoveryTargetHandle

# The web reads exact key sets, so each model's casing is load-bearing.
_CLOSED = ConfigDict(extra="forbid")

EpisodeState = Literal["all", "unplayed", "in_progress", "played"]
EpisodeSort = Literal["newest", "oldest", "duration_asc", "duration_desc"]


class PodcastResolveRequest(BaseModel):
    target: DiscoveryTargetHandle

    model_config = _CLOSED


class PodcastEpisodeResolveOut(BaseModel):
    podcast_id: UUID
    media_id: UUID
    href: str = Field(min_length=1)

    model_config = _CLOSED


type SettingsVersion = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,18})$", strict=True)]


class PodcastPlaybackSettingsOut(BaseModel):
    id: UUID | None
    podcast_id: UUID
    settings_version: SettingsVersion
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None

    model_config = _CLOSED


class PodcastPlaybackSettingsRequest(BaseModel):
    id: UUID
    expected_settings_version: SettingsVersion
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None

    model_config = _CLOSED


class PodcastEpisodeSelection(BaseModel):
    state: EpisodeState

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptTarget(BaseModel):
    kind: Literal["PodcastEpisodeQuery"]
    podcast_id: UUID
    selection: PodcastEpisodeSelection
    reason: Literal["search", "highlight", "quote"]

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptForecastOut(BaseModel):
    eligible_count: int = Field(ge=0)
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptRequest(BaseModel):
    target: PodcastEpisodeQueryTranscriptTarget
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptRequestOut(BaseModel):
    matched_count: int = Field(ge=0)
    queued_count: int = Field(ge=0)

    model_config = _CLOSED


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
TranscriptCoverage = Literal["none", "partial", "full"]


TranscriptRequestReason = Literal[
    "episode_open", "search", "highlight", "quote", "background_warming", "operator_requeue"
]


class TranscriptRequestRequest(_Strict):
    reason: TranscriptRequestReason = "episode_open"


class TranscriptRequestOut(BaseModel):
    media_id: str
    processing_status: MediaProcessingStatus
    transcript_state: TranscriptState
    transcript_coverage: TranscriptCoverage
    request_reason: TranscriptRequestReason
    request_enqueued: bool
