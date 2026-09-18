"""YouTube Data API Browse and non-mutating Preview adapter."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.browse import (
    BrowseCandidate,
    BrowseSource,
    PreviewResolution,
    VideoCandidate,
    VideoFacts,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import absent, present
from nexus.services.browse.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.browse.models import (
    BrowseProviderFailure,
    BrowseQuery,
    BrowseSectionFailureKind,
    BrowseTargetNotFound,
    provider_instant,
    proxied_image,
    retry_at_from_header,
    seal_target,
    single_credit,
    youtube_target,
)
from nexus.services.keyset_cursor import KeysetValueKind
from nexus.services.net.http_retry import get_json_with_retry
from nexus.services.youtube_identity import classify_youtube_provider_video_id

_PROVIDER_CONTRACT = "YouTubeDataV3VideoSearch"
_BACKOFF_SECONDS = (0.25, 0.75)
_DURATION = re.compile(
    r"P(?:(?P<days>[0-9]+)D)?T"
    r"(?:(?P<hours>[0-9]+)H)?"
    r"(?:(?P<minutes>[0-9]+)M)?"
    r"(?:(?P<seconds>[0-9]+)S)?\Z"
)
_PROVIDER = ConfigDict(extra="ignore", strict=True)


class _Thumbnail(BaseModel):
    url: str

    model_config = _PROVIDER


class _Thumbnails(BaseModel):
    default: _Thumbnail | None = None
    medium: _Thumbnail | None = None
    high: _Thumbnail | None = None
    standard: _Thumbnail | None = None
    maxres: _Thumbnail | None = None

    model_config = _PROVIDER


class _Snippet(BaseModel):
    published_at: str = Field(alias="publishedAt")
    title: str
    description: str
    thumbnails: _Thumbnails
    channel_title: str = Field(alias="channelTitle")

    model_config = _PROVIDER


class _SearchIdentity(BaseModel):
    video_id: str = Field(alias="videoId")

    model_config = _PROVIDER


class _SearchItem(BaseModel):
    id: _SearchIdentity
    snippet: _Snippet

    model_config = _PROVIDER


class _SearchResponse(BaseModel):
    items: list[_SearchItem]
    next_page_token: str | None = Field(default=None, alias="nextPageToken")

    model_config = _PROVIDER


class _ContentDetails(BaseModel):
    duration: str

    model_config = _PROVIDER


class _VideoItem(BaseModel):
    id: str
    snippet: _Snippet
    content_details: _ContentDetails = Field(alias="contentDetails")

    model_config = _PROVIDER


class _VideoResponse(BaseModel):
    items: list[_VideoItem]

    model_config = _PROVIDER


@dataclass(frozen=True, slots=True)
class YouTubeVideo:
    video_ref: str
    title: str
    description: str | None
    channel_title: str | None
    published_at: datetime
    image_href: str | None
    watch_href: str
    embed_href: str
    duration_seconds: int
    contributors: list[ContributorCreditOut]


def search(
    *,
    viewer_id,
    query: BrowseQuery,
) -> tuple[list[BrowseCandidate], str | None]:
    page_token = None
    if query.cursor is not None:
        page_token = str(
            decode_search_cursor(
                query.cursor,
                query,
                viewer_id=viewer_id,
                provider_contract=_PROVIDER_CONTRACT,
                kind=KeysetValueKind.Text,
            )
        )
    settings = get_settings()
    if not settings.youtube_data_api_key:
        raise RuntimeError("YouTube Browse provider is not configured")
    params: dict[str, str | int] = {
        "key": settings.youtube_data_api_key,
        "part": "snippet",
        "q": query.query,
        "type": "video",
        "maxResults": query.limit,
        "safeSearch": "moderate",
        "order": "date" if query.sort is not None else "relevance",
    }
    if page_token is not None:
        params["pageToken"] = page_token
    payload = _provider_json(
        f"{settings.youtube_data_base_url.rstrip('/')}/search",
        params=params,
    )
    try:
        response = _SearchResponse.model_validate(payload)
    except ValidationError as exc:
        raise RuntimeError("YouTube Browse response schema drift") from exc
    items: list[BrowseCandidate] = [_search_candidate(item) for item in response.items]
    next_cursor = None
    if response.next_page_token is not None:
        next_cursor = encode_search_cursor(
            query,
            viewer_id=viewer_id,
            provider_contract=_PROVIDER_CONTRACT,
            after=response.next_page_token,
        )
    return items, next_cursor


def preview(video_ref: str) -> YouTubeVideo:
    settings = get_settings()
    if not settings.youtube_data_api_key:
        raise RuntimeError("YouTube Browse provider is not configured")
    identity = classify_youtube_provider_video_id(video_ref)
    if identity is None:
        raise BrowseTargetNotFound
    payload = _provider_json(
        f"{settings.youtube_data_base_url.rstrip('/')}/videos",
        params={
            "key": settings.youtube_data_api_key,
            "part": "snippet,contentDetails",
            "id": video_ref,
            "maxResults": 1,
        },
    )
    try:
        response = _VideoResponse.model_validate(payload)
    except ValidationError as exc:
        raise RuntimeError("YouTube Preview response schema drift") from exc
    if len(response.items) != 1 or response.items[0].id != video_ref:
        raise BrowseTargetNotFound
    item = response.items[0]
    channel_title = item.snippet.channel_title.strip() or None
    return YouTubeVideo(
        video_ref=video_ref,
        title=_nonblank(item.snippet.title, "title"),
        description=item.snippet.description.strip() or None,
        channel_title=channel_title,
        published_at=provider_instant(item.snippet.published_at, provider="YouTube"),
        image_href=_thumbnail(item.snippet.thumbnails),
        watch_href=identity.watch_url,
        embed_href=identity.embed_url,
        duration_seconds=_duration_seconds(item.content_details.duration),
        contributors=single_credit(channel_title, "channel"),
    )


def _search_candidate(item: _SearchItem) -> VideoCandidate:
    identity = classify_youtube_provider_video_id(item.id.video_id)
    if identity is None:
        raise RuntimeError("YouTube Browse returned an invalid video identity")
    channel_title = item.snippet.channel_title.strip() or None
    target = seal_target(youtube_target(identity.provider_video_id))
    return VideoCandidate(
        source=BrowseSource.YouTube,
        resolution=PreviewResolution(target=target),
        title=_nonblank(item.snippet.title, "title"),
        contributors=single_credit(channel_title, "channel"),
        description=(
            absent()
            if not item.snippet.description.strip()
            else present(item.snippet.description.strip())
        ),
        published_at=present(provider_instant(item.snippet.published_at, provider="YouTube")),
        image=(
            absent() if (image := _thumbnail(item.snippet.thumbnails)) is None else present(image)
        ),
        kind_facts=VideoFacts(
            video_ref=present(identity.provider_video_id),
            channel_title=(absent() if channel_title is None else present(channel_title)),
        ),
    )


def _provider_json(url: str, *, params: dict[str, str | int]) -> dict[str, object]:
    try:
        return get_json_with_retry(
            url,
            headers={"Accept": "application/json"},
            params=params,
            timeout_s=15.0,
            backoff_seconds=_BACKOFF_SECONDS,
            error_code=ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            provider_name="youtube_data",
            honor_retry_after=True,
        )
    except ApiError as exc:
        cause = exc.__cause__
        if isinstance(cause, httpx.HTTPStatusError):
            response = cause.response
            if response.status_code == 429:
                raise BrowseProviderFailure(
                    BrowseSectionFailureKind.RateLimited,
                    retry_at=retry_at_from_header(response.headers.get("retry-after")),
                ) from exc
            if response.status_code == 403:
                reason = _google_error_reason(response)
                if reason in {"quotaExceeded", "dailyLimitExceeded"}:
                    raise BrowseProviderFailure(BrowseSectionFailureKind.QuotaExhausted) from exc
                raise RuntimeError(f"YouTube Browse configuration defect: {reason}") from exc
            if response.status_code in {408, 500, 502, 503, 504}:
                raise BrowseProviderFailure(BrowseSectionFailureKind.Unavailable) from exc
            raise RuntimeError(
                f"YouTube Browse returned unexpected HTTP {response.status_code}"
            ) from exc
        if isinstance(cause, (httpx.TimeoutException, httpx.NetworkError)):
            raise BrowseProviderFailure(BrowseSectionFailureKind.Unavailable) from exc
        raise RuntimeError("YouTube Browse returned an invalid response") from exc


def _google_error_reason(response: httpx.Response) -> str:
    try:
        payload = response.json()
        errors = payload["error"]["errors"]
        reason = errors[0]["reason"]
    except (ValueError, TypeError, KeyError, IndexError) as exc:
        raise RuntimeError("YouTube error response schema drift") from exc
    if not isinstance(reason, str) or not reason:
        raise RuntimeError("YouTube error response has no reason")
    return reason


def _duration_seconds(raw: str) -> int:
    match = _DURATION.fullmatch(raw)
    if match is None or not any(match.groupdict().values()):
        raise RuntimeError("YouTube returned an invalid ISO-8601 duration")
    return (
        int(match.group("days") or 0) * 86_400
        + int(match.group("hours") or 0) * 3_600
        + int(match.group("minutes") or 0) * 60
        + int(match.group("seconds") or 0)
    )


def _thumbnail(thumbnails: _Thumbnails) -> str | None:
    for value in (
        thumbnails.maxres,
        thumbnails.standard,
        thumbnails.high,
        thumbnails.medium,
        thumbnails.default,
    ):
        if value is not None and value.url:
            return proxied_image(value.url)
    return None


def _nonblank(value: str, field: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise RuntimeError(f"YouTube returned a blank {field}")
    return normalized
