"""Podcast Index: podcast search for Browse, target resolution, and non-mutating Previews."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from nexus.config import get_settings
from nexus.errors import ApiError, InvalidRequestError
from nexus.schemas.browse import (
    EpisodePreview,
    EpisodePreviewFacts,
    PodcastCandidate,
    PodcastFacts,
    PodcastPreview,
    PodcastPreviewEpisode,
    PodcastPreviewEpisodes,
    PodcastPreviewFacts,
    PreviewResolution,
)
from nexus.services.browse.targets import (
    BrowseFailureKind,
    BrowseProviderFailure,
    BrowseTargetNotFound,
    PodcastIndexEpisodeTarget,
    PodcastIndexPodcastTarget,
    ResolvedEpisode,
    ResolvedPodcast,
    classify,
    proxied_image,
    public_url,
    seal_target,
    single_credit,
)
from nexus.services.podcasts.provider import PodcastIndexClient, get_podcast_index_client
from nexus.services.podcasts.shows import validate_and_normalize_feed_url
from nexus.services.sealed_handles import DiscoveryTargetHandle

# What a malformed provider item raises (a non-public feed url is an InvalidRequestError).
_MALFORMED = (KeyError, TypeError, ValueError, AttributeError, InvalidRequestError)
type _Fetch = Callable[[PodcastIndexClient], dict[str, Any]]


def _call(fetch: _Fetch, *, lookup: bool = False) -> dict[str, Any]:
    settings = get_settings()
    if not settings.podcast_index_api_key or not settings.podcast_index_api_secret:
        raise BrowseProviderFailure(BrowseFailureKind.Unavailable)
    try:
        return fetch(get_podcast_index_client())
    except ApiError as exc:
        raise classify(exc, provider="Podcast Index", target_lookup=lookup) from exc


def _text(value: object) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _ref(value: object) -> str:
    ref = str(value) if isinstance(value, int | str) and not isinstance(value, bool) else ""
    if not ref.strip() or ref != ref.strip() or len(ref) > 512:
        raise ValueError("invalid Podcast Index ref")
    return ref


def _podcast(feed: dict[str, Any]) -> ResolvedPodcast:
    if not feed["title"].strip():
        raise ValueError("blank podcast title")
    return ResolvedPodcast(
        podcast_ref=_ref(feed["id"]),
        title=feed["title"].strip(),
        author=_text(feed.get("author")),
        feed_url=validate_and_normalize_feed_url(feed["url"]),
        website_url=public_url(feed.get("link")),
        image_url=public_url(feed.get("image") or feed.get("artwork")),
        description=_text(feed.get("description")),
    )


def _episode(item: dict[str, Any], podcast: ResolvedPodcast) -> ResolvedEpisode | None:
    """The episode, or None when it has no public https audio or names another podcast."""
    audio = public_url(item.get("enclosureUrl"))
    feed = item.get("feedId")
    if audio is None or urlsplit(audio).scheme != "https":
        return None
    if feed is not None and _ref(feed) != podcast.podcast_ref:
        return None
    if not item["title"].strip():
        raise ValueError("blank episode title")
    stamp = item.get("datePublished")
    duration = item.get("duration")
    try:
        published_at = (
            datetime.fromtimestamp(stamp, UTC) if type(stamp) is int and stamp > 0 else None
        )
    except (OverflowError, OSError) as exc:
        raise ValueError("invalid episode publication date") from exc
    return ResolvedEpisode(
        podcast_ref=podcast.podcast_ref,
        episode_ref=_ref(item["id"]),
        title=item["title"].strip(),
        description=_text(item.get("description")),
        audio_url=audio,
        guid=_text(item.get("guid")),
        published_at=published_at,
        duration_seconds=duration if type(duration) is int and duration > 0 else None,
        podcast=podcast,
    )


def _strict[T](parse: Callable[[], T], what: str) -> T:
    """A single looked-up target must parse; its malformation is a provider defect."""
    try:
        return parse()
    except _MALFORMED as exc:
        raise RuntimeError(f"Podcast Index {what} response schema drift") from exc


def _shown(podcast: ResolvedPodcast) -> dict[str, Any]:
    """The facts a podcast candidate and its Preview both show."""
    return {
        "title": podcast.title,
        "contributors": single_credit(podcast.author, "author"),
        "description": podcast.description,
        "published_at": None,
        "image": proxied_image(podcast.image_url),
    }


def search(q: str, *, limit: int) -> list[PodcastCandidate]:
    """Podcasts matching ``q``; a malformed feed is skipped."""
    items = []
    params = {"q": q, "max": max(1, min(limit, 100))}
    for feed in _call(lambda client: client.get("/search/byterm", params)).get("feeds") or []:
        try:
            podcast = _podcast(feed)
        except _MALFORMED:
            continue
        target = seal_target(PodcastIndexPodcastTarget(podcastRef=podcast.podcast_ref))
        items.append(
            PodcastCandidate(
                target=target,
                resolution=PreviewResolution(),
                kind_facts=PodcastFacts(podcast_ref=podcast.podcast_ref),
                **_shown(podcast),
            )
        )
    return items


def resolve_podcast(podcast_ref: str) -> ResolvedPodcast:
    payload = _call(
        lambda client: client.get("/podcasts/byfeedid", {"id": podcast_ref}), lookup=True
    )
    feed = payload.get("feed")
    podcast = _strict(lambda: _podcast(feed), "podcast") if isinstance(feed, dict) else None
    if podcast is None or podcast.podcast_ref != podcast_ref:
        raise BrowseTargetNotFound
    return podcast


def resolve_episode(podcast_ref: str, episode_ref: str) -> ResolvedEpisode:
    podcast = resolve_podcast(podcast_ref)
    payload = _call(lambda client: client.get("/episodes/byid", {"id": episode_ref}), lookup=True)
    item = payload.get("episode")
    episode = (
        _strict(lambda: _episode(item, podcast), "episode") if isinstance(item, dict) else None
    )
    if episode is None or episode.episode_ref != episode_ref:
        raise BrowseTargetNotFound
    return episode


def _key(episode: ResolvedEpisode) -> tuple[int, str]:
    published = 0 if episode.published_at is None else int(episode.published_at.timestamp())
    return published, episode.episode_ref


def preview_podcast(
    target: PodcastIndexPodcastTarget, handle: DiscoveryTargetHandle
) -> PodcastPreview:
    """One read-only directory snapshot of at most 1,000 raw episodes, newest first.

    Podcast Index documents no history cursor. Eligibility and malformed-row handling
    apply to the entire returned window; its count does not establish archive size.
    """
    podcast = resolve_podcast(target.podcast_ref)
    page = _call(
        lambda client: client.get("/episodes/byfeedid", {"id": podcast.podcast_ref, "max": 1000}),
        lookup=True,
    )
    episodes = []
    for item in page.get("items") or []:
        try:
            episode = _episode(item, podcast)
        except _MALFORMED:
            continue
        if episode is not None:
            episodes.append(episode)
    return PodcastPreview(
        target=handle,
        source_href=podcast.website_url or podcast.feed_url,
        resolution=PreviewResolution(),
        kind_facts=PodcastPreviewFacts(
            podcast_ref=podcast.podcast_ref,
            feed_href=podcast.feed_url,
            website_href=podcast.website_url,
        ),
        episodes=PodcastPreviewEpisodes(
            items=[_episode_item(episode) for episode in sorted(episodes, key=_key, reverse=True)],
            source_limit=1000,
        ),
        **_shown(podcast),
    )


def _episode_shown(episode: ResolvedEpisode) -> dict[str, Any]:
    """The facts an episode row of a podcast Preview and the episode's own Preview both show."""
    facts = EpisodePreviewFacts(
        podcast_ref=episode.podcast_ref,
        episode_ref=episode.episode_ref,
        podcast_title=episode.podcast.title,
        audio_href=episode.audio_url,
        duration_seconds=episode.duration_seconds,
    )
    return {
        "title": episode.title,
        "contributors": single_credit(episode.podcast.author, "author"),
        "description": episode.description,
        "published_at": episode.published_at,
        "image": proxied_image(episode.podcast.image_url),
        "kind_facts": facts,
    }


def _episode_item(episode: ResolvedEpisode) -> PodcastPreviewEpisode:
    target = PodcastIndexEpisodeTarget(
        podcastRef=episode.podcast_ref, episodeRef=episode.episode_ref
    )
    return PodcastPreviewEpisode(target=seal_target(target), **_episode_shown(episode))


def preview_episode(
    target: PodcastIndexEpisodeTarget, handle: DiscoveryTargetHandle
) -> EpisodePreview:
    episode = resolve_episode(target.podcast_ref, target.episode_ref)
    return EpisodePreview(
        target=handle,
        source_href=episode.audio_url,
        resolution=PreviewResolution(),
        **_episode_shown(episode),
    )
