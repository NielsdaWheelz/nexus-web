"""Discovery targets (sealed provider identities), provider failures and shared adapter helpers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.services.contributor_taxonomy import ContributorRole
from nexus.services.sealed_handles import (
    DiscoveryTargetHandle,
    seal_discovery_target,
    unseal_discovery_target,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.web_paths import media_image_url


class BrowseFailureKind(StrEnum):
    Unavailable = "Unavailable"
    RateLimited = "RateLimited"
    QuotaExhausted = "QuotaExhausted"


@dataclass(frozen=True, slots=True)
class BrowseProviderFailure(Exception):
    kind: BrowseFailureKind
    retry_at: datetime | None = None
    reset_at: datetime | None = None


class BrowseTargetNotFound(Exception):
    """A once-valid external target no longer exists at its provider."""


def is_plain(value: str) -> bool:
    """Trimmed and free of C0, DEL and C1 control characters."""
    return value == value.strip() and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)


def _ref(value: str) -> str:
    if not is_plain(value):
        raise ValueError("Invalid discovery provider ref")
    return value


def _canonical_url(value: str) -> str:
    validate_requested_url(value)
    if normalize_url_for_display(value) != value:
        raise ValueError("Discovery target URL is not canonical")
    return value


_Ref = Annotated[str, Field(strict=True, min_length=1, max_length=512), AfterValidator(_ref)]
_Url = Annotated[
    str, Field(strict=True, min_length=1, max_length=2048), AfterValidator(_canonical_url)
]


class _Target(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True, strict=True)


class ProjectGutenbergEpubTarget(_Target):
    kind: Literal["ProjectGutenbergEpub"] = "ProjectGutenbergEpub"
    ebook_ref: _Ref = Field(alias="ebookRef")


class BraveWebArticleTarget(_Target):
    kind: Literal["BraveWebArticle"] = "BraveWebArticle"
    canonical_url: _Url = Field(alias="canonicalUrl")


class YouTubeVideoTarget(_Target):
    kind: Literal["YouTubeVideo"] = "YouTubeVideo"
    video_ref: _Ref = Field(alias="videoRef")


class PodcastIndexPodcastTarget(_Target):
    kind: Literal["PodcastIndexPodcast"] = "PodcastIndexPodcast"
    podcast_ref: _Ref = Field(alias="podcastRef")


class PodcastIndexEpisodeTarget(_Target):
    kind: Literal["PodcastIndexEpisode"] = "PodcastIndexEpisode"
    podcast_ref: _Ref = Field(alias="podcastRef")
    episode_ref: _Ref = Field(alias="episodeRef")


type DiscoveryTarget = Annotated[
    ProjectGutenbergEpubTarget
    | BraveWebArticleTarget
    | YouTubeVideoTarget
    | PodcastIndexPodcastTarget
    | PodcastIndexEpisodeTarget,
    Field(discriminator="kind"),
]
_TARGETS = TypeAdapter(DiscoveryTarget)


def seal_target(target: DiscoveryTarget) -> DiscoveryTargetHandle:
    """The opaque handle naming one provider item; its payload is canonical JSON."""
    payload = _TARGETS.dump_python(target, mode="json", by_alias=True)
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )
    return seal_discovery_target(canonical.encode("utf-8"))


def unseal_target(handle: str) -> DiscoveryTarget:
    try:
        return _TARGETS.validate_python(json.loads(unseal_discovery_target(handle)), strict=True)
    except (ValueError, TypeError) as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Invalid discovery target"
        ) from exc


def classify(
    exc: ApiError,
    *,
    provider: str,
    quota_reasons: frozenset[str] = frozenset(),
    target_lookup: bool = False,
) -> Exception:
    """A provider call's failure as NotFound, RateLimited, QuotaExhausted or Unavailable;
    anything else is a defect (RuntimeError)."""
    cause = exc.__cause__
    if isinstance(cause, httpx.TimeoutException | httpx.NetworkError):
        return BrowseProviderFailure(BrowseFailureKind.Unavailable)
    if not isinstance(cause, httpx.HTTPStatusError):
        return RuntimeError(f"{provider} returned an invalid response")
    response = cause.response
    status = response.status_code
    if target_lookup and status in (404, 410):
        return BrowseTargetNotFound()
    if status == 429:
        return BrowseProviderFailure(
            BrowseFailureKind.RateLimited, retry_at=retry_at(response.headers.get("retry-after"))
        )
    if status == 403 and quota_reasons:
        try:
            reason = response.json()["error"]["errors"][0]["reason"]
        except (ValueError, TypeError, KeyError, IndexError):
            reason = None
        if reason in quota_reasons:
            return BrowseProviderFailure(BrowseFailureKind.QuotaExhausted)
        return RuntimeError(f"{provider} configuration defect: {reason}")
    if status in (408, 500, 502, 503, 504):
        return BrowseProviderFailure(BrowseFailureKind.Unavailable)
    return RuntimeError(f"{provider} returned unexpected HTTP {status}")


def retry_at(seconds: float | str | None) -> datetime | None:
    """A provider's Retry-After delay (delta-seconds) as an absolute instant."""
    try:
        return (
            None
            if seconds is None
            else datetime.now(UTC) + timedelta(seconds=max(float(seconds), 0.0))
        )
    except ValueError:
        return None


def instant(raw: str) -> datetime:
    """A provider's ISO-8601 instant; a naive or malformed one is a ValueError."""
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("timezone-free provider instant")
    return parsed


def proxied_image(value: str | None) -> str | None:
    return None if value is None else media_image_url(quote(value, safe=""))


def single_credit(name: str | None, role: ContributorRole) -> list[ContributorCreditOut]:
    if name is None:
        return []
    return [
        ContributorCreditOut(
            contributor_handle=None,
            credited_name=name,
            contributor_display_name=name,
            href=None,
            role=role,
            raw_role=None,
            ordinal=None,
        )
    ]


def public_url(value: object) -> str | None:
    """A canonical public URL, or None for anything else."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        validate_requested_url(value.strip())
        return normalize_url_for_display(value.strip())
    except (InvalidRequestError, ValueError):
        return None


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
