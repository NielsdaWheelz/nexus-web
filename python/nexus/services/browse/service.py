"""Browse: one page of one (kind, source) section, one target's Preview, and owned resolution.

Provider calls finish before any database read; the reads share one snapshot. A candidate or
Preview the viewer already owns resolves to the in-Nexus item instead of a Preview.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, cast
from uuid import UUID

from llm_tools import WebSearchProvider
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.browse import (
    BrowseKind,
    BrowsePage,
    BrowsePreview,
    BrowsePreviewQuery,
    BrowseQuery,
    BrowseSource,
    InNexusMediaResolution,
    InNexusPodcastResolution,
    OwnedMediaCandidate,
    PreviewResolution,
)
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import absent
from nexus.schemas.presence import presence_from_nullable as maybe
from nexus.services.browse import brave, gutenberg, podcast_index, youtube
from nexus.services.browse.targets import (
    BraveWebArticleTarget,
    BrowseProviderFailure,
    BrowseTargetNotFound,
    DiscoveryTarget,
    PodcastIndexEpisodeTarget,
    PodcastIndexPodcastTarget,
    ProjectGutenbergEpubTarget,
    ResolvedEpisode,
    ResolvedPodcast,
    YouTubeVideoTarget,
    provider_api_error,
    unseal_target,
)
from nexus.services.media import list_collection_media_for_viewer_by_ids
from nexus.services.podcasts.ingest import select_visible_episode_media_id_by_podcast_index_ref
from nexus.services.podcasts.subscriptions_query import active_subscription_rows_sql
from nexus.services.sealed_handles import DiscoveryTargetHandle
from nexus.services.search.query import decode_cursor, encode_cursor, is_offset
from nexus.services.search.service import read_snapshot
from nexus.services.search.sources import Retrieval, hydrate, rank

_NEXUS_KINDS = {
    BrowseKind.Pdf: "pdf",
    BrowseKind.Epub: "epub",
    BrowseKind.WebArticle: "web_article",
    BrowseKind.Video: "video",
}
_OFFSET_SOURCES = (BrowseSource.Nexus, BrowseSource.ProjectGutenberg)
_VISIBLE = f"SELECT m.id FROM media m JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id = m.id"
_OWNED_BY_URL = f"""{_VISIBLE} WHERE m.kind = :kind AND (m.requested_url = ANY(:urls)
    OR m.canonical_url = ANY(:urls) OR m.canonical_source_url = ANY(:urls)
    OR m.external_playback_url = ANY(:urls)) ORDER BY m.updated_at DESC, m.id DESC LIMIT 1"""
_OWNED_VIDEO = (
    f"{_VISIBLE} WHERE m.kind = 'video' AND m.provider = 'youtube' AND m.provider_id = :ref"
)
_OWNED_PODCAST = f"""SELECT p.id FROM podcasts p JOIN ({active_subscription_rows_sql()}) a
    ON a.podcast_id = p.id WHERE p.provider = 'podcast_index' AND p.provider_podcast_id = :ref"""


async def search_browse(
    db: Session, viewer_id: UUID, query: BrowseQuery, web: WebSearchProvider | None
) -> BrowsePage:
    """One section page. The cursor is ``{q, kind, source, sort, at}``: ``at`` is an offset
    (Nexus, Gutenberg) or YouTube's page token; Brave and PodcastIndex have one page."""
    binding = query.model_dump(mode="json", exclude={"limit", "cursor"})
    at = None
    if query.cursor is not None:
        position = decode_cursor(query.cursor)
        at = position.pop("at", None)
        offset = query.source in _OFFSET_SOURCES and is_offset(at)
        token = query.source is BrowseSource.YouTube and isinstance(at, str)
        if position != binding or not (offset or token):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
    items: list[Any] = []
    after: int | str | None = None
    match query.source:
        case BrowseSource.Brave:
            items = await brave.search(web, query.q, limit=query.limit)
        case BrowseSource.YouTube:
            newest = query.sort is not None
            token = at if isinstance(at, str) else None
            items, after = await run_in_threadpool(
                lambda: youtube.search(query.q, newest=newest, limit=query.limit, token=token)
            )
        case BrowseSource.PodcastIndex:
            items = await run_in_threadpool(
                lambda: podcast_index.search(query.q, limit=query.limit)
            )

    def read(s: Session) -> tuple[list[Any], int | str | None]:
        if query.source in _OFFSET_SOURCES:
            return _catalogue(s, viewer_id, query, cast(int, at or 0))
        return _resolve_owned(s, viewer_id, items), after

    items, after = await run_in_threadpool(read_snapshot, db, read)
    return BrowsePage(
        query=query.q,
        kind=query.kind,
        source=query.source,
        sort=maybe(query.sort),
        items=items,
        next_cursor=maybe(None if after is None else encode_cursor(binding | {"at": after})),
    )


def _catalogue(
    db: Session, viewer_id: UUID, query: BrowseQuery, offset: int
) -> tuple[list[Any], int | None]:
    """A section of Nexus-owned media or of the Gutenberg catalogue, by the search rule."""
    family = "media" if query.source is BrowseSource.Nexus else "gutenberg"
    kinds = (_NEXUS_KINDS[query.kind],) if family == "media" else ()
    end = offset + query.limit
    hits = rank(db, Retrieval(viewer_id, query.q, end + 1, content_kinds=kinds), family)
    ids = [hit.id for hit in hits[offset:end]]
    after = end if len(hits) > end and is_offset(end) else None
    if family == "gutenberg":
        return gutenberg.candidates(db, viewer_id, ids), after
    descriptions = {row["id"]: row["text"] for row in hydrate(db, viewer_id, "media", ids, "")}
    media = list_collection_media_for_viewer_by_ids(db, viewer_id=viewer_id, media_ids=ids)
    return [
        OwnedMediaCandidate(
            resolution=_in_nexus(item.id, item.summary),
            description=maybe(descriptions.get(item.id)),
            image=absent(),
        )
        for item in media
    ], after


def _in_nexus(media_id: UUID, summary: MediaSummaryOut) -> InNexusMediaResolution:
    return InNexusMediaResolution(
        href=f"/media/{media_id}", action_subject_ref=f"media:{media_id}", media_summary=summary
    )


def preview_browse(db: Session, viewer_id: UUID, query: BrowsePreviewQuery) -> BrowsePreview:
    """One target's Preview; a target the viewer already owns resolves into Nexus."""
    unsealed = unseal_target(query.target)
    handle = DiscoveryTargetHandle(query.target)
    if query.cursor is not None and not isinstance(unsealed, PodcastIndexPodcastTarget):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Invalid discovery target"
        )
    fetched: BrowsePreview | None = None
    match unsealed:
        case BraveWebArticleTarget():
            fetched = brave.preview(unsealed, handle)
        case YouTubeVideoTarget():
            fetched = youtube.preview(unsealed, handle)
        case PodcastIndexPodcastTarget():
            fetched = podcast_index.preview_podcast(
                unsealed, handle, limit=query.limit, cursor=query.cursor
            )
        case PodcastIndexEpisodeTarget():
            fetched = podcast_index.preview_episode(unsealed, handle)

    def read(s: Session) -> BrowsePreview:
        found = fetched or gutenberg.preview(s, viewer_id, cast(Any, unsealed), handle)
        return _resolve_owned(s, viewer_id, [found], found.source_href)[0]

    return read_snapshot(db, read)


def resolve_podcast_discovery_target(handle: str) -> ResolvedPodcast | ResolvedEpisode:
    """The provider podcast or episode a sealed handle names (podcast acquisition); a
    vanished target is 404 and a failing provider its browse code, as for Preview."""
    try:
        match unseal_target(handle):
            case PodcastIndexPodcastTarget(podcast_ref=podcast):
                return podcast_index.resolve_podcast(podcast)
            case PodcastIndexEpisodeTarget(podcast_ref=podcast, episode_ref=episode):
                return podcast_index.resolve_episode(podcast, episode)
    except BrowseTargetNotFound as exc:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "No longer available") from exc
    except BrowseProviderFailure as exc:
        raise provider_api_error(exc) from exc
    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a Podcast or Episode"
    )


def _resolve_owned(db: Session, viewer_id: UUID, items: Sequence[Any], url: str = "") -> list[Any]:
    """Each item, its Preview resolution swapped for an in-Nexus one when the viewer owns
    the target (``url``: a Preview's fetched page, an equivalent article URL)."""
    owned = {}
    for item in items:
        if isinstance(item.resolution, PreviewResolution):
            found = _owned(db, viewer_id, unseal_target(item.resolution.target), url)
            if found is not None:
                owned[item.resolution.target] = found
    media = [resource_id for scheme, resource_id in owned.values() if scheme == "media"]
    summaries = {
        item.id: item.summary
        for item in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=media
        )
    }
    out = []
    for item in items:
        found = owned.get(getattr(item.resolution, "target", None))
        if found is not None:
            scheme, resource_id = found
            resolution = (
                _in_nexus(resource_id, summaries[resource_id])
                if scheme == "media"
                else InNexusPodcastResolution(
                    href=f"/podcasts/{resource_id}", action_subject_ref=f"podcast:{resource_id}"
                )
            )
            item = item.model_copy(update={"resolution": resolution})
        out.append(item)
    return out


def _owned(
    db: Session, viewer_id: UUID, target: DiscoveryTarget, url: str
) -> tuple[Literal["media", "podcast"], UUID] | None:
    """The viewer's visible media, or subscribed podcast, that is this provider item."""
    params: dict[str, Any] = {"viewer_id": viewer_id}
    match target:
        case ProjectGutenbergEpubTarget(ebook_ref=ref):
            landing = f"https://www.gutenberg.org/ebooks/{ref}"
            sql = _OWNED_BY_URL
            params |= {"kind": "epub", "urls": [landing, f"{landing}.epub.noimages"]}
        case BraveWebArticleTarget(canonical_url=canonical):
            sql = _OWNED_BY_URL
            params |= {
                "kind": "web_article",
                "urls": list(dict.fromkeys([canonical, url or canonical])),
            }
        case YouTubeVideoTarget(video_ref=ref):
            sql = _OWNED_VIDEO
            params["ref"] = ref
        case PodcastIndexPodcastTarget(podcast_ref=ref):
            podcast_id = db.scalar(text(_OWNED_PODCAST), params | {"ref": ref})
            return None if podcast_id is None else ("podcast", podcast_id)
        case PodcastIndexEpisodeTarget(podcast_ref=podcast, episode_ref=episode):
            media_id = select_visible_episode_media_id_by_podcast_index_ref(
                db, viewer_id=viewer_id, podcast_ref=podcast, episode_ref=episode
            )
            return None if media_id is None else ("media", media_id)
    media_id = db.scalar(text(sql), params)
    return None if media_id is None else ("media", media_id)
