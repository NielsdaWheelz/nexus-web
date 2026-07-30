"""Browse query/Preview orchestration and viewer-relative collision resolution."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.browse import (
    BrowseCandidate,
    BrowsePage,
    BrowsePreview,
    EpisodePreview,
    EpisodePreviewFacts,
    EpubPreview,
    EpubPreviewFacts,
    InNexusResolution,
    PodcastPreview,
    PodcastPreviewEpisodePage,
    PodcastPreviewFacts,
    PreviewResolution,
    VideoPreview,
    VideoPreviewFacts,
    WebArticlePreview,
    WebArticlePreviewFacts,
)
from nexus.schemas.presence import absent, present
from nexus.services.browse import brave, gutenberg, nexus, podcast_index, youtube
from nexus.services.browse.models import (
    BraveWebArticleTarget,
    BrowsePreviewQuery,
    BrowseQuery,
    BrowseSource,
    DiscoveryTarget,
    PodcastIndexEpisodeTarget,
    PodcastIndexPodcastTarget,
    ProjectGutenbergEpubTarget,
    ResolvedEpisode,
    ResolvedPodcast,
    YouTubeVideoTarget,
    unseal_target,
)
from nexus.services.podcasts.episode_identity import (
    select_visible_episode_media_id_by_podcast_index_ref,
)
from nexus.services.podcasts.subscriptions_query import active_subscription_rows_sql
from nexus.services.sealed_handles import DiscoveryTargetHandle


async def search_browse(
    db: Session,
    *,
    viewer_id: UUID,
    query: BrowseQuery,
    web_search_provider: WebSearchProvider | None,
) -> BrowsePage:
    match query.source:
        case BrowseSource.Nexus:
            items, next_cursor = nexus.search(
                db,
                viewer_id=viewer_id,
                query=query,
            )
        case BrowseSource.ProjectGutenberg:
            items, next_cursor = gutenberg.search(
                db,
                viewer_id=viewer_id,
                query=query,
            )
        case BrowseSource.Brave:
            items, next_cursor = await brave.search(
                web_search_provider,
                query=query,
            )
        case BrowseSource.YouTube:
            items, next_cursor = youtube.search(
                viewer_id=viewer_id,
                query=query,
            )
        case BrowseSource.PodcastIndex:
            items, next_cursor = podcast_index.search(
                viewer_id=viewer_id,
                query=query,
            )
    items = [_with_owned_resolution(db, viewer_id=viewer_id, candidate=item) for item in items]
    return BrowsePage(
        query=query.query,
        kind=query.kind,
        source=query.source,
        sort=absent() if query.sort is None else present(query.sort),
        items=items,
        next_cursor=absent() if next_cursor is None else present(next_cursor),
    )


def preview_browse(
    db: Session,
    *,
    viewer_id: UUID,
    query: BrowsePreviewQuery,
) -> BrowsePreview:
    target = unseal_target(query.target)
    if query.cursor is not None and not isinstance(target, PodcastIndexPodcastTarget):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
            "Invalid discovery target",
        )
    resolution = _preview_resolution(
        db,
        viewer_id=viewer_id,
        handle=query.target,
        target=target,
    )
    match target:
        case ProjectGutenbergEpubTarget():
            book = gutenberg.preview(
                db,
                viewer_id=viewer_id,
                ebook_ref=target.ebook_ref,
            )
            return EpubPreview(
                target=query.target,
                title=book.title,
                contributors=book.contributors,
                description=(absent() if book.description is None else present(book.description)),
                published_at=absent(),
                image=absent(),
                source_href=book.landing_href,
                resolution=resolution,
                kind_facts=EpubPreviewFacts(
                    ebook_ref=book.ebook_ref,
                    import_href=book.import_href,
                ),
            )
        case BraveWebArticleTarget():
            article = brave.preview(target.canonical_url)
            resolution = _preview_resolution(
                db,
                viewer_id=viewer_id,
                handle=query.target,
                target=target,
                equivalent_urls=(article.source_href,),
            )
            return WebArticlePreview(
                target=query.target,
                title=article.title,
                contributors=article.contributors,
                description=(
                    absent() if article.description is None else present(article.description)
                ),
                published_at=(
                    absent() if article.published_at is None else present(article.published_at)
                ),
                image=(absent() if article.image_href is None else present(article.image_href)),
                source_href=article.source_href,
                resolution=resolution,
                kind_facts=WebArticlePreviewFacts(
                    canonical_url=article.canonical_url,
                    site_name=(absent() if not article.site_name else present(article.site_name)),
                ),
            )
        case YouTubeVideoTarget():
            video = youtube.preview(target.video_ref)
            return VideoPreview(
                target=query.target,
                title=video.title,
                contributors=video.contributors,
                description=(absent() if video.description is None else present(video.description)),
                published_at=present(video.published_at),
                image=(absent() if video.image_href is None else present(video.image_href)),
                source_href=video.watch_href,
                resolution=resolution,
                kind_facts=VideoPreviewFacts(
                    video_ref=video.video_ref,
                    channel_title=(
                        absent() if video.channel_title is None else present(video.channel_title)
                    ),
                    embed_href=video.embed_href,
                ),
            )
        case PodcastIndexPodcastTarget():
            podcast = podcast_index.resolve_podcast(target.podcast_ref)
            episode_items, next_cursor = podcast_index.episode_page(
                viewer_id=viewer_id,
                target=query.target,
                podcast=podcast,
                limit=query.limit,
                cursor=query.cursor,
            )
            return PodcastPreview(
                target=query.target,
                title=podcast.title,
                contributors=_podcast_contributors(podcast),
                description=(
                    absent() if podcast.description is None else present(podcast.description)
                ),
                published_at=absent(),
                image=_podcast_image(podcast),
                source_href=podcast.website_url or podcast.feed_url,
                resolution=resolution,
                kind_facts=PodcastPreviewFacts(
                    podcast_ref=podcast.podcast_ref,
                    feed_href=podcast.feed_url,
                    website_href=(
                        absent() if podcast.website_url is None else present(podcast.website_url)
                    ),
                ),
                episodes=PodcastPreviewEpisodePage(
                    items=episode_items,
                    next_cursor=(absent() if next_cursor is None else present(next_cursor)),
                ),
            )
        case PodcastIndexEpisodeTarget():
            episode = podcast_index.resolve_episode(
                podcast_ref=target.podcast_ref,
                episode_ref=target.episode_ref,
            )
            return EpisodePreview(
                target=query.target,
                title=episode.title,
                contributors=_podcast_contributors(episode.podcast),
                description=(
                    absent() if episode.description is None else present(episode.description)
                ),
                published_at=(
                    absent() if episode.published_at is None else present(episode.published_at)
                ),
                image=_podcast_image(episode.podcast),
                source_href=episode.audio_url,
                resolution=resolution,
                kind_facts=_episode_facts(episode),
            )


def resolve_podcast_discovery_target(
    handle: str,
) -> ResolvedPodcast | ResolvedEpisode:
    target = unseal_target(handle)
    match target:
        case PodcastIndexPodcastTarget():
            return podcast_index.resolve_podcast(target.podcast_ref)
        case PodcastIndexEpisodeTarget():
            return podcast_index.resolve_episode(
                podcast_ref=target.podcast_ref,
                episode_ref=target.episode_ref,
            )
        case _:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
                "Discovery target is not a Podcast or Episode",
            )


def _with_owned_resolution(
    db: Session,
    *,
    viewer_id: UUID,
    candidate: BrowseCandidate,
) -> BrowseCandidate:
    if not isinstance(candidate.resolution, PreviewResolution):
        return candidate
    target = unseal_target(candidate.resolution.target)
    href = _owned_href(db, viewer_id=viewer_id, target=target)
    if href is None:
        return candidate
    return candidate.model_copy(update={"resolution": InNexusResolution(href=href)})


def _preview_resolution(
    db: Session,
    *,
    viewer_id: UUID,
    handle: DiscoveryTargetHandle,
    target: DiscoveryTarget,
    equivalent_urls: tuple[str, ...] = (),
) -> InNexusResolution | PreviewResolution:
    href = _owned_href(
        db,
        viewer_id=viewer_id,
        target=target,
        equivalent_urls=equivalent_urls,
    )
    if href is None:
        return PreviewResolution(target=handle)
    return InNexusResolution(href=href)


def _owned_href(
    db: Session,
    *,
    viewer_id: UUID,
    target: DiscoveryTarget,
    equivalent_urls: tuple[str, ...] = (),
) -> str | None:
    match target:
        case ProjectGutenbergEpubTarget():
            ebook_ref = target.ebook_ref
            urls = (
                f"https://www.gutenberg.org/ebooks/{ebook_ref}",
                f"https://www.gutenberg.org/ebooks/{ebook_ref}.epub.noimages",
            )
            media_id = _visible_media_by_urls(
                db,
                viewer_id=viewer_id,
                media_kind="epub",
                urls=urls,
            )
            return None if media_id is None else f"/media/{media_id}"
        case BraveWebArticleTarget():
            media_id = _visible_media_by_urls(
                db,
                viewer_id=viewer_id,
                media_kind="web_article",
                urls=(target.canonical_url, *equivalent_urls),
            )
            return None if media_id is None else f"/media/{media_id}"
        case YouTubeVideoTarget():
            media_id = db.scalar(
                text(
                    f"""
                    WITH visible_media AS ({visible_media_ids_cte_sql()})
                    SELECT m.id
                    FROM media m
                    JOIN visible_media vm ON vm.media_id = m.id
                    WHERE m.kind = 'video'
                      AND m.provider = 'youtube'
                      AND m.provider_id = :video_ref
                    """
                ),
                {"viewer_id": viewer_id, "video_ref": target.video_ref},
            )
            return None if media_id is None else f"/media/{media_id}"
        case PodcastIndexPodcastTarget():
            podcast_id = db.scalar(
                text(
                    f"""
                    WITH active_subscriptions AS ({active_subscription_rows_sql()})
                    SELECT podcast.id
                    FROM podcasts podcast
                    JOIN active_subscriptions active
                      ON active.podcast_id = podcast.id
                    WHERE podcast.provider = 'podcast_index'
                      AND podcast.provider_podcast_id = :podcast_ref
                    """
                ),
                {"viewer_id": viewer_id, "podcast_ref": target.podcast_ref},
            )
            return None if podcast_id is None else f"/podcasts/{podcast_id}"
        case PodcastIndexEpisodeTarget():
            media_id = select_visible_episode_media_id_by_podcast_index_ref(
                db,
                viewer_id=viewer_id,
                podcast_ref=target.podcast_ref,
                episode_ref=target.episode_ref,
            )
            return None if media_id is None else f"/media/{media_id}"


def _visible_media_by_urls(
    db: Session,
    *,
    viewer_id: UUID,
    media_kind: str,
    urls: tuple[str, ...],
) -> UUID | None:
    return db.scalar(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT m.id
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            WHERE m.kind = :media_kind
              AND (
                  m.requested_url = ANY(:urls)
                  OR m.canonical_url = ANY(:urls)
                  OR m.canonical_source_url = ANY(:urls)
                  OR m.external_playback_url = ANY(:urls)
              )
            ORDER BY m.updated_at DESC, m.id DESC
            LIMIT 1
            """
        ),
        {
            "viewer_id": viewer_id,
            "media_kind": media_kind,
            "urls": list(dict.fromkeys(urls)),
        },
    )


def _podcast_contributors(podcast: ResolvedPodcast):
    from nexus.schemas.contributors import ContributorCreditOut

    if podcast.author is None:
        return []
    return [
        ContributorCreditOut(
            credited_name=podcast.author,
            contributor_display_name=podcast.author,
            role="author",
        )
    ]


def _podcast_image(podcast: ResolvedPodcast):
    from urllib.parse import quote

    from nexus.web_paths import media_image_url

    return (
        absent()
        if podcast.image_url is None
        else present(media_image_url(quote(podcast.image_url, safe="")))
    )


def _episode_facts(episode: ResolvedEpisode) -> EpisodePreviewFacts:
    return EpisodePreviewFacts(
        podcast_ref=episode.podcast_ref,
        episode_ref=episode.episode_ref,
        podcast_title=episode.podcast.title,
        audio_href=episode.audio_url,
        duration_seconds=(
            absent() if episode.duration_seconds is None else present(episode.duration_seconds)
        ),
    )
