"""Sole DML owner of ``consumption_queue_items``: the Lectern, the viewer's ordered intentions.

One row per viewer and media; positions are dense ``0..n-1`` over all of a viewer's rows. A row
is visible when its media is visible to the viewer and has no teardown intent; hidden rows keep
their slots and count toward the cap (I1): a placement permutes the visible rows through the
visible slots, and a new row takes a new last slot. Public writes compare the captured
collection revision under the viewer lock. Every accepted membership intent advances it,
even when already satisfied, so delayed opposing intents cannot reverse an acknowledgement.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas import collection_actions as collection_wire
from nexus.schemas import consumption as wire
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.consumption import observation, projection, viewer_txn
from nexus.services.suggestion_changes import record_input_change
from nexus.services.users import lock_viewer

LECTERN_MAX_ITEMS = 2000
_READABLE = frozenset({"web_article", "epub", "pdf"})


@dataclass(frozen=True, slots=True)
class _Row:
    item_id: UUID
    media_id: UUID
    kind: str
    added_at: datetime
    visible: bool


def get_lectern(
    db: Session, viewer_id: UUID, *, summaries: dict[UUID, MediaSummaryOut] | None = None
) -> wire.LecternOut:
    """The visible rows in order, each with its summary and how it activates; capacity counts
    every row."""
    from nexus.services.media import media_summaries

    membership = _load(db, viewer_id)
    order = _order_snapshot(db, viewer_id, membership)
    rows = [row for row in membership if row.visible]
    media_ids = order.media_ids
    if summaries is None:
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
        order_revision=order.order_revision,
    )


def prepare_collection(
    db: Session, viewer_id: UUID, target: collection_wire.CollectionTarget
) -> collection_wire.CollectionLecternPreparedOut:
    """Freeze unfinished contents and full capacity under one repeatable-read snapshot."""
    from nexus.services.consumption.collections import ordered_source_ids

    label, ids = ordered_source_ids(db, viewer_id, target)
    states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=ids)
    selected = [media_id for media_id in ids if states[media_id].state != "Finished"]
    rows = _load(db, viewer_id)
    present = {row.media_id for row in rows}
    return collection_wire.CollectionLecternPreparedOut(
        label=label,
        media_ids=selected,
        expected_order_revision=str(_revision(db, viewer_id)),
        already_present_count=sum(media_id in present for media_id in selected),
        available_slots=max(0, LECTERN_MAX_ITEMS - len(rows)),
    )


def append_collection(
    viewer_id: UUID, body: collection_wire.CollectionLecternRequest
) -> collection_wire.CollectionLecternOut:
    """One frozen batch under the reviewed order revision; never rebase or truncate.

    Revision comparison precedes membership equality, so replay at an already-used
    revision refuses. Existing members stay put even when since finished. Every
    missing target must remain unfinished, readable and in the original source.
    append_missing_in_txn advances once, including an accepted membership no-op.
    """
    from nexus.services import library_entries
    from nexus.services.consumption.collections import require_source_members

    def run(db: Session) -> collection_wire.CollectionLecternOut:
        _require_revision(db, viewer_id, int(body.expected_order_revision))
        library_entries.lock_media_rows_in_order(db, body.media_ids)
        require_source_members(db, viewer_id, body.target, body.media_ids)
        present = {row.media_id for row in _load(db, viewer_id)}
        missing = [media_id for media_id in body.media_ids if media_id not in present]
        states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=missing)
        if any(state.state == "Finished" for state in states.values()):
            raise ConflictError(
                ApiErrorCode.E_SELECTION_CHANGED, "An insertion target is now finished"
            )
        inserted = append_missing_in_txn(db, viewer_id=viewer_id, media_ids=body.media_ids)
        record_input_change(db, owners=(f"consumption:{viewer_id}:lectern",))
        result = collection_wire.CollectionLecternOut(
            order_revision=str(_revision(db, viewer_id)),
            matched_count=len(body.media_ids),
            added_count=len(inserted),
        )
        return result

    return viewer_txn("lectern_append_collection", viewer_id, run)


def place(
    viewer_id: UUID,
    media_id: UUID,
    placement: wire.Placement | None,
    expected_order_revision: int,
) -> wire.LecternWriteOut:
    """Put the media first or after another media's visible row (first when that row is absent or
    hidden), inserting it when absent. A null placement only ensures membership: an absent media
    takes the last slot, a present row stays where it is."""

    def run(db: Session) -> wire.LecternWriteOut:
        _require_revision(db, viewer_id, expected_order_revision)
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
        result = wire.LecternWriteOut(order_revision=str(_advance_revision(db, viewer_id)))
        record_input_change(db, owners=(f"consumption:{viewer_id}:{media_id}",))
        return result

    return viewer_txn("lectern_place", viewer_id, run)


def remove(viewer_id: UUID, media_id: UUID, expected_order_revision: int) -> wire.LecternWriteOut:
    def run(db: Session) -> wire.LecternWriteOut:
        _require_revision(db, viewer_id, expected_order_revision)
        removed = remove_media_in_txn(db, viewer_id=viewer_id, media_id=media_id)
        result = wire.LecternWriteOut(order_revision=str(_revision(db, viewer_id)))
        if removed is not None:
            record_input_change(db, owners=(f"consumption:{viewer_id}:{media_id}",))
        return result

    return viewer_txn("lectern_remove", viewer_id, run)


def move(
    viewer_id: UUID,
    media_id: UUID,
    before_media_id: UUID | None,
    expected_order_revision: int,
) -> wire.LecternOrderOut:
    """Move one existing visible member; hidden rows retain their exact slots."""

    def run(db: Session) -> wire.LecternOrderOut:
        if media_id == before_media_id:
            raise InvalidRequestError(message="A media cannot be moved before itself")
        _require_revision(db, viewer_id, expected_order_revision)
        rows = _load(db, viewer_id)
        visible = [row for row in rows if row.visible]
        subject = next((row for row in visible if row.media_id == media_id), None)
        others = [row.media_id for row in visible if row.media_id != media_id]
        if subject is None or (before_media_id is not None and before_media_id not in others):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "A visible lectern item is gone")
        at = len(others) if before_media_id is None else others.index(before_media_id)
        _place_visible(db, viewer_id, rows, subject.item_id, at)
        _advance_revision(db, viewer_id)
        result = _order_snapshot(db, viewer_id, _load(db, viewer_id))
        return result

    return viewer_txn("lectern_move", viewer_id, run)


def has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the whole membership, hidden rows included, is below the cap."""
    count = db.scalar(
        text("SELECT count(*) FROM consumption_queue_items WHERE user_id = :viewer_id"),
        {"viewer_id": viewer_id},
    )
    return count < LECTERN_MAX_ITEMS


def remove_media_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> wire.RemovedItem | None:
    """Delete the media's row; what an undo needs to put it back (its id, added time and the
    visible row before it), None when it had no row. Caller holds the viewer lock;
    an explicit remove fences earlier membership intent even when already absent."""
    rows = _load(db, viewer_id)
    index = next((i for i, row in enumerate(rows) if row.media_id == media_id), None)
    _advance_revision(db, viewer_id)
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
    that is a visible row, else first. Caller holds the viewer lock. Existing membership
    keeps its position, but still fences earlier membership intent."""
    rows = _load(db, viewer_id)
    _advance_revision(db, viewer_id)
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
    transaction (the assistant); the inserted ``(media_id, item_id)`` pairs."""
    lock_viewer(db, viewer_id)
    media_ids = list(dict.fromkeys(media_ids))
    if not media_ids:
        return []
    _refuse_tearing_down(db, media_ids)
    rows = _load(db, viewer_id)
    present = {row.media_id for row in rows}
    absent = [media_id for media_id in media_ids if media_id not in present]
    if len(rows) + len(absent) > LECTERN_MAX_ITEMS:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Lectern is at its item limit")
    inserted = [
        (media_id, _insert(db, viewer_id, media_id, len(rows) + offset))
        for offset, media_id in enumerate(absent)
    ]
    _advance_revision(db, viewer_id)
    return inserted


def remove_item_in_txn(db: Session, *, viewer_id: UUID, item_id: UUID) -> None:
    """The assistant's undo, in the caller's transaction; an absent row is fine."""
    lock_viewer(db, viewer_id)
    rows = _load(db, viewer_id)
    if any(row.item_id == item_id for row in rows):
        _delete(db, viewer_id, item_id, rows)
    _advance_revision(db, viewer_id)


def lock_viewers_for_media_in_txn(db: Session, *, media_id: UUID) -> list[UUID]:
    """Teardown's viewer lock set, acquired before its media lock in a serializable attempt."""
    viewer_ids = list(
        db.scalars(
            text(
                "SELECT user_id FROM consumption_queue_items WHERE media_id = :id UNION SELECT user_id FROM podcast_listening_states WHERE media_id = :id UNION SELECT user_id FROM consumption_overrides WHERE media_id = :id ORDER BY user_id"
            ),
            {"id": media_id},
        )
    )
    for viewer_id in viewer_ids:
        lock_viewer(db, viewer_id)
    return viewer_ids


def delete_media_in_txn(db: Session, *, media_id: UUID, locked_viewer_ids: list[UUID]) -> None:
    """Teardown deletes only its prelocked set; an unseen insert is fenced by serializable/FK."""
    for viewer_id in locked_viewer_ids:
        rows = _load(db, viewer_id)
        subject = next((row for row in rows if row.media_id == media_id), None)
        if subject is not None:
            _delete(db, viewer_id, subject.item_id, rows)
            _advance_revision(db, viewer_id)


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


def _revision(db: Session, viewer_id: UUID) -> int:
    return db.execute(
        text("SELECT lectern_order_revision FROM users WHERE id = :id"), {"id": viewer_id}
    ).scalar_one()


def _require_revision(db: Session, viewer_id: UUID, expected: int) -> None:
    if _revision(db, viewer_id) != expected:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Lectern order changed")


def _advance_revision(db: Session, viewer_id: UUID) -> int:
    observation.advance(db, viewer_id)
    return db.execute(
        text("""
            UPDATE users SET lectern_order_revision = nextval('collection_order_revision_seq')
            WHERE id = :id RETURNING lectern_order_revision
        """),
        {"id": viewer_id},
    ).scalar_one()


def _order_snapshot(db: Session, viewer_id: UUID, rows: list[_Row]) -> wire.LecternOrderOut:
    return wire.LecternOrderOut(
        order_revision=str(_revision(db, viewer_id)),
        media_ids=[row.media_id for row in rows if row.visible],
    )


def lectern_rows_sql() -> str:
    """Whole ordered membership with visibility; hidden rows still determine capacity."""
    return f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT q.id, q.media_id, m.kind, q.added_at,
                   (vm.media_id IS NOT NULL AND ti.media_id IS NULL) AS visible
            FROM consumption_queue_items q
            JOIN media m ON m.id = q.media_id
            LEFT JOIN visible_media vm ON vm.media_id = q.media_id
            LEFT JOIN media_teardown_intents ti ON ti.media_id = q.media_id
            WHERE q.user_id = :viewer_id
            ORDER BY q.position, q.added_at, q.id
    """


def _load(db: Session, viewer_id: UUID) -> list[_Row]:
    rows = db.execute(
        text(lectern_rows_sql()),
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
