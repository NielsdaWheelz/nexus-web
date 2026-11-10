"""Feed observations enter the ordinary article/source-attempt owner.

Artifact bytes precede admission. Catalogue authority never grants a private
capture's body; existing canonical media may be reused only by its readers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import TYPE_CHECKING, Literal
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_acquire_feed_media, can_read_media, feed_catalog_ids_sql
from nexus.db.models import Media, MediaSourceAttempt, ProcessingStatus, ReaderPublication
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.ids import new_uuid7
from nexus.services import media_locks, source_attempts, source_types
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path

if TYPE_CHECKING:
    from nexus.services.feeds.parsing import ArticleFacts


class FeedArticlePacket(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    entry_url: str | None
    base_url: str
    body_html: str | None
    body_kind: Literal["content", "summary", "none"]
    published_at: datetime | None
    published_on: date | None
    authors: list[str]


@dataclass(frozen=True)
class PreparedFeedArticle:
    media_id: UUID
    attempt_id: UUID
    storage_path: str


@dataclass(frozen=True)
class ObservedFeedArticle:
    media_id: UUID
    deferred: bool


def prepare_article(facts: ArticleFacts) -> PreparedFeedArticle:
    """One immutable artifact, prepared outside the source publication transaction."""
    media_id, attempt_id = new_uuid7(), new_uuid7()
    path = build_source_artifact_storage_path(media_id, attempt_id, "feed.json")
    packet = FeedArticlePacket(
        title=facts.title,
        entry_url=facts.entry_url,
        base_url=facts.base_url,
        body_html=facts.body_html,
        body_kind=facts.body_kind,
        published_at=facts.published_at,
        published_on=facts.published_on,
        authors=facts.authors,
    )
    get_storage_client().put_object(path, packet.model_dump_json().encode(), "application/json")
    return PreparedFeedArticle(media_id, attempt_id, path)


def observe(
    db: Session,
    *,
    feed_id: UUID,
    entry_id: UUID,
    facts: ArticleFacts,
    prepared: PreparedFeedArticle,
    existing_media_id: UUID | None,
    actor_id: UUID | None,
) -> ObservedFeedArticle:
    """Observe under the caller's ordered source-identity and canonical-media locks."""
    if actor_id is None:
        raise ApiError(
            ApiErrorCode.E_FEED_PRIVATE_SOURCE, "This source has no authorized acquiring account."
        )
    url = None
    if facts.entry_url is not None:
        validate_requested_url(facts.entry_url)
        url = normalize_url_for_display(facts.entry_url)
    media = db.get(Media, existing_media_id) if existing_media_id is not None else None
    if media is None and url is not None:
        media = db.scalar(
            select(Media).where(Media.kind == "web_article", Media.canonical_url == url)
        )
    if media is None:
        media = Media(
            id=prepared.media_id,
            kind="web_article",
            title=facts.title[:255],
            requested_url=url,
            canonical_url=url,
            canonical_source_url=url,
            processing_status=ProcessingStatus.pending,
            created_by_user_id=actor_id,
        )
        db.add(media)
        db.flush()
    else:
        # Delivery must not manufacture authority for any current recipient.
        viewers = set(
            db.scalars(
                text("""
            SELECT user_id FROM feed_catalog_access WHERE feed_id=:feed
            UNION SELECT m.user_id FROM library_feed_subscriptions s
                JOIN memberships m ON m.library_id=s.library_id WHERE s.feed_id=:feed
            UNION SELECT m.user_id FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
                JOIN memberships m ON m.library_id=i.library_id WHERE r.feed_id=:feed
                  AND r.completed_at IS NULL AND r.cancelled_at IS NULL
        """),
                {"feed": feed_id},
            )
        ) | {actor_id}
        if any(not can_read_media(db, viewer, media.id) for viewer in viewers):
            raise ApiError(
                ApiErrorCode.E_FEED_PRIVATE_SOURCE,
                "This entry matches content unavailable to this source's readers.",
            )
        publication = db.scalar(
            select(ReaderPublication).where(ReaderPublication.media_id == media.id)
        )
        if publication is not None:
            attempt = (
                db.get(MediaSourceAttempt, publication.source_attempt_id)
                if publication.source_attempt_id
                else None
            )
            # A feed can revise its own full post, but cannot demote it to an excerpt.
            incoming_complete = facts.body_kind == "content" and facts.entry_url is None
            if (
                attempt is None
                or attempt.source_type != source_types.FEED_ENTRY
                or (
                    attempt.source_payload.get("feed_id") != str(feed_id)
                    or attempt.source_payload.get("entry_id") != str(entry_id)
                    or (publication.content_extent == "complete" and not incoming_complete)
                )
            ):
                return ObservedFeedArticle(media.id, deferred=False)
        latest = source_attempts.latest_attempt(db, media.id, lock=False)
        if (
            latest is not None
            and latest.status in source_types.IN_FLIGHT
            and not (
                facts.body_html
                and latest.source_type == source_types.FEED_ENTRY
                and latest.source_payload.get("feed_id") == str(feed_id)
                and latest.source_payload.get("entry_id") == str(entry_id)
            )
        ):
            # Another source keeps its authority. Do not consume this observation:
            # a later feed check can admit it once that attempt has settled.
            return ObservedFeedArticle(media.id, deferred=True)
        # A newer body from this exact entry supersedes its older attempt through
        # the ordinary latest-attempt publication fence.
    attempt = source_attempts.create_attempt(
        db,
        id=prepared.attempt_id,
        media=media,
        actor_id=actor_id,
        source_type=source_types.FEED_ENTRY,
        requested_url=url,
        canonical_source_url=url,
        provider=None,
        provider_target_ref=None,
        payload={
            "feed_id": str(feed_id),
            "entry_id": str(entry_id),
            "storage_path": prepared.storage_path,
        },
    )
    source_attempts.enqueue_attempt(db, attempt, actor_id=actor_id, request_id=None)
    return ObservedFeedArticle(media.id, deferred=False)


def enqueue_linked_articles(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], edition_id: UUID
) -> None:
    """Queue at most the edition's five nominations; ranking never waits on extraction."""
    assert len(media_ids) <= 5
    media_locks.lock_media_rows_in_order(db, media_ids)
    for media_id in sorted(set(media_ids)):
        enqueue_linked_article(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            attempt_id=uuid5(edition_id, str(media_id)),
            edition_id=edition_id,
        )


def enqueue_linked_article(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    attempt_id: UUID,
    edition_id: UUID | None = None,
) -> UUID | None:
    feed_access = can_acquire_feed_media(db, viewer_id, media_id)
    manual_access = (
        edition_id is not None
        and can_read_media(db, viewer_id, media_id)
        and bool(
            db.scalar(
                text("""SELECT d.manually_saved FROM viewer_media_discoveries d
                    JOIN media m ON m.id=d.media_id AND m.kind='web_article'
                    WHERE d.user_id=:viewer AND d.media_id=:media"""),
                {"viewer": viewer_id, "media": media_id},
            )
        )
    )
    if not feed_access and not manual_access:
        return None
    media_locks.lock_media_rows_in_order(db, [media_id])
    publication = db.scalar(select(ReaderPublication).where(ReaderPublication.media_id == media_id))
    if publication is not None and publication.content_extent == "complete":
        return None
    latest = source_attempts.latest_attempt(db, media_id, lock=False)
    if latest is not None and latest.status in source_types.IN_FLIGHT:
        return latest.id
    row = db.execute(
        text(f"""
        SELECT id,feed_id,entry_url FROM feed_entries WHERE media_id=:media
          AND entry_url IS NOT NULL AND feed_id IN ({feed_catalog_ids_sql()})
        ORDER BY first_seen_at,id LIMIT 1
    """),
        {"media": media_id, "viewer_id": viewer_id},
    ).first()
    if db.get(MediaSourceAttempt, attempt_id) is not None:
        return attempt_id
    media = db.get(Media, media_id)
    assert media is not None
    url = row.entry_url if row is not None else media.canonical_source_url or media.requested_url
    if url is None or (row is None and not manual_access):
        return None
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return None
    payload: dict[str, object] = (
        {} if row is None else {"feed_id": str(row.feed_id), "entry_id": str(row.id)}
    )
    if edition_id is not None:
        payload["daily_edition_id"] = str(edition_id)
    attempt = source_attempts.create_attempt(
        db,
        id=attempt_id,
        media=media,
        actor_id=viewer_id,
        source_type=source_types.GENERIC_WEB_URL,
        requested_url=url,
        canonical_source_url=url,
        provider=None,
        provider_target_ref=None,
        payload=payload,
    )
    source_attempts.enqueue_attempt(db, attempt, actor_id=viewer_id, request_id=None)
    return attempt.id
