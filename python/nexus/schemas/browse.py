"""Browse and non-mutating Preview wire contract, with its enums."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.sealed_handles import DiscoveryTargetHandle


class _Out(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_serialization_defaults_required=True,
    )


class BrowseKind(StrEnum):
    Pdf = "Pdf"
    Epub = "Epub"
    WebArticle = "WebArticle"
    Video = "Video"
    Podcast = "Podcast"


class BrowseSource(StrEnum):
    Nexus = "Nexus"
    ProjectGutenberg = "ProjectGutenberg"
    Brave = "Brave"
    YouTube = "YouTube"
    PodcastIndex = "PodcastIndex"


class BrowseSort(StrEnum):
    Relevance = "Relevance"
    Newest = "Newest"


class BrowseQuery(BaseModel):
    """``GET /browse`` query parameters; unknown keys are refused."""

    q: str = Field(min_length=1, max_length=200)
    kind: BrowseKind
    source: BrowseSource
    limit: int = Field(ge=1, le=20)
    sort: BrowseSort | None = None
    cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class BrowsePreviewQuery(BaseModel):
    """``GET /browse/preview`` query parameters; ``cursor`` pages a podcast's episodes."""

    target: str
    limit: int = Field(ge=1, le=20)
    cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class InNexusMediaResolution(_Out):
    kind: Literal["InNexusMedia"] = "InNexusMedia"
    href: str
    action_ref: str
    media_summary: MediaSummaryOut


class InNexusPodcastResolution(_Out):
    kind: Literal["InNexusPodcast"] = "InNexusPodcast"
    href: str
    action_ref: str


class PreviewResolution(_Out):
    kind: Literal["Preview"] = "Preview"
    target: DiscoveryTargetHandle


type BrowseResolution = Annotated[
    InNexusMediaResolution | InNexusPodcastResolution | PreviewResolution,
    Field(discriminator="kind"),
]


class EpubFacts(_Out):
    ebook_ref: str | None


class WebArticleFacts(_Out):
    site_name: str | None


class VideoFacts(_Out):
    video_ref: str | None
    channel_title: str | None


class PodcastFacts(_Out):
    podcast_ref: str


class _Candidate[Source: BrowseSource](_Out):
    source: Source
    resolution: BrowseResolution
    title: str
    contributors: list[ContributorCreditOut]
    description: str | None
    published_at: datetime | None
    image: str | None


class EpubCandidate(_Candidate[Literal[BrowseSource.ProjectGutenberg]]):
    source: Literal[BrowseSource.ProjectGutenberg] = BrowseSource.ProjectGutenberg
    kind: Literal[BrowseKind.Epub] = BrowseKind.Epub
    kind_facts: EpubFacts


class WebArticleCandidate(_Candidate[Literal[BrowseSource.Brave]]):
    source: Literal[BrowseSource.Brave] = BrowseSource.Brave
    kind: Literal[BrowseKind.WebArticle] = BrowseKind.WebArticle
    kind_facts: WebArticleFacts


class VideoCandidate(_Candidate[Literal[BrowseSource.YouTube]]):
    source: Literal[BrowseSource.YouTube] = BrowseSource.YouTube
    kind: Literal[BrowseKind.Video] = BrowseKind.Video
    kind_facts: VideoFacts


class PodcastCandidate(_Candidate[Literal[BrowseSource.PodcastIndex]]):
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind: Literal[BrowseKind.Podcast] = BrowseKind.Podcast
    kind_facts: PodcastFacts


class OwnedMediaCandidate(_Out):
    kind: Literal["OwnedMedia"] = "OwnedMedia"
    source: Literal[BrowseSource.Nexus] = BrowseSource.Nexus
    resolution: InNexusMediaResolution
    description: str | None
    image: str | None


type BrowseCandidate = Annotated[
    OwnedMediaCandidate | EpubCandidate | WebArticleCandidate | VideoCandidate | PodcastCandidate,
    Field(discriminator="kind"),
]


class BrowsePage(_Out):
    query: str
    kind: BrowseKind
    source: BrowseSource
    sort: BrowseSort | None
    items: list[BrowseCandidate]
    next_cursor: str | None


class EpubPreviewFacts(_Out):
    ebook_ref: str
    import_href: str


class WebArticlePreviewFacts(_Out):
    canonical_url: str
    site_name: str | None


class VideoPreviewFacts(_Out):
    video_ref: str
    channel_title: str | None
    embed_href: str


class PodcastPreviewFacts(_Out):
    podcast_ref: str
    feed_href: str
    website_href: str | None


class EpisodePreviewFacts(_Out):
    podcast_ref: str
    episode_ref: str
    podcast_title: str
    audio_href: str
    duration_seconds: int | None


class PodcastPreviewEpisode(_Out):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: str | None
    published_at: datetime | None
    image: str | None
    kind_facts: EpisodePreviewFacts


class PodcastPreviewEpisodePage(_Out):
    items: list[PodcastPreviewEpisode]
    next_cursor: str | None


class _Preview(_Out):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: str | None
    published_at: datetime | None
    image: str | None
    source_href: str
    resolution: BrowseResolution


class EpubPreview(_Preview):
    kind: Literal["Epub"] = "Epub"
    source: Literal[BrowseSource.ProjectGutenberg] = BrowseSource.ProjectGutenberg
    kind_facts: EpubPreviewFacts


class WebArticlePreview(_Preview):
    kind: Literal["WebArticle"] = "WebArticle"
    source: Literal[BrowseSource.Brave] = BrowseSource.Brave
    kind_facts: WebArticlePreviewFacts


class VideoPreview(_Preview):
    kind: Literal["Video"] = "Video"
    source: Literal[BrowseSource.YouTube] = BrowseSource.YouTube
    kind_facts: VideoPreviewFacts


class PodcastPreview(_Preview):
    kind: Literal["Podcast"] = "Podcast"
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind_facts: PodcastPreviewFacts
    episodes: PodcastPreviewEpisodePage


class EpisodePreview(_Preview):
    kind: Literal["Episode"] = "Episode"
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind_facts: EpisodePreviewFacts


type BrowsePreview = Annotated[
    EpubPreview | WebArticlePreview | VideoPreview | PodcastPreview | EpisodePreview,
    Field(discriminator="kind"),
]
