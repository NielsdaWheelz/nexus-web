"""Canonical source identity and explicit catalogue admission, without holdings."""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas import feed as wire
from nexus.services.browse.targets import ResolvedPodcast
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributor_writes import PodcastTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.podcasts.provider import PROVIDER
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .parsing import BlockedFeedPage, FeedLinks, FeedPage, FeedPageRejected, fetch_page


@dataclass(frozen=True, slots=True)
class ResolvedFeed:
    kind: Literal["podcast", "article"]
    requested_url: str
    feed_url: str
    title: str
    website_url: str | None
    image_url: str | None
    description: str | None
    provider: str | None = None
    provider_podcast_id: str | None = None
    author: str | None = None


def validate_and_normalize_feed_url(url: str) -> str:
    validate_requested_url(url)
    return normalize_url_for_display(url)


def from_podcast(show: ResolvedPodcast) -> ResolvedFeed:
    return ResolvedFeed(
        "podcast",
        show.feed_url,
        show.feed_url,
        show.title,
        show.website_url,
        show.image_url,
        show.description,
        PROVIDER,
        show.podcast_ref,
        show.author,
    )


def resolve_url(
    url: str, selected_kind: wire.FeedKind | None
) -> ResolvedFeed | wire.FeedChooseUrlOut | wire.FeedChooseKindOut:
    page = fetch_page(url, kind=selected_kind)
    if isinstance(page, FeedLinks):
        if len(page.choices) != 1:
            return wire.FeedChooseUrlOut(
                choices=[
                    wire.FeedUrlChoiceOut(title=title, url=href) for title, href in page.choices
                ]
            )
        url = page.choices[0][1]
        page = fetch_page(url, kind=selected_kind)
    if isinstance(page, BlockedFeedPage):
        raise InvalidRequestError(ApiErrorCode.E_SSRF_BLOCKED, "Feed address cannot be fetched")
    if not isinstance(page, FeedPage):
        raise FeedPageRejected()
    if page.kind is None:
        return wire.FeedChooseKindOut(url=page.final_url, choices=["podcast", "article"])
    return ResolvedFeed(
        page.kind,
        page.requested_url,
        page.final_url,
        page.title,
        page.website_url,
        page.image_url,
        page.description,
    )


def lock_source_identity(db: Session, source: ResolvedFeed) -> list[str]:
    """Lock resolved URL/provider identities before any source row; return normalized URLs."""
    urls = sorted(
        {
            validate_and_normalize_feed_url(source.requested_url),
            validate_and_normalize_feed_url(source.feed_url),
        }
    )
    keys = [f"feed-url:{url}" for url in urls]
    if source.provider is not None:
        keys.append(f"feed-provider:{source.provider}:{source.provider_podcast_id}")
    for key in sorted(keys):
        db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"), {"key": key})
    return urls


def adopt_resolved(db: Session, viewer_id: UUID | None, source: ResolvedFeed) -> UUID:
    """Caller owns transaction; explicit viewers gain source access, never a holding."""
    urls = lock_source_identity(db, source)
    ids = set(
        db.scalars(
            text("SELECT feed_id FROM feed_url_aliases WHERE url=ANY(:urls)"), {"urls": urls}
        )
    )
    if source.provider is not None:
        provider_id = db.scalar(
            text("SELECT id FROM feeds WHERE provider=:provider AND provider_podcast_id=:ref"),
            {"provider": source.provider, "ref": source.provider_podcast_id},
        )
        if provider_id is not None:
            ids.add(provider_id)
    if len(ids) > 1:
        raise ConflictError(
            ApiErrorCode.E_FEED_IDENTITY_CONFLICT, "Feed addresses name conflicting sources"
        )
    params = {
        "kind": source.kind,
        "provider": source.provider,
        "ref": source.provider_podcast_id,
        "title": source.title,
        "url": validate_and_normalize_feed_url(source.feed_url),
        "website": source.website_url,
        "image": source.image_url,
        "description": source.description,
    }
    if ids:
        feed_id = ids.pop()
        current = db.execute(
            text("SELECT kind,provider,provider_podcast_id FROM feeds WHERE id=:id FOR UPDATE"),
            {"id": feed_id},
        ).one()
        if current.kind != source.kind or (
            source.provider is not None
            and current.provider is not None
            and (
                current.provider != source.provider
                or current.provider_podcast_id != source.provider_podcast_id
            )
        ):
            raise ConflictError(ApiErrorCode.E_FEED_IDENTITY_CONFLICT, "Feed identity changed")
        db.execute(
            text("""UPDATE feeds SET title=:title,feed_url=:url,
            provider=COALESCE(provider,:provider),provider_podcast_id=COALESCE(provider_podcast_id,:ref),
            website_url=COALESCE(:website,website_url),image_url=COALESCE(:image,image_url),
            description=COALESCE(:description,description),updated_at=now() WHERE id=:id"""),
            {**params, "id": feed_id},
        )
    else:
        feed_id = db.scalar(
            text("""INSERT INTO feeds(kind,provider,provider_podcast_id,title,feed_url,website_url,image_url,description)
            VALUES (:kind,:provider,:ref,:title,:url,:website,:image,:description) RETURNING id"""),
            params,
        )
        assert feed_id is not None
    db.execute(
        text(
            "INSERT INTO feed_url_aliases(url,feed_id) SELECT unnest(CAST(:urls AS text[])),:id ON CONFLICT (url) DO NOTHING"
        ),
        {"urls": urls, "id": feed_id},
    )
    if viewer_id is not None:
        db.execute(
            text(
                "INSERT INTO feed_catalog_access(feed_id,user_id) VALUES (:id,:viewer) ON CONFLICT DO NOTHING"
            ),
            {"id": feed_id, "viewer": viewer_id},
        )
    if source.kind == "podcast":
        if source.author:
            observation, _ = build_observation(
                {"author": [RawCreditEntry(credited_name=source.author)]}
            )
            apply_observed_role_slices_in_current_transaction(
                db,
                target=PodcastTarget(feed_id),
                observation=observation,
                source=source.provider or "rss",
            )
        projection.refresh(db, "podcast", [feed_id])
    record_input_change(
        db, owners=(f"{'podcast' if source.kind == 'podcast' else 'feed'}:{feed_id}",)
    )
    return feed_id


def resolve_feed(
    db: Session, viewer_id: UUID, body: wire.FeedResolveRequest
) -> wire.FeedResolveOut:
    if isinstance(body, wire.FeedUrlResolveRequest):
        resolved = resolve_url(body.url, body.selected_kind)
        if not isinstance(resolved, ResolvedFeed):
            return resolved
    else:
        from nexus.services.browse.service import resolve_podcast_discovery_target

        show = resolve_podcast_discovery_target(body.target)
        if not isinstance(show, ResolvedPodcast):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast"
            )
        resolved = from_podcast(show)

    def admit() -> UUID:
        from .sync import admit_head

        feed_id = adopt_resolved(db, viewer_id, resolved)
        admit_head(db, feed_id=feed_id)
        return feed_id

    feed_id = retry_serializable(db, "resolve_feed", admit)
    return wire.FeedResolvedOut(
        feed_id=feed_id,
        kind=resolved.kind,
        href=f"/{'podcasts' if resolved.kind == 'podcast' else 'feeds'}/{feed_id}",
    )
