"""Read state writes: the explicit override, completion, the reader cursor and listening.

The override is one register per viewer and media: ``finished``, ``unread`` or none (a null
status), with a revision every write advances and never reuses; it is the version that finish
undo and the natural-end settle carry. A finish answers what its undo restores; nothing is kept
for it on the server. Every write runs in :func:`viewer_txn`.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import consumption as wire
from nexus.schemas.reader import CursorWrite, ReaderCursorSnapshot, XReaderResumeState
from nexus.services.consumption import lectern, listening, projection, reader_cursor, viewer_txn
from nexus.services.reader_publication import lock_publication_generation
from nexus.services.suggestion_changes import engagement_gate, record_input_change

_EPISODE = "podcast_episode"
Status = Literal["finished", "unread"] | None


def get_player(db: Session, viewer_id: UUID, media_id: UUID) -> wire.PlayerDescriptor:
    """The descriptor every play starts from; 404 when not playable."""
    descriptor = (
        projection.player_descriptors(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
        if can_read_media(db, viewer_id, media_id)
        else None
    )
    if descriptor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return descriptor


def get_reader_cursor(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    _cursor_kind(db, viewer_id, media_id)
    return reader_cursor.load(db, viewer_id=viewer_id, media_id=media_id)


def put_reader_cursor(viewer_id: UUID, media_id: UUID, write: CursorWrite) -> ReaderCursorSnapshot:
    """Save the cursor, mark engagement and clear unread or finish, in one transaction."""

    def run(db: Session) -> ReaderCursorSnapshot:
        kind = _cursor_kind(db, viewer_id, media_id)
        # A web save holds the publication lock, so a source replacement's cursor remap cannot
        # interleave with it.
        expected = write.expected_reader_generation
        if isinstance(write.locator, XReaderResumeState) and expected is None:
            raise InvalidRequestError(
                message="X cursor writes require the displayed reader generation"
            )
        generation = (
            lock_publication_generation(db, media_id=media_id)
            if kind == "web_article" or expected is not None
            else None
        )
        if expected is not None and generation != expected:
            raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
        gate = engagement_gate(db, viewer_id=viewer_id, media_id=media_id, listening=False)
        snapshot, accepted = reader_cursor.save(
            db, viewer_id=viewer_id, media_id=media_id, kind=kind, write=write
        )
        if not accepted:
            return snapshot
        db.execute(
            text("""
                INSERT INTO reader_engagement_states (id, user_id, media_id, last_engaged_at)
                VALUES (:id, :viewer_id, :media_id, now())
                ON CONFLICT (user_id, media_id) DO UPDATE SET last_engaged_at = now()
            """),
            {"id": new_uuid7(), "viewer_id": viewer_id, "media_id": media_id},
        )
        if kind != _EPISODE:  # a transcript is not listening
            _resume(db, viewer_id, media_id)
        if gate.moved(db, viewer_id=viewer_id):
            record_input_change(db)
        db.commit()
        return snapshot

    return viewer_txn("reader_cursor_write", viewer_id, run)


def record_listening(
    viewer_id: UUID, media_id: UUID, body: wire.ListeningIn
) -> wire.ListeningPositionOut:
    """Store one sample under its epoch; a stale epoch answers 409 with the current fences."""

    def run(db: Session) -> wire.ListeningPositionOut:
        _episode(db, viewer_id, media_id)
        gate = engagement_gate(db, viewer_id=viewer_id, media_id=media_id, listening=True)
        heard = listening.write(db, viewer_id=viewer_id, media_id=media_id, sample=body)
        if heard is None:
            raise ConflictError(
                ApiErrorCode.E_STALE_LISTENING_REVISION,
                "Listening progress was reset",
                details={"current": _position(db, viewer_id, media_id).model_dump(mode="json")},
            )
        _resume(db, viewer_id, media_id)
        result = _position(db, viewer_id, media_id)
        if gate.moved(db, viewer_id=viewer_id):
            record_input_change(db)
        db.commit()
        return result

    return viewer_txn("record_listening", viewer_id, run)


def install_preview_position(viewer_id: UUID, media_id: UUID, body: wire.PreviewPositionIn) -> None:
    """A preview's position, once, never over an existing listening row."""

    def run(db: Session) -> None:
        _episode(db, viewer_id, media_id)
        gate = engagement_gate(db, viewer_id=viewer_id, media_id=media_id, listening=True)
        duration = body.duration_ms
        position = body.position_ms if not duration else min(body.position_ms, duration)
        if listening.install_preview(
            db, viewer_id=viewer_id, media_id=media_id, position_ms=position, duration_ms=duration
        ):
            _resume(db, viewer_id, media_id)
            if gate.moved(db, viewer_id=viewer_id):
                record_input_change(db)
        db.commit()

    viewer_txn("install_preview_position", viewer_id, run)


def finish(viewer_id: UUID, media_id: UUID, body: wire.FinishIn) -> wire.Finish:
    """Mark finished, record the first completion and optionally leave the Lectern. A resend
    re-applies (the answer's undo then restores finished)."""

    def run(db: Session) -> wire.Finish:
        _kind(db, viewer_id, media_id)
        prior = _override(db, viewer_id, media_id)
        result = _finish(db, viewer_id, media_id, prior)
        if body.leave_lectern:
            result.removed = lectern.remove_media_in_txn(db, viewer_id=viewer_id, media_id=media_id)
        record_input_change(db)
        db.commit()
        return result

    return viewer_txn("finish", viewer_id, run)


def undo_finish(viewer_id: UUID, media_id: UUID, body: wire.Finish) -> None:
    """While the override still holds the finish's revision, put back its prior status, drop the
    completion it recorded and the row it removed. A resend that already landed succeeds."""

    def run(db: Session) -> None:
        kind = _kind(db, viewer_id, media_id)
        current = _override(db, viewer_id, media_id)
        params = {"viewer_id": viewer_id, "media_id": media_id, "id": body.completion_id}
        if current is not None and current.revision == body.revision:
            _set_override(db, viewer_id, media_id, body.prior_status)
            db.execute(
                text("""DELETE FROM consumption_completion_facts
                        WHERE id = :id AND user_id = :viewer_id AND media_id = :media_id"""),
                params,
            )
            _fence(db, viewer_id, media_id, kind)
        elif (
            current is None
            or current.revision != body.revision + 1
            or current.status != body.prior_status
            or db.scalar(
                text("SELECT EXISTS (SELECT 1 FROM consumption_completion_facts WHERE id = :id)"),
                params,
            )
        ):
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Completion is no longer undoable"
            )
        if body.removed is not None:
            lectern.restore_in_txn(db, viewer_id=viewer_id, media_id=media_id, removed=body.removed)
        record_input_change(db)
        db.commit()

    viewer_txn("undo_finish", viewer_id, run)


def mark_unread(viewer_id: UUID, media_id: UUID) -> None:
    """Unread, and retire every earlier cursor save and listening sample. A resend re-applies."""

    def run(db: Session) -> None:
        kind = _kind(db, viewer_id, media_id)
        _set_override(db, viewer_id, media_id, "unread")
        _fence(db, viewer_id, media_id, kind)
        record_input_change(db)
        db.commit()

    viewer_txn("mark_unread", viewer_id, run)


def reset_progress(viewer_id: UUID, media_id: UUID) -> None:
    """Empty cursor, listening at zero, no override and no engagement; history stays."""

    def run(db: Session) -> None:
        kind = _cursor_kind(db, viewer_id, media_id)
        reader_cursor.reset(db, viewer_id=viewer_id, media_id=media_id)
        db.execute(
            text("""DELETE FROM reader_engagement_states
                    WHERE user_id = :viewer_id AND media_id = :media_id"""),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        _set_override(db, viewer_id, media_id, None)
        if kind == _EPISODE:
            listening.reset(db, viewer_id=viewer_id, media_id=media_id)
        record_input_change(db)
        db.commit()

    viewer_txn("reset_progress", viewer_id, run)


def settle_natural_end(viewer_id: UUID, media_id: UUID, body: wire.NaturalEndIn) -> None:
    """Finish an episode its device heard end and leave the Lectern, fenced on the override
    revision the device last saw and the terminal sample's epoch. 409 when superseded; a resend
    that already landed (the next revision, finished, same epoch) succeeds."""

    def run(db: Session) -> None:
        _episode(db, viewer_id, media_id)
        current = _override(db, viewer_id, media_id)
        expected = body.expected_override_revision
        changed = False
        if (current.revision if current else None) == expected and listening.write(
            db, viewer_id=viewer_id, media_id=media_id, sample=body.terminal_listening
        ):
            _finish(db, viewer_id, media_id, current)
            lectern.remove_media_in_txn(db, viewer_id=viewer_id, media_id=media_id)
            changed = True
        elif not (
            current is not None
            and current.status == "finished"
            and current.revision == (expected or 0) + 1
            and _position(db, viewer_id, media_id).reset_epoch
            == body.terminal_listening.expected_reset_epoch
        ):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "The natural end was superseded")
        if changed:
            record_input_change(db)
        db.commit()

    viewer_txn("settle_natural_end", viewer_id, run)


def set_episode_states_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], state: Literal["Finished", "Unread"]
) -> int:
    """Mark played / unplayed for readable episode ids in the caller's viewer_txn; how many
    changed state."""
    media_ids = list(dict.fromkeys(media_ids))
    before = projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)
    for media_id in media_ids:
        if state == "Finished":
            _finish(db, viewer_id, media_id, _override(db, viewer_id, media_id))
        else:
            _set_override(db, viewer_id, media_id, "unread")
            _fence(db, viewer_id, media_id, _EPISODE)
    return sum(1 for media_id in media_ids if before[media_id].state != state)


def delete_media_consumption_state_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: state, progress and history. Lectern owns its separate fenced cleanup."""
    for table in (
        "podcast_listening_states",
        "consumption_overrides",
        "reader_engagement_states",
        "reader_media_state",
        "consumption_activity_exclusions",
        "consumption_activity_spans",
        "consumption_completion_facts",
    ):
        db.execute(text(f"DELETE FROM {table} WHERE media_id = :media_id"), {"media_id": media_id})


def _finish(db: Session, viewer_id: UUID, media_id: UUID, prior: Row | None) -> wire.Finish:
    """Finished, and the first completion fact when this is a transition to finished."""
    prior_status = prior.status if prior else None
    revision = _set_override(db, viewer_id, media_id, "finished")
    completion = None if prior_status == "finished" else _record_completion(db, viewer_id, media_id)
    return wire.Finish(
        revision=revision, prior_status=prior_status, completion_id=completion, removed=None
    )


def _resume(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Accepted progress clears unread; known progress at 0.95 or more finishes (I7)."""
    db.execute(
        text("""
            UPDATE consumption_overrides SET status = NULL, revision = revision + 1
            WHERE user_id = :viewer_id AND media_id = :media_id AND status = 'unread'
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    state = projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id]
    if state.state != "Finished" and (state.progress or 0) >= projection.FINISHED_PROGRESSION:
        _finish(db, viewer_id, media_id, _override(db, viewer_id, media_id))


def _override(db: Session, viewer_id: UUID, media_id: UUID) -> Row | None:
    return db.execute(
        text("""SELECT status, revision FROM consumption_overrides
                WHERE user_id = :viewer_id AND media_id = :media_id"""),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()


def _set_override(db: Session, viewer_id: UUID, media_id: UUID, status: Status) -> int:
    """Write the register; every write advances the revision (I4)."""
    return db.scalar(
        text("""
            INSERT INTO consumption_overrides (user_id, media_id, status, revision)
            VALUES (:viewer_id, :media_id, :status, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET status = EXCLUDED.status, revision = consumption_overrides.revision + 1
            RETURNING revision
        """),
        {"viewer_id": viewer_id, "media_id": media_id, "status": status},
    )


def _record_completion(db: Session, viewer_id: UUID, media_id: UUID) -> UUID | None:
    """The one completion fact per viewer and media, with the modality its kind implies (I8)."""
    return db.scalar(
        text("""
            INSERT INTO consumption_completion_facts (id, user_id, media_id, modality)
            SELECT :id, :viewer_id, m.id,
                   CASE m.kind WHEN 'podcast_episode' THEN 'Listening'
                               WHEN 'video' THEN 'Viewing' ELSE 'Reading' END
            FROM media m WHERE m.id = :media_id
            ON CONFLICT (user_id, media_id) DO NOTHING
            RETURNING id
        """),
        {"id": new_uuid7(), "viewer_id": viewer_id, "media_id": media_id},
    )


def _fence(db: Session, viewer_id: UUID, media_id: UUID, kind: str) -> None:
    """Retire earlier cursor saves and listening samples without moving either."""
    reader_cursor.fence(db, viewer_id=viewer_id, media_id=media_id)
    if kind == _EPISODE:
        listening.fence(db, viewer_id=viewer_id, media_id=media_id)


def _position(db: Session, viewer_id: UUID, media_id: UUID) -> wire.ListeningPositionOut:
    heard = listening.load(db, viewer_id=viewer_id, media_id=media_id)
    current = _override(db, viewer_id, media_id)
    return wire.ListeningPositionOut(
        position_ms=heard.position_ms if heard else 0,
        reset_epoch=heard.reset_epoch if heard else 0,
        consumption_override_revision=current.revision if current else None,
    )


def _kind(db: Session, viewer_id: UUID, media_id: UUID) -> str:
    """The media's kind; 404 unless the viewer can read it."""
    kind = projection.media_kind(db, media_id) if can_read_media(db, viewer_id, media_id) else None
    if kind is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return kind


def _episode(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    if _kind(db, viewer_id, media_id) != _EPISODE:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Podcast episodes only")


def _cursor_kind(db: Session, viewer_id: UUID, media_id: UUID) -> str:
    kind = _kind(db, viewer_id, media_id)
    if not reader_cursor.supports(kind):
        raise InvalidRequestError(message=f"Reader state is not supported for media kind '{kind}'")
    return kind
