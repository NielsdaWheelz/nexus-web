"""Sole DML owner of ``consumption_queue_items``: the Lectern, the viewer's ordered intentions.

One row per viewer and media; positions are dense ``0..n-1`` over all of a viewer's rows. A row
is visible when its media is visible to the viewer and has no teardown intent; hidden rows keep
their slots and count toward the cap (I1): a placement permutes the visible rows through the
visible slots, and a new row takes a new last slot. Writes are absolute: placing a media puts it
where asked whether or not it was there, removing an absent media succeeds.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas import consumption as wire
from nexus.services.consumption import lock_viewer, projection, viewer_txn

LECTERN_MAX_ITEMS = 2000
_READABLE = frozenset({"web_article", "epub", "pdf"})


@dataclass(frozen=True, slots=True)
class _Row:
    item_id: UUID
    media_id: UUID
    kind: str
    added_at: datetime
    visible: bool


def get_lectern(db: Session, viewer_id: UUID) -> wire.LecternOut:
    """The visible rows in order, each with its summary and how it activates; capacity counts
    every row."""
    from nexus.services.media import media_summaries

    membership = _load(db, viewer_id)
    rows = [row for row in membership if row.visible]
    media_ids = [row.media_id for row in rows]
    summaries = media_summaries(db, viewer_id=viewer_id, media_ids=media_ids)
    descriptors = projection.player_descriptors(db, viewer_id=viewer_id, media_ids=media_ids)
    return wire.LecternOut(
        items=[
            wire.LecternItemOut(
                media_summary=summaries[row.media_id],
                added_at=row.added_at,
                activation=wire.FooterAudioActivation(
                    kind="FooterAudio", descriptor=descriptors[row.media_id]
                )
                if row.media_id in descriptors
                else wire.ReadableActivation(kind="Readable")
                if row.kind in _READABLE
                else wire.OpenPaneActivation(kind="OpenPane"),
            )
            for row in rows
        ],
        at_capacity=len(membership) >= LECTERN_MAX_ITEMS,
    )


def place(viewer_id: UUID, media_id: UUID, placement: wire.Placement | None) -> None:
    """Put the media first or after another media's visible row (first when that row is absent or
    hidden), inserting it when absent. A null placement only ensures membership: an absent media
    takes the last slot, a present row stays where it is."""

    def run(db: Session) -> None:
        # Tearing-down targets stay readable here so they answer E_MEDIA_DELETING (I2).
        if not can_read_media(db, viewer_id, media_id, include_tearing_down=True):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
        if isinstance(placement, wire.AfterPlacement) and placement.media_id == media_id:
            raise InvalidRequestError(message="A media cannot be placed after itself")
        _refuse_tearing_down(db, [media_id])
        rows = _load(db, viewer_id)
        item_id = next((row.item_id for row in rows if row.media_id == media_id), None)
        if item_id is None:
            if len(rows) >= LECTERN_MAX_ITEMS:
                raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
            item_id = _insert(db, viewer_id, media_id, len(rows))
        if placement is not None:
            others = [row.media_id for row in rows if row.visible and row.media_id != media_id]
            at = (
                others.index(placement.media_id) + 1
                if isinstance(placement, wire.AfterPlacement) and placement.media_id in others
                else 0
            )
            _place_visible(db, viewer_id, rows, item_id, at)
        db.commit()

    viewer_txn("lectern_place", viewer_id, run)


def remove(viewer_id: UUID, media_id: UUID) -> None:
    def run(db: Session) -> None:
        remove_media_in_txn(db, viewer_id=viewer_id, media_id=media_id)
        db.commit()

    viewer_txn("lectern_remove", viewer_id, run)


def has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the whole membership, hidden rows included, is below the cap."""
    count = db.scalar(
        text("SELECT count(*) FROM consumption_queue_items WHERE user_id = :viewer_id"),
        {"viewer_id": viewer_id},
    )
    return count < LECTERN_MAX_ITEMS


def remove_media_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> wire.RemovedItem | None:
    """Delete the media's row; what an undo needs to put it back (its id, added time and the
    visible row before it), None when it had no row."""
    rows = _load(db, viewer_id)
    index = next((i for i, row in enumerate(rows) if row.media_id == media_id), None)
    if index is None:
        return None
    row = rows[index]
    _delete(db, viewer_id, row.item_id, rows)
    before = [r for r in rows[:index] if r.visible]
    return wire.RemovedItem(
        item_id=row.item_id,
        added_at=row.added_at,
        after_item_id=before[-1].item_id if before else None,
    )


def restore_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, removed: wire.RemovedItem
) -> None:
    """Put a removed row back with its id and added time, after its former predecessor while
    that is a visible row, else first. Nothing happens when the media is back on the Lectern."""
    rows = _load(db, viewer_id)
    if any(row.media_id == media_id for row in rows):
        return
    if len(rows) >= LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    db.execute(
        text("""
            INSERT INTO consumption_queue_items (id, user_id, media_id, position, added_at)
            VALUES (:item_id, :viewer_id, :media_id, :position, :added_at)
        """),
        {"item_id": removed.item_id, "viewer_id": viewer_id, "media_id": media_id}
        | {"position": len(rows), "added_at": removed.added_at},
    )
    others = [row.item_id for row in rows if row.visible]
    at = next((i + 1 for i, item_id in enumerate(others) if item_id == removed.after_item_id), 0)
    _place_visible(db, viewer_id, rows, removed.item_id, at)


def append_missing_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[tuple[UUID, UUID]]:
    """Append absent media at the absolute end without moving present rows, in the caller's
    transaction (the assistant, podcast sync); the inserted ``(media_id, item_id)`` pairs."""
    lock_viewer(db, viewer_id)
    media_ids = list(dict.fromkeys(media_ids))
    _refuse_tearing_down(db, media_ids)
    rows = _load(db, viewer_id)
    present = {row.media_id for row in rows}
    absent = [media_id for media_id in media_ids if media_id not in present]
    if len(rows) + len(absent) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    return [
        (media_id, _insert(db, viewer_id, media_id, len(rows) + offset))
        for offset, media_id in enumerate(absent)
    ]


def remove_item_in_txn(db: Session, *, viewer_id: UUID, item_id: UUID) -> None:
    """The assistant's undo, in the caller's transaction; an absent row is fine."""
    lock_viewer(db, viewer_id)
    rows = _load(db, viewer_id)
    if any(row.item_id == item_id for row in rows):
        _delete(db, viewer_id, item_id, rows)


def item_ids_for_media(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, UUID]:
    rows = db.execute(
        text("""
            SELECT media_id, id FROM consumption_queue_items
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: row.id for row in rows}


def find_item_for_media(db: Session, *, viewer_id: UUID, media_id: UUID) -> tuple[UUID, str] | None:
    """The viewer's ``(item_id, media title)``, visible or hidden."""
    row = db.execute(
        text("""
            SELECT q.id, m.title FROM consumption_queue_items q JOIN media m ON m.id = q.media_id
            WHERE q.user_id = :viewer_id AND q.media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    return None if row is None else (row.id, row.title)


def membership_rows_sql() -> str:
    """The whole membership, hidden rows included. Binds ``:viewer_id``."""
    return "SELECT media_id FROM consumption_queue_items WHERE user_id = :viewer_id"


def _load(db: Session, viewer_id: UUID) -> list[_Row]:
    rows = db.execute(
        text(f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT q.id, q.media_id, m.kind, q.added_at,
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
    return [_Row(r.id, r.media_id, r.kind, r.added_at, r.visible) for r in rows]


def _refuse_tearing_down(db: Session, media_ids: list[UUID]) -> None:
    if db.scalar(
        text("SELECT EXISTS (SELECT 1 FROM media_teardown_intents WHERE media_id = ANY(:ids))"),
        {"ids": media_ids},
    ):
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted")


def _insert(db: Session, viewer_id: UUID, media_id: UUID, position: int) -> UUID:
    return db.scalar(
        text("""
            INSERT INTO consumption_queue_items (user_id, media_id, position)
            VALUES (:viewer_id, :media_id, :position) RETURNING id
        """),
        {"viewer_id": viewer_id, "media_id": media_id, "position": position},
    )


def _place_visible(db: Session, viewer_id: UUID, rows: list[_Row], item_id: UUID, at: int) -> None:
    """Make ``item_id`` (a visible row, or one just inserted) the ``at``-th visible row by
    permuting the visible rows through their slots; hidden rows keep theirs (I1). A new item
    adds one slot at the end."""
    others = [row.item_id for row in rows if row.visible and row.item_id != item_id]
    order = iter([*others[:at], item_id, *others[at:]])
    ids = [next(order) if row.visible else row.item_id for row in rows]
    _write_order(db, viewer_id, [*ids, *order])


def _delete(db: Session, viewer_id: UUID, item_id: UUID, rows: list[_Row]) -> None:
    db.execute(text("DELETE FROM consumption_queue_items WHERE id = :id"), {"id": item_id})
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
