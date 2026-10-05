"""Sole DML owner of ``consumption_queue_items``: Lectern membership and order.

Positions are dense ``0..n-1`` over all of a viewer's rows. A row is visible when its media is
visible to the viewer and carries no teardown intent; hidden rows keep their latent slots. Every
write composes inside the caller's viewer-locked transaction and ends with one dense rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.consumption import AfterPlacement, FirstPlacement, Placement

LECTERN_MAX_ITEMS = 2000


@dataclass(frozen=True, slots=True)
class Row:
    item_id: UUID
    media_id: UUID
    kind: str
    position: int
    added_at: datetime
    visible: bool  # media visible to the viewer and no teardown intent


def load(db: Session, *, viewer_id: UUID) -> list[Row]:
    """All of a viewer's rows in order."""
    rows = db.execute(
        text(f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT q.id, q.media_id, m.kind, q.position, q.added_at,
                   (vm.media_id IS NOT NULL AND ti.media_id IS NULL) AS visible
            FROM consumption_queue_items q
            JOIN media m ON m.id = q.media_id
            LEFT JOIN visible_media vm ON vm.media_id = q.media_id
            LEFT JOIN media_teardown_intents ti ON ti.media_id = q.media_id
            WHERE q.user_id = :viewer_id
            ORDER BY q.position, q.added_at, q.id
        """),
        {"viewer_id": viewer_id},
    )
    return [Row(r.id, r.media_id, r.kind, r.position, r.added_at, r.visible) for r in rows]


def place(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], placement: Placement
) -> list[UUID]:
    """Move present rows and insert absent ones as one contiguous block at the visible
    boundary (or after the anchor). Returns the block's item ids in request order."""
    _refuse_tearing_down(db, media_ids)
    rows = load(db, viewer_id=viewer_id)
    existing = {row.media_id: row.item_id for row in rows}
    absent = [media_id for media_id in media_ids if media_id not in existing]
    if len(rows) + len(absent) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    if isinstance(placement, AfterPlacement):
        anchor = next((row for row in rows if row.item_id == placement.item_id), None)
        if anchor is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Anchor item not found")
        if anchor.media_id in media_ids:
            raise InvalidRequestError(message="Anchor is part of the moved block")
        if not anchor.visible:
            raise InvalidRequestError(message="Anchor is not a visible Lectern item")
    inserted = {
        media_id: _insert(db, viewer_id, media_id, len(rows) + offset)
        for offset, media_id in enumerate(absent)
    }
    block = [existing.get(media_id) or inserted[media_id] for media_id in media_ids]
    rest = [row for row in rows if row.item_id not in set(block)]
    visible = [index for index, row in enumerate(rest) if row.visible]
    if isinstance(placement, FirstPlacement):
        at = visible[0] if visible else 0
    elif isinstance(placement, AfterPlacement):
        at = next(i for i, row in enumerate(rest) if row.item_id == placement.item_id) + 1
    else:
        at = visible[-1] + 1 if visible else len(rest)
    ids = [row.item_id for row in rest]
    _write_order(db, viewer_id, ids[:at] + block + ids[at:])
    return block


def remove(db: Session, *, viewer_id: UUID, item_id: UUID) -> bool:
    """Delete one row; False when the viewer has no such row."""
    rows = load(db, viewer_id=viewer_id)
    if not any(row.item_id == item_id for row in rows):
        return False
    _delete(db, viewer_id, item_id, rows)
    return True


def remove_media(db: Session, *, viewer_id: UUID, media_id: UUID) -> int | None:
    """Delete the media's row; the visible index it had, None when it had no visible row."""
    rows = load(db, viewer_id=viewer_id)
    row = next((row for row in rows if row.media_id == media_id), None)
    if row is None:
        return None
    _delete(db, viewer_id, row.item_id, rows)
    visible = [r.item_id for r in rows if r.visible]
    return visible.index(row.item_id) if row.visible else None


def restore(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    item_id: UUID,
    added_at: datetime,
    after: UUID | None,
) -> None:
    """Put a removed row back with its identity, after ``after`` when that is still a visible
    row, else first. Nothing happens when the media is back on the Lectern."""
    rows = load(db, viewer_id=viewer_id)
    if any(row.media_id == media_id for row in rows):
        return
    if len(rows) >= LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    db.execute(
        text("""
            INSERT INTO consumption_queue_items (id, user_id, media_id, position, added_at)
            VALUES (:item_id, :viewer_id, :media_id, :position, :added_at)
        """),
        {"item_id": item_id, "viewer_id": viewer_id, "media_id": media_id}
        | {"position": len(rows), "added_at": added_at},
    )
    anchor = next((i for i, row in enumerate(rows) if row.item_id == after and row.visible), None)
    at = (
        anchor + 1
        if anchor is not None
        else next((i for i, row in enumerate(rows) if row.visible), 0)
    )
    ids = [row.item_id for row in rows]
    _write_order(db, viewer_id, ids[:at] + [item_id] + ids[at:])


def set_order(db: Session, *, viewer_id: UUID, item_ids: list[UUID]) -> None:
    """Permute the visible rows into ``item_ids`` (their exact set); hidden rows keep slots."""
    rows = load(db, viewer_id=viewer_id)
    visible = {row.item_id for row in rows if row.visible}
    if len(set(item_ids)) != len(item_ids) or set(item_ids) != visible:
        raise InvalidRequestError(message="SetOrder requires the exact visible Lectern permutation")
    ordered = iter(item_ids)
    _write_order(db, viewer_id, [next(ordered) if row.visible else row.item_id for row in rows])


def ensure_missing_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[tuple[UUID, UUID]]:
    """Append absent media at the absolute end, never moving present rows; the inserted
    ``(media_id, item_id)`` pairs. The caller holds the viewer lock."""
    media_ids = dedupe(media_ids)
    _refuse_tearing_down(db, media_ids)
    rows = load(db, viewer_id=viewer_id)
    present = {row.media_id for row in rows}
    absent = [media_id for media_id in media_ids if media_id not in present]
    if len(rows) + len(absent) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    return [
        (media_id, _insert(db, viewer_id, media_id, len(rows) + offset))
        for offset, media_id in enumerate(absent)
    ]


def item_ids_for_media(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, UUID]:
    """``media_id -> item_id`` for the media on the viewer's Lectern, in one query."""
    rows = db.execute(
        text("""
            SELECT media_id, id FROM consumption_queue_items
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": dedupe(media_ids)},
    )
    return {row.media_id: row.id for row in rows}


def find_item_for_media(db: Session, *, viewer_id: UUID, media_id: UUID) -> tuple[UUID, str] | None:
    """The viewer's ``(item_id, media title)`` for a media, visible or hidden."""
    row = db.execute(
        text("""
            SELECT q.id, m.title FROM consumption_queue_items q JOIN media m ON m.id = q.media_id
            WHERE q.user_id = :viewer_id AND q.media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    return None if row is None else (row.id, row.title)


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: every viewer's row for the media."""
    db.execute(
        text("DELETE FROM consumption_queue_items WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def dedupe(media_ids: list[UUID]) -> list[UUID]:
    return list(dict.fromkeys(media_ids))


def _refuse_tearing_down(db: Session, media_ids: list[UUID]) -> None:
    if db.scalar(
        text("SELECT EXISTS (SELECT 1 FROM media_teardown_intents WHERE media_id = ANY(:ids))"),
        {"ids": media_ids},
    ):
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted")


def _insert(db: Session, viewer_id: UUID, media_id: UUID, position: int) -> UUID:
    return db.execute(
        text("""
            INSERT INTO consumption_queue_items (user_id, media_id, position)
            VALUES (:viewer_id, :media_id, :position) RETURNING id
        """),
        {"viewer_id": viewer_id, "media_id": media_id, "position": position},
    ).scalar_one()


def _delete(db: Session, viewer_id: UUID, item_id: UUID, rows: list[Row]) -> None:
    db.execute(
        text("DELETE FROM consumption_queue_items WHERE id = :item_id"), {"item_id": item_id}
    )
    _write_order(db, viewer_id, [row.item_id for row in rows if row.item_id != item_id])


def _write_order(db: Session, viewer_id: UUID, item_ids: list[UUID]) -> None:
    """Rewrite positions to the dense order ``item_ids``."""
    db.execute(
        text("""
            UPDATE consumption_queue_items q SET position = o.ord - 1
            FROM unnest(CAST(:ids AS uuid[])) WITH ORDINALITY AS o(id, ord)
            WHERE q.id = o.id AND q.user_id = :viewer_id AND q.position <> o.ord - 1
        """),
        {"ids": [str(item_id) for item_id in item_ids], "viewer_id": viewer_id},
    )
