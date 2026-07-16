"""Sole DML owner of ``consumption_queue_items`` (Lectern membership + order).

Positions are dense integers ``0..n-1`` across ALL of a viewer's rows (visible
and hidden), re-normalized after every membership/order write. A row is visible
when its media is visible to the viewer AND carries no teardown intent; hidden
rows keep latent slots and relative order (spec §5.1). Every mutation composes
inside the caller's already-open, viewer-locked command transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.consumption import AfterPlacement, FirstPlacement, LastPlacement, Placement

# Aggregate row cap enforced on every add/ensure (spec §5.1). Module-level so a
# test may monkeypatch a small ceiling instead of inserting 2,000 rows.
LECTERN_MAX_ITEMS = 2000

LecternSource = Literal["Manual", "Assistant", "AutoSubscription"]

_SOURCE_TO_STORED: dict[LecternSource, str] = {
    "Manual": "manual",
    "Assistant": "assistant",
    "AutoSubscription": "auto_subscription",
}

SUPPORTED_MEDIA_KINDS = frozenset({"podcast_episode", "video", "web_article", "epub", "pdf"})


@dataclass(frozen=True)
class OrderRow:
    """A viewer row's identity, slot, and visibility for placement math."""

    item_id: UUID
    media_id: UUID
    position: int
    visible: bool


@dataclass(frozen=True)
class LecternRow:
    """A viewer row joined to the media metadata the projection needs."""

    item_id: UUID
    media_id: UUID
    position: int
    visible: bool
    kind: str
    title: str
    external_playback_url: str | None
    canonical_source_url: str | None
    provider: str | None
    provider_id: str | None
    podcast_title: str | None
    podcast_image_url: str | None
    duration_seconds: int | None


def load_order_rows(db: Session, *, viewer_id: UUID) -> list[OrderRow]:
    """All of a viewer's rows in canonical order with a visibility flag."""
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
                (vm.media_id IS NOT NULL AND ti.media_id IS NULL) AS visible
            FROM consumption_queue_items q
            LEFT JOIN visible_media vm ON vm.media_id = q.media_id
            LEFT JOIN media_teardown_intents ti ON ti.media_id = q.media_id
            WHERE q.user_id = :viewer_id
            ORDER BY q.position ASC, q.added_at ASC, q.id ASC
            """
        ),
        {"viewer_id": viewer_id},
    ).mappings()
    return [
        OrderRow(
            item_id=UUID(str(row["item_id"])),
            media_id=UUID(str(row["media_id"])),
            position=int(row["position"]),
            visible=bool(row["visible"]),
        )
        for row in rows
    ]


def load_rows(db: Session, *, viewer_id: UUID) -> list[LecternRow]:
    """All of a viewer's rows joined to projection media metadata, in order."""
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
                (vm.media_id IS NOT NULL AND ti.media_id IS NULL) AS visible,
                m.kind,
                m.title,
                m.external_playback_url,
                m.canonical_source_url,
                m.provider,
                m.provider_id,
                p.title AS podcast_title,
                p.image_url AS podcast_image_url,
                pe.duration_seconds
            FROM consumption_queue_items q
            JOIN media m ON m.id = q.media_id
            LEFT JOIN visible_media vm ON vm.media_id = q.media_id
            LEFT JOIN media_teardown_intents ti ON ti.media_id = q.media_id
            LEFT JOIN podcast_episodes pe ON pe.media_id = q.media_id
            LEFT JOIN podcasts p ON p.id = pe.podcast_id
            WHERE q.user_id = :viewer_id
            ORDER BY q.position ASC, q.added_at ASC, q.id ASC
            """
        ),
        {"viewer_id": viewer_id},
    ).mappings()
    return [
        LecternRow(
            item_id=UUID(str(row["item_id"])),
            media_id=UUID(str(row["media_id"])),
            position=int(row["position"]),
            visible=bool(row["visible"]),
            kind=str(row["kind"]),
            title=str(row["title"]),
            external_playback_url=_opt_str(row["external_playback_url"]),
            canonical_source_url=_opt_str(row["canonical_source_url"]),
            provider=_opt_str(row["provider"]),
            provider_id=_opt_str(row["provider_id"]),
            podcast_title=_opt_str(row["podcast_title"]),
            podcast_image_url=_opt_str(row["podcast_image_url"]),
            duration_seconds=int(row["duration_seconds"])
            if row["duration_seconds"] is not None
            else None,
        )
        for row in rows
    ]


def teardown_intent_media(db: Session, *, media_ids: list[UUID]) -> set[UUID]:
    """Which of ``media_ids`` currently carry a teardown intent."""
    if not media_ids:
        return set()
    rows = db.execute(
        text("SELECT media_id FROM media_teardown_intents WHERE media_id = ANY(:media_ids)"),
        {"media_ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])) for row in rows}


def place_items_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
    placement: Placement,
    source: LecternSource,
) -> list[UUID]:
    """Move existing rows and insert absent ones as one contiguous block at the
    requested visible boundary. Returns the placed item ids in requested order."""
    order_rows = load_order_rows(db, viewer_id=viewer_id)
    existing = {row.media_id: row.item_id for row in order_rows}
    new_media = [media_id for media_id in media_ids if media_id not in existing]
    if len(order_rows) + len(new_media) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")

    block_media = set(media_ids)
    anchor_id: UUID | None = None
    if isinstance(placement, AfterPlacement):
        anchor_id = placement.item_id
        anchor_row = next((row for row in order_rows if row.item_id == anchor_id), None)
        if anchor_row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Anchor item not found")
        if anchor_row.media_id in block_media:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Anchor is part of the moved block"
            )
        if not anchor_row.visible:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Anchor is not a visible Lectern item"
            )

    new_item_by_media: dict[UUID, UUID] = {}
    append_base = len(order_rows)
    for offset, media_id in enumerate(new_media):
        new_item_by_media[media_id] = _insert_row(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            position=append_base + offset,
            source=source,
        )

    block_item_ids = [
        existing[media_id] if media_id in existing else new_item_by_media[media_id]
        for media_id in media_ids
    ]
    block_set = set(block_item_ids)
    remaining = [row for row in order_rows if row.item_id not in block_set]

    if isinstance(placement, FirstPlacement):
        insert_index = next((index for index, row in enumerate(remaining) if row.visible), 0)
    elif isinstance(placement, LastPlacement):
        last_visible = None
        for index, row in enumerate(remaining):
            if row.visible:
                last_visible = index
        insert_index = last_visible + 1 if last_visible is not None else len(remaining)
    else:
        insert_index = (
            next(index for index, row in enumerate(remaining) if row.item_id == anchor_id) + 1
        )

    remaining_ids = [row.item_id for row in remaining]
    final = remaining_ids[:insert_index] + block_item_ids + remaining_ids[insert_index:]
    _apply_dense_order(db, viewer_id=viewer_id, ordered_item_ids=final)
    return block_item_ids


def remove_item_in_txn(db: Session, *, viewer_id: UUID, item_id: UUID) -> UUID:
    """Delete one viewer row and re-densify positions. Returns the removed id."""
    row = db.execute(
        text("SELECT id FROM consumption_queue_items WHERE id = :item_id AND user_id = :viewer_id"),
        {"item_id": item_id, "viewer_id": viewer_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Lectern item not found")
    db.execute(
        text("DELETE FROM consumption_queue_items WHERE id = :item_id AND user_id = :viewer_id"),
        {"item_id": item_id, "viewer_id": viewer_id},
    )
    _normalize_positions(db, viewer_id=viewer_id)
    return item_id


def remove_item_if_present_in_txn(db: Session, *, viewer_id: UUID, item_id: UUID) -> UUID | None:
    """Delete one viewer row if it exists (idempotent), re-densifying positions.

    Returns the removed id, or ``None`` when the row is already absent. Used by
    the trusted assistant-undo path, which tolerates a manually removed item."""
    row = db.execute(
        text("SELECT id FROM consumption_queue_items WHERE id = :item_id AND user_id = :viewer_id"),
        {"item_id": item_id, "viewer_id": viewer_id},
    ).fetchone()
    if row is None:
        return None
    db.execute(
        text("DELETE FROM consumption_queue_items WHERE id = :item_id AND user_id = :viewer_id"),
        {"item_id": item_id, "viewer_id": viewer_id},
    )
    _normalize_positions(db, viewer_id=viewer_id)
    return item_id


def find_item_for_media(db: Session, *, viewer_id: UUID, media_id: UUID) -> tuple[UUID, str] | None:
    """The viewer's Lectern ``(item_id, media title)`` for a media (visible or
    hidden), or ``None`` when the media is not on the viewer's Lectern. Used by the
    assistant add tool to echo the resulting row after a trusted ensure."""
    row = db.execute(
        text(
            """
            SELECT q.id, m.title
            FROM consumption_queue_items q
            JOIN media m ON m.id = q.media_id
            WHERE q.user_id = :viewer_id AND q.media_id = :media_id
            ORDER BY q.position ASC
            LIMIT 1
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).fetchone()
    if row is None:
        return None
    return UUID(str(row[0])), str(row[1])


def set_order_in_txn(db: Session, *, viewer_id: UUID, item_ids: list[UUID]) -> None:
    """Permute only the visible rows into the requested order, leaving hidden rows
    in their latent slots. Requires the exact visible permutation."""
    order_rows = load_order_rows(db, viewer_id=viewer_id)
    visible_rows = [row for row in order_rows if row.visible]
    visible_ids = {row.item_id for row in visible_rows}
    if len(set(item_ids)) != len(item_ids) or set(item_ids) != visible_ids:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "SetOrder requires the exact visible Lectern permutation",
        )
    visible_slots = sorted(row.position for row in visible_rows)
    for slot, item_id in zip(visible_slots, item_ids, strict=True):
        db.execute(
            text(
                """
                UPDATE consumption_queue_items
                SET position = :position
                WHERE id = :item_id AND user_id = :viewer_id
                """
            ),
            {"position": slot, "item_id": item_id, "viewer_id": viewer_id},
        )
    _normalize_positions(db, viewer_id=viewer_id)


def ensure_missing_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
    source: LecternSource,
) -> list[tuple[UUID, UUID]]:
    """Append rows for media absent from the viewer's Lectern at the absolute end;
    never move existing rows. Returns the inserted ``(media_id, item_id)`` pairs.

    Any teardown intent rejects the whole batch; exceeding the cap is ``E_LIMIT``.
    Naturally idempotent: the unique membership constraint plus the serializable
    retry allowlist absorb concurrent first-sight races (spec §5.3)."""
    deduped = _dedupe(media_ids)
    intents = teardown_intent_media(db, media_ids=deduped)
    if intents:
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted")
    order_rows = load_order_rows(db, viewer_id=viewer_id)
    existing = {row.media_id for row in order_rows}
    absent = [media_id for media_id in deduped if media_id not in existing]
    if not absent:
        return []
    if len(order_rows) + len(absent) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    append_base = len(order_rows)
    pairs: list[tuple[UUID, UUID]] = []
    for offset, media_id in enumerate(absent):
        item_id = _insert_row(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            position=append_base + offset,
            source=source,
        )
        pairs.append((media_id, item_id))
    return pairs


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's Lectern row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM consumption_queue_items WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def _insert_row(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    position: int,
    source: LecternSource,
) -> UUID:
    item_id = db.execute(
        text(
            """
            INSERT INTO consumption_queue_items (user_id, media_id, position, source, added_at)
            VALUES (:viewer_id, :media_id, :position, :source, now())
            RETURNING id
            """
        ),
        {
            "viewer_id": viewer_id,
            "media_id": media_id,
            "position": position,
            "source": _SOURCE_TO_STORED[source],
        },
    ).scalar_one()
    return UUID(str(item_id))


def _apply_dense_order(db: Session, *, viewer_id: UUID, ordered_item_ids: list[UUID]) -> None:
    if not ordered_item_ids:
        return
    db.execute(
        text(
            """
            UPDATE consumption_queue_items AS q
            SET position = data.ord - 1
            FROM unnest(CAST(:ids AS uuid[])) WITH ORDINALITY AS data(id, ord)
            WHERE q.id = data.id AND q.user_id = :viewer_id
            """
        ),
        {"ids": [str(item_id) for item_id in ordered_item_ids], "viewer_id": viewer_id},
    )


def _normalize_positions(db: Session, *, viewer_id: UUID) -> None:
    db.execute(
        text(
            """
            WITH ordered AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (ORDER BY position ASC, added_at ASC, id ASC) - 1
                        AS new_position
                FROM consumption_queue_items
                WHERE user_id = :viewer_id
            )
            UPDATE consumption_queue_items q
            SET position = ordered.new_position
            FROM ordered
            WHERE q.id = ordered.id
              AND q.position <> ordered.new_position
            """
        ),
        {"viewer_id": viewer_id},
    )


def _dedupe(media_ids: list[UUID]) -> list[UUID]:
    seen: set[UUID] = set()
    result: list[UUID] = []
    for media_id in media_ids:
        if media_id in seen:
            continue
        seen.add(media_id)
        result.append(media_id)
    return result


def _opt_str(value: object) -> str | None:
    return str(value) if value is not None else None
