"""Playback queue service-layer logic."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.db.models import PlaybackQueueItem
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.playback import (
    PlaybackQueueAddRequest,
    PlaybackQueueItemOut,
    PlaybackQueueOrderRequest,
)
from nexus.services.playback_source import derive_playback_source
from nexus.services.search import visible_media_ids_cte_sql

QUEUE_SOURCE_MANUAL = "manual"
QUEUE_SOURCE_AUTO_SUBSCRIPTION = "auto_subscription"
QUEUE_SOURCE_AUTO_PLAYLIST = "auto_playlist"
QUEUE_SOURCES = {
    QUEUE_SOURCE_MANUAL,
    QUEUE_SOURCE_AUTO_SUBSCRIPTION,
    QUEUE_SOURCE_AUTO_PLAYLIST,
}


def list_queue_for_viewer(db: Session, viewer_id: UUID) -> list[PlaybackQueueItemOut]:
    """Return the ordered playback queue for a viewer."""
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT
                q.id AS item_id,
                q.media_id,
                q.position,
                q.added_at,
                q.source,
                m.title,
                m.kind,
                m.external_playback_url,
                m.canonical_source_url,
                m.provider,
                m.provider_id,
                p.title AS podcast_title,
                pe.duration_seconds,
                pls.position_ms AS listening_position_ms,
                pls.playback_speed AS listening_playback_speed,
                ps.default_playback_speed AS subscription_default_playback_speed
            FROM playback_queue_items q
            JOIN visible_media vm ON vm.media_id = q.media_id
            JOIN media m ON m.id = q.media_id
            LEFT JOIN podcast_episodes pe ON pe.media_id = q.media_id
            LEFT JOIN podcasts p ON p.id = pe.podcast_id
            LEFT JOIN podcast_subscriptions ps
              ON ps.user_id = :viewer_id
             AND ps.podcast_id = pe.podcast_id
             AND ps.status = 'active'
            LEFT JOIN podcast_listening_states pls
              ON pls.user_id = :viewer_id
             AND pls.media_id = q.media_id
            WHERE q.user_id = :viewer_id
            ORDER BY q.position ASC, q.added_at ASC, q.id ASC
            """
        ),
        {"viewer_id": viewer_id},
    ).mappings()
    queue_items: list[PlaybackQueueItemOut] = []
    for row in rows:
        item = _row_to_queue_item(row)
        if item is not None:
            queue_items.append(item)
    return queue_items


def add_queue_items_for_viewer(
    db: Session,
    viewer_id: UUID,
    body: PlaybackQueueAddRequest,
) -> list[PlaybackQueueItemOut]:
    """Insert one or more media rows into the viewer queue."""
    normalized_media_ids = _dedupe_media_ids(body.media_ids)
    _assert_media_ids_queueable(db, viewer_id, normalized_media_ids)

    with transaction(db):
        _insert_media_ids_for_viewer(
            db=db,
            viewer_id=viewer_id,
            media_ids=normalized_media_ids,
            insert_position=body.insert_position,
            current_media_id=body.current_media_id,
            source=QUEUE_SOURCE_MANUAL,
        )
        _normalize_queue_positions(db, viewer_id)
    return list_queue_for_viewer(db, viewer_id)


def remove_queue_item_for_viewer(
    db: Session,
    viewer_id: UUID,
    item_id: UUID,
) -> list[PlaybackQueueItemOut]:
    """Delete one queue item and close any position gap."""
    with transaction(db):
        deleted_row = db.execute(
            text(
                """
                DELETE FROM playback_queue_items
                WHERE id = :item_id
                  AND user_id = :viewer_id
                RETURNING position
                """
            ),
            {"item_id": item_id, "viewer_id": viewer_id},
        ).fetchone()
        if deleted_row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Queue item not found")

        deleted_position = int(deleted_row[0])
        db.execute(
            text(
                """
                UPDATE playback_queue_items
                SET position = position - 1
                WHERE user_id = :viewer_id
                  AND position > :deleted_position
                """
            ),
            {"viewer_id": viewer_id, "deleted_position": deleted_position},
        )
        _normalize_queue_positions(db, viewer_id)
    return list_queue_for_viewer(db, viewer_id)


def reorder_queue_for_viewer(
    db: Session,
    viewer_id: UUID,
    body: PlaybackQueueOrderRequest,
) -> list[PlaybackQueueItemOut]:
    """Reorder queue rows using a full item-id order payload."""
    requested_ids = [UUID(str(item_id)) for item_id in body.item_ids]
    if len(set(requested_ids)) != len(requested_ids):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Queue order contains duplicates")

    existing_ids = [
        row[0]
        for row in db.execute(
            text(
                """
                SELECT id
                FROM playback_queue_items
                WHERE user_id = :viewer_id
                ORDER BY position ASC, id ASC
                """
            ),
            {"viewer_id": viewer_id},
        ).fetchall()
    ]
    if len(existing_ids) != len(requested_ids) or set(existing_ids) != set(requested_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Queue reorder requires an exact full set of viewer item IDs",
        )

    with transaction(db):
        for position, item_id in enumerate(requested_ids):
            db.execute(
                text(
                    """
                    UPDATE playback_queue_items
                    SET position = :position
                    WHERE id = :item_id
                      AND user_id = :viewer_id
                    """
                ),
                {"position": position, "item_id": item_id, "viewer_id": viewer_id},
            )
        _normalize_queue_positions(db, viewer_id)
    return list_queue_for_viewer(db, viewer_id)


def clear_queue_for_viewer(db: Session, viewer_id: UUID) -> list[PlaybackQueueItemOut]:
    """Remove all queue rows for the viewer."""
    with transaction(db):
        db.execute(
            text("DELETE FROM playback_queue_items WHERE user_id = :viewer_id"),
            {"viewer_id": viewer_id},
        )
    return []


def get_next_queue_item_for_viewer(
    db: Session,
    viewer_id: UUID,
    current_media_id: UUID,
) -> PlaybackQueueItemOut | None:
    """Return the next queued item after the current media item."""
    queue_items = list_queue_for_viewer(db, viewer_id)
    if not queue_items:
        return None

    current_index = next(
        (index for index, item in enumerate(queue_items) if item.media_id == current_media_id),
        None,
    )
    if current_index is None:
        return queue_items[0]
    if current_index + 1 >= len(queue_items):
        return None
    return queue_items[current_index + 1]


def append_subscription_media_if_enabled(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    media_ids: list[UUID],
) -> None:
    """Append synced episodes to queue when subscription auto_queue is enabled."""
    if not media_ids:
        return

    row = db.execute(
        text(
            """
            SELECT auto_queue
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id
              AND podcast_id = :podcast_id
              AND status = 'active'
            """
        ),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None or not bool(row[0]):
        return

    normalized_media_ids = _dedupe_media_ids(media_ids)
    _insert_media_ids_for_viewer(
        db=db,
        viewer_id=viewer_id,
        media_ids=normalized_media_ids,
        insert_position="last",
        current_media_id=None,
        source=QUEUE_SOURCE_AUTO_SUBSCRIPTION,
    )
    _normalize_queue_positions(db, viewer_id)


def _row_to_queue_item(row: dict[str, object]) -> PlaybackQueueItemOut | None:
    playback_source = derive_playback_source(
        kind=str(row["kind"]),
        external_playback_url=str(row["external_playback_url"])
        if row["external_playback_url"] is not None
        else None,
        canonical_source_url=str(row["canonical_source_url"])
        if row["canonical_source_url"] is not None
        else None,
        provider=str(row["provider"]) if row["provider"] is not None else None,
        provider_id=str(row["provider_id"]) if row["provider_id"] is not None else None,
    )
    if playback_source is None:
        return None

    listening_state = None
    if row["listening_position_ms"] is not None and row["listening_playback_speed"] is not None:
        listening_state = {
            "position_ms": int(row["listening_position_ms"]),
            "playback_speed": float(row["listening_playback_speed"]),
        }

    return PlaybackQueueItemOut(
        item_id=row["item_id"],
        media_id=row["media_id"],
        title=str(row["title"]),
        podcast_title=str(row["podcast_title"]) if row["podcast_title"] is not None else None,
        duration_seconds=int(row["duration_seconds"])
        if row["duration_seconds"] is not None
        else None,
        stream_url=playback_source.stream_url,
        source_url=playback_source.source_url,
        position=int(row["position"]),
        source=str(row["source"]),
        added_at=row["added_at"],
        listening_state=listening_state,
        subscription_default_playback_speed=float(row["subscription_default_playback_speed"])
        if row["subscription_default_playback_speed"] is not None
        else None,
    )


def _dedupe_media_ids(media_ids: list[UUID]) -> list[UUID]:
    seen: set[UUID] = set()
    deduped: list[UUID] = []
    for media_id in media_ids:
        normalized = UUID(str(media_id))
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _assert_media_ids_queueable(db: Session, viewer_id: UUID, media_ids: list[UUID]) -> None:
    for media_id in media_ids:
        if not _can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        row = (
            db.execute(
                text(
                    """
                SELECT kind, external_playback_url, canonical_source_url, provider, provider_id
                FROM media
                WHERE id = :media_id
                """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        playback_source = derive_playback_source(
            kind=str(row["kind"]),
            external_playback_url=str(row["external_playback_url"])
            if row["external_playback_url"] is not None
            else None,
            canonical_source_url=str(row["canonical_source_url"])
            if row["canonical_source_url"] is not None
            else None,
            provider=str(row["provider"]) if row["provider"] is not None else None,
            provider_id=str(row["provider_id"]) if row["provider_id"] is not None else None,
        )
        if playback_source is None:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Media is not queueable")


def _insert_media_ids_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
    insert_position: str,
    current_media_id: UUID | None,
    source: str,
) -> None:
    if source not in QUEUE_SOURCES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid queue source")
    if insert_position not in {"next", "last"}:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid queue insert position")
    if not media_ids:
        return

    existing_media_ids = {
        row[0]
        for row in db.execute(
            text(
                """
                SELECT media_id
                FROM playback_queue_items
                WHERE user_id = :viewer_id
                  AND media_id = ANY(:media_ids)
                """
            ),
            {"viewer_id": viewer_id, "media_ids": media_ids},
        ).fetchall()
    }
    to_insert = [media_id for media_id in media_ids if media_id not in existing_media_ids]
    if not to_insert:
        return

    if insert_position == "next":
        next_position = _resolve_next_insert_position(db, viewer_id, current_media_id)
        db.execute(
            text(
                """
                UPDATE playback_queue_items
                SET position = position + :shift
                WHERE user_id = :viewer_id
                  AND position >= :next_position
                """
            ),
            {
                "viewer_id": viewer_id,
                "next_position": next_position,
                "shift": len(to_insert),
            },
        )
        start_position = next_position
    else:
        start_position = _next_append_position(db, viewer_id)

    now = datetime.now(UTC)
    for offset, media_id in enumerate(to_insert):
        db.add(
            PlaybackQueueItem(
                user_id=viewer_id,
                media_id=media_id,
                position=start_position + offset,
                source=source,
                added_at=now,
            )
        )
    # Ensure newly added ORM rows participate in subsequent SQL reindexing.
    db.flush()


def _resolve_next_insert_position(
    db: Session,
    viewer_id: UUID,
    current_media_id: UUID | None,
) -> int:
    if current_media_id is None:
        return 0
    row = db.execute(
        text(
            """
            SELECT position
            FROM playback_queue_items
            WHERE user_id = :viewer_id
              AND media_id = :current_media_id
            LIMIT 1
            """
        ),
        {"viewer_id": viewer_id, "current_media_id": current_media_id},
    ).fetchone()
    if row is None:
        return 0
    return int(row[0]) + 1


def _next_append_position(db: Session, viewer_id: UUID) -> int:
    next_position = db.execute(
        text(
            """
            SELECT COALESCE(MAX(position), -1) + 1
            FROM playback_queue_items
            WHERE user_id = :viewer_id
            """
        ),
        {"viewer_id": viewer_id},
    ).scalar()
    if next_position is None:
        return 0
    return int(next_position)


def _normalize_queue_positions(db: Session, viewer_id: UUID) -> None:
    db.execute(
        text(
            """
            WITH ordered AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (ORDER BY position ASC, added_at ASC, id ASC) - 1 AS new_position
                FROM playback_queue_items
                WHERE user_id = :viewer_id
            )
            UPDATE playback_queue_items q
            SET position = ordered.new_position
            FROM ordered
            WHERE q.id = ordered.id
              AND q.position <> ordered.new_position
            """
        ),
        {"viewer_id": viewer_id},
    )
