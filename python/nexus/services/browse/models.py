"""Closed Browse domain types and discovery-target identity."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import Absent, Presence, Present, absent, present
from nexus.services.sealed_handles import (
    DiscoveryTargetHandle,
    seal_discovery_target,
    unseal_discovery_target,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url


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


class BraveResultRef(BaseModel):
    value: _REF

    model_config = _TARGET_CONFIG

    _ref = field_validator("value")(_validate_ref)


class BraveWebArticleTarget(BaseModel):
    kind: Literal["BraveWebArticle"] = "BraveWebArticle"
    canonical_url: _URL = Field(alias="canonicalUrl")
    search_provenance: Presence[BraveResultRef] = Field(alias="searchProvenance")

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
_TARGET_KEYS = {
    "ProjectGutenbergEpub": {"kind", "ebookRef"},
    "BraveWebArticle": {"kind", "canonicalUrl", "searchProvenance"},
    "YouTubeVideo": {"kind", "videoRef"},
    "PodcastIndexPodcast": {"kind", "podcastRef"},
    "PodcastIndexEpisode": {"kind", "podcastRef", "episodeRef"},
}


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
        raw = json.loads(
            payload,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
        if (
            not isinstance(raw, dict)
            or not isinstance(raw.get("kind"), str)
            or set(raw) != _TARGET_KEYS.get(raw["kind"])
            or _canonical_json(raw) != payload
        ):
            raise ValueError
        return _DISCOVERY_TARGET_ADAPTER.validate_python(raw, strict=True)
    except (ValueError, TypeError, KeyError) as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
            "Invalid discovery target",
        ) from exc


def gutenberg_target(ebook_ref: str) -> ProjectGutenbergEpubTarget:
    return ProjectGutenbergEpubTarget(ebookRef=ebook_ref)


def brave_target(
    canonical_url: str,
    *,
    result_ref: str | None,
) -> BraveWebArticleTarget:
    provenance: Absent | Present[BraveResultRef]
    provenance = absent() if result_ref is None else present(BraveResultRef(value=result_ref))
    return BraveWebArticleTarget(
        canonicalUrl=canonical_url,
        searchProvenance=provenance,
    )


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
