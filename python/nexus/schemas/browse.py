"""Browse and non-mutating Preview wire contract, with its enums."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence
from nexus.services.sealed_handles import DiscoveryTargetHandle


class _Out(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
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
    action_subject_ref: str = Field(serialization_alias="actionSubjectRef")
    media_summary: MediaSummaryOut = Field(serialization_alias="mediaSummary")


class InNexusPodcastResolution(_Out):
    kind: Literal["InNexusPodcast"] = "InNexusPodcast"
    href: str
    action_subject_ref: str = Field(serialization_alias="actionSubjectRef")


class PreviewResolution(_Out):
    kind: Literal["Preview"] = "Preview"
    target: DiscoveryTargetHandle


type BrowseResolution = Annotated[
    InNexusMediaResolution | InNexusPodcastResolution | PreviewResolution,
    Field(discriminator="kind"),
]


class EpubFacts(_Out):
    ebook_ref: Presence[str] = Field(serialization_alias="ebookRef")


class WebArticleFacts(_Out):
    site_name: Presence[str] = Field(serialization_alias="siteName")


class VideoFacts(_Out):
    video_ref: Presence[str] = Field(serialization_alias="videoRef")
    channel_title: Presence[str] = Field(serialization_alias="channelTitle")


class PodcastFacts(_Out):
    podcast_ref: str = Field(serialization_alias="podcastRef")


class _Candidate[Source: BrowseSource](_Out):
    source: Source
    resolution: BrowseResolution
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]


class EpubCandidate(_Candidate[Literal[BrowseSource.ProjectGutenberg]]):
    source: Literal[BrowseSource.ProjectGutenberg] = BrowseSource.ProjectGutenberg
    kind: Literal[BrowseKind.Epub] = BrowseKind.Epub
    kind_facts: EpubFacts = Field(serialization_alias="kindFacts")


class WebArticleCandidate(_Candidate[Literal[BrowseSource.Brave]]):
    source: Literal[BrowseSource.Brave] = BrowseSource.Brave
    kind: Literal[BrowseKind.WebArticle] = BrowseKind.WebArticle
    kind_facts: WebArticleFacts = Field(serialization_alias="kindFacts")


class VideoCandidate(_Candidate[Literal[BrowseSource.YouTube]]):
    source: Literal[BrowseSource.YouTube] = BrowseSource.YouTube
    kind: Literal[BrowseKind.Video] = BrowseKind.Video
    kind_facts: VideoFacts = Field(serialization_alias="kindFacts")


class PodcastCandidate(_Candidate[Literal[BrowseSource.PodcastIndex]]):
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind: Literal[BrowseKind.Podcast] = BrowseKind.Podcast
    kind_facts: PodcastFacts = Field(serialization_alias="kindFacts")


class OwnedMediaCandidate(_Out):
    kind: Literal["OwnedMedia"] = "OwnedMedia"
    source: Literal[BrowseSource.Nexus] = BrowseSource.Nexus
    resolution: InNexusMediaResolution
    description: Presence[str]
    image: Presence[str]


type BrowseCandidate = Annotated[
    OwnedMediaCandidate | EpubCandidate | WebArticleCandidate | VideoCandidate | PodcastCandidate,
    Field(discriminator="kind"),
]


class BrowsePage(_Out):
    query: str
    kind: BrowseKind
    source: BrowseSource
    sort: Presence[BrowseSort]
    items: list[BrowseCandidate]
    next_cursor: Presence[str] = Field(serialization_alias="nextCursor")


class EpubPreviewFacts(_Out):
    ebook_ref: str = Field(serialization_alias="ebookRef")
    import_href: str = Field(serialization_alias="importHref")


class WebArticlePreviewFacts(_Out):
    canonical_url: str = Field(serialization_alias="canonicalUrl")
    site_name: Presence[str] = Field(serialization_alias="siteName")


class VideoPreviewFacts(_Out):
    video_ref: str = Field(serialization_alias="videoRef")
    channel_title: Presence[str] = Field(serialization_alias="channelTitle")
    embed_href: str = Field(serialization_alias="embedHref")


class PodcastPreviewFacts(_Out):
    podcast_ref: str = Field(serialization_alias="podcastRef")
    feed_href: str = Field(serialization_alias="feedHref")
    website_href: Presence[str] = Field(serialization_alias="websiteHref")


class EpisodePreviewFacts(_Out):
    podcast_ref: str = Field(serialization_alias="podcastRef")
    episode_ref: str = Field(serialization_alias="episodeRef")
    podcast_title: str = Field(serialization_alias="podcastTitle")
    audio_href: str = Field(serialization_alias="audioHref")
    duration_seconds: Presence[int] = Field(serialization_alias="durationSeconds")


class PodcastPreviewEpisode(_Out):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]
    kind_facts: EpisodePreviewFacts = Field(serialization_alias="kindFacts")


class PodcastPreviewEpisodePage(_Out):
    items: list[PodcastPreviewEpisode]
    next_cursor: Presence[str] = Field(serialization_alias="nextCursor")


class _Preview(_Out):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]
    source_href: str = Field(serialization_alias="sourceHref")
    resolution: BrowseResolution


class EpubPreview(_Preview):
    kind: Literal["Epub"] = "Epub"
    source: Literal[BrowseSource.ProjectGutenberg] = BrowseSource.ProjectGutenberg
    kind_facts: EpubPreviewFacts = Field(serialization_alias="kindFacts")


class WebArticlePreview(_Preview):
    kind: Literal["WebArticle"] = "WebArticle"
    source: Literal[BrowseSource.Brave] = BrowseSource.Brave
    kind_facts: WebArticlePreviewFacts = Field(serialization_alias="kindFacts")


class VideoPreview(_Preview):
    kind: Literal["Video"] = "Video"
    source: Literal[BrowseSource.YouTube] = BrowseSource.YouTube
    kind_facts: VideoPreviewFacts = Field(serialization_alias="kindFacts")


class PodcastPreview(_Preview):
    kind: Literal["Podcast"] = "Podcast"
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind_facts: PodcastPreviewFacts = Field(serialization_alias="kindFacts")
    episodes: PodcastPreviewEpisodePage


class EpisodePreview(_Preview):
    kind: Literal["Episode"] = "Episode"
    source: Literal[BrowseSource.PodcastIndex] = BrowseSource.PodcastIndex
    kind_facts: EpisodePreviewFacts = Field(serialization_alias="kindFacts")


type BrowsePreview = Annotated[
    EpubPreview | WebArticlePreview | VideoPreview | PodcastPreview | EpisodePreview,
    Field(discriminator="kind"),
]
