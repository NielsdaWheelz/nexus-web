"""Podcast Index Browse and non-mutating Preview adapter."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlsplit
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nexus.config import get_settings
from nexus.errors import ApiError, InvalidRequestError
from nexus.schemas.browse import (
    BrowseCandidate,
    BrowseSource,
    EpisodePreviewFacts,
    PodcastCandidate,
    PodcastFacts,
    PodcastPreviewEpisode,
    PreviewResolution,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import absent, present
from nexus.services.browse.cursor import (
    BrowsePreviewEpisodesPlan,
    decode_preview_episodes_cursor,
    encode_preview_episodes_cursor,
)
from nexus.services.browse.models import (
    BrowseProviderFailure,
    BrowseQuery,
    BrowseSectionFailureKind,
    BrowseTargetNotFound,
    ResolvedEpisode,
    ResolvedPodcast,
    episode_target,
    podcast_target,
    seal_target,
)
from nexus.services.podcasts.identity import validate_and_normalize_feed_url
from nexus.services.podcasts.provider import get_podcast_index_client
from nexus.services.sealed_handles import DiscoveryTargetHandle
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.web_paths import media_image_url

_PROVIDER = ConfigDict(extra="ignore", strict=True)


class _Feed(BaseModel):
    id: int | str | None = None
    title: str
    url: str
    author: str | None = None
    link: str | None = None
    image: str | None = None
    artwork: str | None = None
    description: str | None = None

    model_config = _PROVIDER


class _SearchPayload(BaseModel):
    feeds: list[_Feed]

    model_config = _PROVIDER


class _PodcastPayload(BaseModel):
    feed: _Feed

    model_config = _PROVIDER


class _Episode(BaseModel):
    id: int | str | None = None
    feed_id: int | str | None = Field(default=None, alias="feedId")
    title: str
    description: str | None = None
    enclosure_url: str | None = Field(default=None, alias="enclosureUrl")
    guid: str | None = None
    date_published: int | None = Field(default=None, alias="datePublished")
    duration: int | None = None

    model_config = _PROVIDER


class _EpisodePagePayload(BaseModel):
    items: list[_Episode]

    model_config = _PROVIDER


class _EpisodePayload(BaseModel):
    episode: _Episode

    model_config = _PROVIDER


def search(
    *,
    viewer_id: UUID,
    query: BrowseQuery,
) -> tuple[list[BrowseCandidate], str | None]:
    if query.cursor is not None:
        from nexus.errors import ApiErrorCode, InvalidRequestError

        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
    client = _client()
    payload = _provider_call(lambda: client.browse_search_payload(query.query, query.limit))
    try:
        response = _SearchPayload.model_validate(payload)
    except ValidationError as exc:
        raise RuntimeError("Podcast Index search response schema drift") from exc
    return [
        _candidate(_podcast(feed))
        for feed in response.feeds
        if feed.id is not None and str(feed.id).strip()
    ], None


def resolve_podcast(podcast_ref: str) -> ResolvedPodcast:
    client = _client()
    payload = _provider_call(
        lambda: client.browse_podcast_payload(podcast_ref),
        target_lookup=True,
    )
    try:
        response = _PodcastPayload.model_validate(payload)
    except ValidationError as exc:
        if payload.get("feed") is None:
            raise BrowseTargetNotFound from exc
        raise RuntimeError("Podcast Index Podcast response schema drift") from exc
    podcast = _podcast(response.feed)
    if podcast.podcast_ref != podcast_ref:
        raise BrowseTargetNotFound
    return podcast


def resolve_episode(
    *,
    podcast_ref: str,
    episode_ref: str,
) -> ResolvedEpisode:
    podcast = resolve_podcast(podcast_ref)
    client = _client()
    payload = _provider_call(
        lambda: client.browse_episode_payload(episode_ref),
        target_lookup=True,
    )
    try:
        response = _EpisodePayload.model_validate(payload)
    except ValidationError as exc:
        if payload.get("episode") is None:
            raise BrowseTargetNotFound from exc
        raise RuntimeError("Podcast Index Episode response schema drift") from exc
    episode = _episode(
        response.episode,
        expected_podcast_ref=podcast_ref,
        podcast=podcast,
    )
    if episode is None:
        raise BrowseTargetNotFound
    if episode.episode_ref != episode_ref:
        raise BrowseTargetNotFound
    return episode


def episode_page(
    *,
    viewer_id: UUID,
    target: DiscoveryTargetHandle,
    podcast: ResolvedPodcast,
    limit: int,
    cursor: str | None,
) -> tuple[list[PodcastPreviewEpisode], str | None]:
    after: tuple[int, str] | None = None
    if cursor is not None:
        after = decode_preview_episodes_cursor(
            cursor,
            viewer_id=viewer_id,
            target=target,
            plan=BrowsePreviewEpisodesPlan.PodcastIndexBeforePublished,
        )
    client = _client()
    payload = _provider_call(
        lambda: client.browse_episode_page_payload(
            podcast.podcast_ref,
            100,
            None if after is None else after[0] + 1,
        ),
        target_lookup=True,
    )
    try:
        response = _EpisodePagePayload.model_validate(payload)
    except ValidationError as exc:
        raise RuntimeError("Podcast Index episode-page response schema drift") from exc
    episodes = [
        episode
        for item in response.items
        if item.id is not None
        and str(item.id).strip()
        and item.enclosure_url is not None
        and item.enclosure_url.strip()
        and (
            episode := _episode(
                item,
                expected_podcast_ref=podcast.podcast_ref,
                podcast=podcast,
            )
        )
        is not None
    ]
    episodes.sort(key=_episode_key, reverse=True)
    if after is not None:
        episodes = [episode for episode in episodes if _episode_key(episode) < after]
    selected = episodes[: limit + 1]
    items = [_episode_item(episode) for episode in selected[:limit]]
    next_cursor = None
    if len(selected) > limit:
        final = selected[limit - 1]
        published, episode_ref = _episode_key(final)
        next_cursor = encode_preview_episodes_cursor(
            viewer_id=viewer_id,
            target=target,
            plan=BrowsePreviewEpisodesPlan.PodcastIndexBeforePublished,
            before_published=published,
            before_episode_ref=episode_ref,
        )
    return items, next_cursor


def _client():
    settings = get_settings()
    if not settings.real_media_provider_fixtures and (
        not settings.podcast_index_api_key or not settings.podcast_index_api_secret
    ):
        raise RuntimeError("Podcast Index Browse provider is not configured")
    return get_podcast_index_client()


def _provider_call(call, *, target_lookup: bool = False):
    try:
        return call()
    except ApiError as exc:
        cause = exc.__cause__
        if isinstance(cause, httpx.HTTPStatusError):
            response = cause.response
            if target_lookup and response.status_code in {404, 410}:
                raise BrowseTargetNotFound from exc
            if response.status_code == 429:
                raise BrowseProviderFailure(
                    BrowseSectionFailureKind.RateLimited,
                    retry_at=_retry_at(response.headers.get("retry-after")),
                ) from exc
            if response.status_code in {408, 500, 502, 503, 504}:
                raise BrowseProviderFailure(BrowseSectionFailureKind.Unavailable) from exc
            raise RuntimeError(
                f"Podcast Index returned unexpected HTTP {response.status_code}"
            ) from exc
        if isinstance(cause, (httpx.TimeoutException, httpx.NetworkError)):
            raise BrowseProviderFailure(BrowseSectionFailureKind.Unavailable) from exc
        raise RuntimeError("Podcast Index returned an invalid response") from exc


def _podcast(feed: _Feed) -> ResolvedPodcast:
    if feed.id is None:
        raise RuntimeError("Podcast Index returned no stable Podcast ref")
    podcast_ref = _provider_ref(feed.id)
    try:
        feed_url = validate_and_normalize_feed_url(feed.url)
    except InvalidRequestError as exc:
        raise RuntimeError("Podcast Index returned an invalid feed URL") from exc
    return ResolvedPodcast(
        podcast_ref=podcast_ref,
        title=_nonblank(feed.title, "Podcast title"),
        author=_optional_text(feed.author),
        feed_url=feed_url,
        website_url=_optional_public_url(feed.link),
        image_url=_optional_public_url(feed.image or feed.artwork),
        description=_optional_text(feed.description),
    )


def _episode(
    episode: _Episode,
    *,
    expected_podcast_ref: str,
    podcast: ResolvedPodcast,
) -> ResolvedEpisode | None:
    if episode.id is None:
        raise RuntimeError("Podcast Index returned no stable Episode ref")
    if episode.feed_id is not None and _provider_ref(episode.feed_id) != expected_podcast_ref:
        raise BrowseTargetNotFound
    audio_url = _optional_public_url(episode.enclosure_url)
    if audio_url is None or urlsplit(audio_url).scheme != "https":
        return None
    published_at = (
        None
        if episode.date_published is None or episode.date_published <= 0
        else datetime.fromtimestamp(episode.date_published, UTC)
    )
    duration = episode.duration
    if duration is not None and duration <= 0:
        duration = None
    return ResolvedEpisode(
        podcast_ref=expected_podcast_ref,
        episode_ref=_provider_ref(episode.id),
        title=_nonblank(episode.title, "Episode title"),
        description=_optional_text(episode.description),
        audio_url=audio_url,
        guid=_optional_text(episode.guid),
        published_at=published_at,
        duration_seconds=duration,
        podcast=podcast,
    )


def _candidate(podcast: ResolvedPodcast) -> PodcastCandidate:
    target = seal_target(podcast_target(podcast.podcast_ref))
    contributors = _contributors(podcast.author)
    return PodcastCandidate(
        source=BrowseSource.PodcastIndex,
        resolution=PreviewResolution(target=target),
        title=podcast.title,
        contributors=contributors,
        description=(absent() if podcast.description is None else present(podcast.description)),
        published_at=absent(),
        image=(
            absent() if (image := _proxied_image(podcast.image_url)) is None else present(image)
        ),
        kind_facts=PodcastFacts(podcast_ref=podcast.podcast_ref),
    )


def _episode_item(episode: ResolvedEpisode) -> PodcastPreviewEpisode:
    target = seal_target(episode_target(episode.podcast_ref, episode.episode_ref))
    return PodcastPreviewEpisode(
        target=target,
        title=episode.title,
        contributors=_contributors(episode.podcast.author),
        description=(absent() if episode.description is None else present(episode.description)),
        published_at=(absent() if episode.published_at is None else present(episode.published_at)),
        image=(
            absent()
            if (image := _proxied_image(episode.podcast.image_url)) is None
            else present(image)
        ),
        kind_facts=EpisodePreviewFacts(
            podcast_ref=episode.podcast_ref,
            episode_ref=episode.episode_ref,
            podcast_title=episode.podcast.title,
            audio_href=episode.audio_url,
            duration_seconds=(
                absent() if episode.duration_seconds is None else present(episode.duration_seconds)
            ),
        ),
    )


def _episode_key(episode: ResolvedEpisode) -> tuple[int, str]:
    published = 0 if episode.published_at is None else int(episode.published_at.timestamp())
    return published, episode.episode_ref


def _contributors(author: str | None) -> list[ContributorCreditOut]:
    if author is None:
        return []
    return [
        ContributorCreditOut(
            credited_name=author,
            contributor_display_name=author,
            role="author",
        )
    ]


def _provider_ref(value: int | str) -> str:
    if isinstance(value, bool):
        raise RuntimeError("Podcast Index returned an invalid provider ref")
    ref = str(value)
    if not ref or ref != ref.strip() or len(ref) > 512:
        raise RuntimeError("Podcast Index returned an invalid provider ref")
    return ref


def _nonblank(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise RuntimeError(f"Podcast Index returned a blank {label}")
    return normalized


def _optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _optional_public_url(value: str | None) -> str | None:
    normalized = _optional_text(value)
    if normalized is None:
        return None
    try:
        validate_requested_url(normalized)
        return normalize_url_for_display(normalized)
    except (InvalidRequestError, ValueError):
        return None


def _proxied_image(value: str | None) -> str | None:
    return None if value is None else media_image_url(quote(value, safe=""))


def _retry_at(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return datetime.now(UTC) + timedelta(seconds=max(seconds, 0.0))
