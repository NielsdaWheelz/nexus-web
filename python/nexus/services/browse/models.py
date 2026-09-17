"""Closed Browse domain types and discovery-target identity."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.contributors import ContributorCreditOut, ContributorRole
from nexus.services.sealed_handles import (
    DiscoveryTargetHandle,
    seal_discovery_target,
    unseal_discovery_target,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.web_paths import media_image_url


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


class BrowseSectionFailureKind(StrEnum):
    Unavailable = "Unavailable"
    RateLimited = "RateLimited"
    QuotaExhausted = "QuotaExhausted"


@dataclass(frozen=True, slots=True)
class BrowseQuery:
    query: str
    kind: BrowseKind
    source: BrowseSource
    sort: BrowseSort | None
    limit: int
    cursor: str | None


@dataclass(frozen=True, slots=True)
class BrowsePreviewQuery:
    target: DiscoveryTargetHandle
    limit: int
    cursor: str | None


@dataclass(frozen=True, slots=True)
class BrowseProviderFailure(Exception):
    kind: BrowseSectionFailureKind
    retry_at: datetime | None = None
    reset_at: datetime | None = None


class BrowseTargetNotFound(Exception):
    """A once-valid external target no longer exists at its provider."""


_TARGET_CONFIG = ConfigDict(
    extra="forbid",
    frozen=True,
    populate_by_name=True,
    strict=True,
)
_REF = Annotated[str, Field(strict=True, min_length=1, max_length=512)]
_URL = Annotated[str, Field(strict=True, min_length=1, max_length=2048)]


def _validate_ref(value: str) -> str:
    if value != value.strip() or any(
        ord(character) < 32 or 127 <= ord(character) <= 159 for character in value
    ):
        raise ValueError("Invalid discovery provider ref")
    return value


def _validate_canonical_public_url(value: str) -> str:
    validate_requested_url(value)
    if normalize_url_for_display(value) != value:
        raise ValueError("Discovery target URL is not canonical")
    return value


class ProjectGutenbergEpubTarget(BaseModel):
    kind: Literal["ProjectGutenbergEpub"] = "ProjectGutenbergEpub"
    ebook_ref: _REF = Field(alias="ebookRef")

    model_config = _TARGET_CONFIG

    _ref = field_validator("ebook_ref")(_validate_ref)


class BraveWebArticleTarget(BaseModel):
    kind: Literal["BraveWebArticle"] = "BraveWebArticle"
    canonical_url: _URL = Field(alias="canonicalUrl")

    model_config = _TARGET_CONFIG

    _url = field_validator("canonical_url")(_validate_canonical_public_url)


class YouTubeVideoTarget(BaseModel):
    kind: Literal["YouTubeVideo"] = "YouTubeVideo"
    video_ref: _REF = Field(alias="videoRef")

    model_config = _TARGET_CONFIG

    _ref = field_validator("video_ref")(_validate_ref)


class PodcastIndexPodcastTarget(BaseModel):
    kind: Literal["PodcastIndexPodcast"] = "PodcastIndexPodcast"
    podcast_ref: _REF = Field(alias="podcastRef")

    model_config = _TARGET_CONFIG

    _ref = field_validator("podcast_ref")(_validate_ref)


class PodcastIndexEpisodeTarget(BaseModel):
    kind: Literal["PodcastIndexEpisode"] = "PodcastIndexEpisode"
    podcast_ref: _REF = Field(alias="podcastRef")
    episode_ref: _REF = Field(alias="episodeRef")

    model_config = _TARGET_CONFIG

    _refs = field_validator("podcast_ref", "episode_ref")(_validate_ref)


type DiscoveryTarget = Annotated[
    ProjectGutenbergEpubTarget
    | BraveWebArticleTarget
    | YouTubeVideoTarget
    | PodcastIndexPodcastTarget
    | PodcastIndexEpisodeTarget,
    Field(discriminator="kind"),
]

_DISCOVERY_TARGET_ADAPTER = TypeAdapter(DiscoveryTarget)


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def seal_target(target: DiscoveryTarget) -> DiscoveryTargetHandle:
    payload = _canonical_json(
        _DISCOVERY_TARGET_ADAPTER.dump_python(target, mode="json", by_alias=True)
    )
    return seal_discovery_target(payload)


def unseal_target(handle: str) -> DiscoveryTarget:
    payload = unseal_discovery_target(handle)
    try:
        return _DISCOVERY_TARGET_ADAPTER.validate_python(json.loads(payload), strict=True)
    except (ValueError, TypeError) as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
            "Invalid discovery target",
        ) from exc


def gutenberg_target(ebook_ref: str) -> ProjectGutenbergEpubTarget:
    return ProjectGutenbergEpubTarget(ebookRef=ebook_ref)


def brave_target(canonical_url: str) -> BraveWebArticleTarget:
    return BraveWebArticleTarget(canonicalUrl=canonical_url)


def youtube_target(video_ref: str) -> YouTubeVideoTarget:
    return YouTubeVideoTarget(videoRef=video_ref)


def podcast_target(podcast_ref: str) -> PodcastIndexPodcastTarget:
    return PodcastIndexPodcastTarget(podcastRef=podcast_ref)


def episode_target(
    podcast_ref: str,
    episode_ref: str,
) -> PodcastIndexEpisodeTarget:
    return PodcastIndexEpisodeTarget(
        podcastRef=podcast_ref,
        episodeRef=episode_ref,
    )


def retry_at_from_header(raw: str | None) -> datetime | None:
    """Project a provider's ``Retry-After`` delta-seconds header into an absolute instant."""
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return datetime.now(UTC) + timedelta(seconds=max(seconds, 0.0))


def provider_instant(raw: str, *, provider: str) -> datetime:
    """Parse a provider's ISO-8601 publication instant; a naive or malformed one is a defect."""
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError(f"{provider} returned an invalid publication instant") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError(f"{provider} returned a timezone-free publication instant")
    return parsed


def proxied_image(value: str | None) -> str | None:
    return None if value is None else media_image_url(quote(value, safe=""))


def single_credit(name: str | None, role: ContributorRole) -> list[ContributorCreditOut]:
    if name is None:
        return []
    return [
        ContributorCreditOut(
            credited_name=name,
            contributor_display_name=name,
            role=role,
        )
    ]


@dataclass(frozen=True, slots=True)
class ResolvedPodcast:
    podcast_ref: str
    title: str
    author: str | None
    feed_url: str
    website_url: str | None
    image_url: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class ResolvedEpisode:
    podcast_ref: str
    episode_ref: str
    title: str
    description: str | None
    audio_url: str
    guid: str | None
    published_at: datetime | None
    duration_seconds: int | None
    podcast: ResolvedPodcast
