"""YouTube Data API v3: video search for Browse and a one-video Preview."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.browse import (
    PreviewResolution,
    VideoCandidate,
    VideoFacts,
    VideoPreview,
    VideoPreviewFacts,
)
from nexus.schemas.presence import presence_from_nullable as maybe
from nexus.services.browse.targets import (
    BrowseFailureKind,
    BrowseProviderFailure,
    BrowseTargetNotFound,
    YouTubeVideoTarget,
    classify,
    instant,
    proxied_image,
    seal_target,
    single_credit,
)
from nexus.services.net.http_retry import get_json_with_retry
from nexus.services.sealed_handles import DiscoveryTargetHandle
from nexus.services.youtube_identity import classify_youtube_provider_video_id

_THUMBNAILS = ("maxres", "standard", "high", "medium", "default")
_MALFORMED = (KeyError, TypeError, ValueError, AttributeError)


def _call(path: str, params: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if not settings.youtube_data_api_key:
        raise BrowseProviderFailure(BrowseFailureKind.Unavailable)
    try:
        return get_json_with_retry(
            f"{settings.youtube_data_base_url.rstrip('/')}/{path}",
            headers={"Accept": "application/json"},
            params=params | {"key": settings.youtube_data_api_key},
            timeout_s=15.0,
            backoff_seconds=(0.25, 0.75),
            error_code=ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            provider_name="youtube_data",
            honor_retry_after=True,
        )
    except ApiError as exc:
        quota = frozenset({"quotaExceeded", "dailyLimitExceeded"})
        raise classify(exc, provider="youtube_data", quota_reasons=quota) from exc


def _snippet(snippet: dict[str, Any]) -> tuple[str, str | None, str | None, datetime, str | None]:
    """Title, channel, description, publication and image of one item; raises when malformed."""
    title = snippet["title"].strip()
    if not title:
        raise ValueError("blank title")
    thumbs = snippet["thumbnails"]
    image = next((thumbs[k]["url"] for k in _THUMBNAILS if (thumbs.get(k) or {}).get("url")), None)
    channel = snippet["channelTitle"].strip() or None
    description = snippet["description"].strip() or None
    return title, channel, description, instant(snippet["publishedAt"]), proxied_image(image)


def search(
    q: str, *, newest: bool, limit: int, token: str | None
) -> tuple[list[VideoCandidate], str | None]:
    """One page of videos and the provider's next-page token; a malformed item is skipped."""
    params = {"part": "snippet", "q": q, "type": "video", "maxResults": limit}
    params |= {"safeSearch": "moderate", "order": "date" if newest else "relevance"}
    payload = _call("search", params | ({"pageToken": token} if token else {}))
    items = []
    for item in payload.get("items") or []:
        try:
            identity = classify_youtube_provider_video_id(item["id"]["videoId"])
            title, channel, description, published, image = _snippet(item["snippet"])
        except _MALFORMED:
            continue
        if identity is None:
            continue
        target = YouTubeVideoTarget(videoRef=identity.provider_video_id)
        items.append(
            VideoCandidate(
                resolution=PreviewResolution(target=seal_target(target)),
                title=title,
                contributors=single_credit(channel, "channel"),
                description=maybe(description),
                published_at=maybe(published),
                image=maybe(image),
                kind_facts=VideoFacts(
                    video_ref=maybe(identity.provider_video_id), channel_title=maybe(channel)
                ),
            )
        )
    return items, payload.get("nextPageToken")


def preview(target: YouTubeVideoTarget, handle: DiscoveryTargetHandle) -> VideoPreview:
    identity = classify_youtube_provider_video_id(target.video_ref)
    if identity is None:
        raise BrowseTargetNotFound
    payload = _call("videos", {"part": "snippet", "id": target.video_ref, "maxResults": 1})
    items = payload.get("items") or []
    if len(items) != 1 or items[0].get("id") != target.video_ref:
        raise BrowseTargetNotFound
    try:
        title, channel, description, published, image = _snippet(items[0]["snippet"])
    except _MALFORMED as exc:
        raise RuntimeError("YouTube Preview response schema drift") from exc
    return VideoPreview(
        target=handle,
        title=title,
        contributors=single_credit(channel, "channel"),
        description=maybe(description),
        published_at=maybe(published),
        image=maybe(image),
        source_href=identity.watch_url,
        resolution=PreviewResolution(target=handle),
        kind_facts=VideoPreviewFacts(
            video_ref=target.video_ref, channel_title=maybe(channel), embed_href=identity.embed_url
        ),
    )
