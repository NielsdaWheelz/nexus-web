"""Strict Browse and non-mutating Preview wire contract."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.services.browse.models import (
    BrowseKind,
    BrowsePreviewQuery,
    BrowseQuery,
    BrowseSort,
    BrowseSource,
)
from nexus.services.sealed_handles import DiscoveryTargetHandle

_OUT = ConfigDict(extra="forbid", populate_by_name=True, strict=True)
_LIMIT = re.compile(r"[1-9][0-9]*\Z", re.ASCII)
_CURSOR = re.compile(r"[A-Za-z0-9_-]+\Z", re.ASCII)
_TARGET_ADAPTER = TypeAdapter(DiscoveryTargetHandle)
_BROWSE_KEYS = frozenset({"q", "kind", "source", "sort", "limit", "cursor"})
_PREVIEW_KEYS = frozenset({"target", "limit", "cursor"})
_VALID_SOURCES = {
    BrowseKind.Pdf: frozenset({BrowseSource.Nexus}),
    BrowseKind.Epub: frozenset({BrowseSource.Nexus, BrowseSource.ProjectGutenberg}),
    BrowseKind.WebArticle: frozenset({BrowseSource.Nexus, BrowseSource.Brave}),
    BrowseKind.Video: frozenset({BrowseSource.Nexus, BrowseSource.YouTube}),
    BrowseKind.Podcast: frozenset({BrowseSource.PodcastIndex}),
}


def _invalid_browse_query() -> InvalidRequestError:
    return InvalidRequestError(
        ApiErrorCode.E_INVALID_BROWSE_QUERY,
        "Invalid Browse query",
    )


def _invalid_preview_query() -> InvalidRequestError:
    return InvalidRequestError(
        ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
        "Invalid discovery target",
    )


def _exact_parameters(
    query_items: Iterable[tuple[str, str]],
    *,
    allowed: frozenset[str],
    invalid: InvalidRequestError,
) -> dict[str, str]:
    values: dict[str, str] = {}
    for key, value in query_items:
        if key not in allowed or key in values:
            raise invalid
        values[key] = value
    return values


def _parse_limit(raw: str, *, invalid: InvalidRequestError) -> int:
    if not _LIMIT.fullmatch(raw):
        raise invalid
    limit = int(raw)
    if limit > 20:
        raise invalid
    return limit


def _parse_cursor(raw: str | None, *, invalid: InvalidRequestError) -> str | None:
    if raw is None:
        return None
    if len(raw) > 16_384 or not _CURSOR.fullmatch(raw):
        raise invalid
    return raw


def parse_browse_query(query_items: Iterable[tuple[str, str]]) -> BrowseQuery:
    invalid = _invalid_browse_query()
    values = _exact_parameters(query_items, allowed=_BROWSE_KEYS, invalid=invalid)
    if not {"q", "kind", "source", "limit"} <= values.keys():
        raise invalid
    query = values["q"]
    if (
        query != query.strip()
        or query != unicodedata.normalize("NFC", query)
        or not 1 <= len(query) <= 200
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in query)
    ):
        raise invalid
    try:
        kind = BrowseKind(values["kind"])
        source = BrowseSource(values["source"])
        sort = BrowseSort(values["sort"]) if "sort" in values else None
    except ValueError as exc:
        raise invalid from exc
    if source not in _VALID_SOURCES[kind]:
        raise invalid
    if sort is not None and not (
        kind is BrowseKind.Video and source is BrowseSource.YouTube and sort is BrowseSort.Newest
    ):
        raise invalid
    return BrowseQuery(
        query=query,
        kind=kind,
        source=source,
        sort=sort,
        limit=_parse_limit(values["limit"], invalid=invalid),
        cursor=_parse_cursor(values.get("cursor"), invalid=invalid),
    )


def parse_browse_preview_query(
    query_items: Iterable[tuple[str, str]],
) -> BrowsePreviewQuery:
    invalid = _invalid_preview_query()
    values = _exact_parameters(query_items, allowed=_PREVIEW_KEYS, invalid=invalid)
    if not {"target", "limit"} <= values.keys():
        raise invalid
    try:
        target = _TARGET_ADAPTER.validate_python(values["target"], strict=True)
    except ValidationError as exc:
        raise invalid from exc
    return BrowsePreviewQuery(
        target=target,
        limit=_parse_limit(values["limit"], invalid=invalid),
        cursor=_parse_cursor(values.get("cursor"), invalid=invalid),
    )


class InNexusResolution(BaseModel):
    kind: Literal["InNexus"] = "InNexus"
    href: str

    model_config = _OUT


class PreviewResolution(BaseModel):
    kind: Literal["Preview"] = "Preview"
    target: DiscoveryTargetHandle

    model_config = _OUT


class ExternalOnlyResolution(BaseModel):
    kind: Literal["ExternalOnly"] = "ExternalOnly"
    source_href: str = Field(serialization_alias="sourceHref")

    model_config = _OUT


type BrowseResolution = Annotated[
    InNexusResolution | PreviewResolution | ExternalOnlyResolution,
    Field(discriminator="kind"),
]
type PreviewPageResolution = Annotated[
    InNexusResolution | PreviewResolution,
    Field(discriminator="kind"),
]


class PdfFacts(BaseModel):
    page_count: Presence[int] = Field(serialization_alias="pageCount")

    model_config = _OUT


class EpubFacts(BaseModel):
    ebook_ref: Presence[str] = Field(serialization_alias="ebookRef")

    model_config = _OUT


class WebArticleFacts(BaseModel):
    site_name: Presence[str] = Field(serialization_alias="siteName")

    model_config = _OUT


class VideoFacts(BaseModel):
    video_ref: Presence[str] = Field(serialization_alias="videoRef")
    channel_title: Presence[str] = Field(serialization_alias="channelTitle")

    model_config = _OUT


class PodcastFacts(BaseModel):
    podcast_ref: str = Field(serialization_alias="podcastRef")

    model_config = _OUT


class _Candidate(BaseModel):
    source: BrowseSource
    resolution: BrowseResolution
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]

    model_config = _OUT


class PdfCandidate(_Candidate):
    kind: Literal[BrowseKind.Pdf] = BrowseKind.Pdf
    kind_facts: PdfFacts = Field(serialization_alias="kindFacts")


class EpubCandidate(_Candidate):
    kind: Literal[BrowseKind.Epub] = BrowseKind.Epub
    kind_facts: EpubFacts = Field(serialization_alias="kindFacts")


class WebArticleCandidate(_Candidate):
    kind: Literal[BrowseKind.WebArticle] = BrowseKind.WebArticle
    kind_facts: WebArticleFacts = Field(serialization_alias="kindFacts")


class VideoCandidate(_Candidate):
    kind: Literal[BrowseKind.Video] = BrowseKind.Video
    kind_facts: VideoFacts = Field(serialization_alias="kindFacts")


class PodcastCandidate(_Candidate):
    kind: Literal[BrowseKind.Podcast] = BrowseKind.Podcast
    kind_facts: PodcastFacts = Field(serialization_alias="kindFacts")


type BrowseCandidate = Annotated[
    PdfCandidate | EpubCandidate | WebArticleCandidate | VideoCandidate | PodcastCandidate,
    Field(discriminator="kind"),
]


class BrowsePage(BaseModel):
    query: str
    kind: BrowseKind
    source: BrowseSource
    sort: Presence[BrowseSort]
    items: list[BrowseCandidate]
    next_cursor: Presence[str] = Field(serialization_alias="nextCursor")

    model_config = _OUT


class EpubPreviewFacts(BaseModel):
    ebook_ref: str = Field(serialization_alias="ebookRef")
    import_href: str = Field(serialization_alias="importHref")

    model_config = _OUT


class WebArticlePreviewFacts(BaseModel):
    canonical_url: str = Field(serialization_alias="canonicalUrl")
    site_name: Presence[str] = Field(serialization_alias="siteName")

    model_config = _OUT


class VideoPreviewFacts(BaseModel):
    video_ref: str = Field(serialization_alias="videoRef")
    channel_title: Presence[str] = Field(serialization_alias="channelTitle")
    embed_href: str = Field(serialization_alias="embedHref")

    model_config = _OUT


class PodcastPreviewFacts(BaseModel):
    podcast_ref: str = Field(serialization_alias="podcastRef")
    feed_href: str = Field(serialization_alias="feedHref")
    website_href: Presence[str] = Field(serialization_alias="websiteHref")

    model_config = _OUT


class EpisodePreviewFacts(BaseModel):
    podcast_ref: str = Field(serialization_alias="podcastRef")
    episode_ref: str = Field(serialization_alias="episodeRef")
    podcast_title: str = Field(serialization_alias="podcastTitle")
    audio_href: str = Field(serialization_alias="audioHref")
    duration_seconds: Presence[int] = Field(serialization_alias="durationSeconds")

    model_config = _OUT


class PodcastPreviewEpisode(BaseModel):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]
    kind_facts: EpisodePreviewFacts = Field(serialization_alias="kindFacts")

    model_config = _OUT


class PodcastPreviewEpisodePage(BaseModel):
    items: list[PodcastPreviewEpisode]
    next_cursor: Presence[str] = Field(serialization_alias="nextCursor")

    model_config = _OUT


class _Preview(BaseModel):
    target: DiscoveryTargetHandle
    title: str
    contributors: list[ContributorCreditOut]
    description: Presence[str]
    published_at: Presence[datetime] = Field(serialization_alias="publishedAt")
    image: Presence[str]
    source_href: str = Field(serialization_alias="sourceHref")
    resolution: PreviewPageResolution

    model_config = _OUT


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


class UnavailableFailure(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"

    model_config = _OUT


class RateLimitedFailure(BaseModel):
    kind: Literal["RateLimited"] = "RateLimited"
    retry_at: Presence[datetime] = Field(serialization_alias="retryAt")

    model_config = _OUT


class QuotaExhaustedFailure(BaseModel):
    kind: Literal["QuotaExhausted"] = "QuotaExhausted"
    reset_at: Presence[datetime] = Field(serialization_alias="resetAt")

    model_config = _OUT
