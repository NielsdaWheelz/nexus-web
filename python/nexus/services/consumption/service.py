"""Current consumption state: the Lectern, read state, completion, listening and the reader cursor.

Writes follow the package's viewer-locked transaction discipline; commands replay by
``clientMutationId``, listening writes are fenced by the reset epoch and cursor saves carry their
own revision. The server picks successors: Done names the next readable row after the removed
one, a natural end the next audio row; a media off the Lectern names none.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.errors import integrity_constraint_name
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import consumption as wire
from nexus.schemas.presence import (
    Absent,
    Present,
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)
from nexus.schemas.reader import CursorWrite, ReaderCursorSnapshot
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.consumption import (
    fresh_session,
    lectern,
    listening,
    lock_viewer,
    projection,
    reader_cursor,
    replayed_command,
    viewer_txn,
)
from nexus.services.reader_publication import lock_publication_generation

_PODCAST = "podcast_episode"
_COMMANDS = "Consumption.Commands"
_LECTERN_OUTCOME = TypeAdapter[wire.LecternOutcome](wire.LecternOutcome)
_PODCAST_FAMILIES = (
    CollectionFamily.LibraryEntries,
    CollectionFamily.PodcastEpisodes,
    CollectionFamily.PodcastSubscriptions,
)


def get_lectern(db: Session, viewer_id: UUID) -> wire.LecternSnapshot:
    from nexus.services.media import list_collection_media_for_viewer_by_ids

    rows = lectern.load(db, viewer_id=viewer_id)
    summaries = {
        media.id: media.summary
        for media in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=[row.media_id for row in rows if row.visible]
        )
    }
    return projection.lectern_snapshot(db, viewer_id=viewer_id, rows=rows, summaries=summaries)


def lectern_has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the whole membership, hidden rows included, is below its cap."""
    count = db.scalar(
        text("SELECT count(*) FROM consumption_queue_items WHERE user_id = :viewer_id"),
        {"viewer_id": viewer_id},
    )
    return count < lectern.LECTERN_MAX_ITEMS


def get_player(db: Session, viewer_id: UUID, media_id: UUID) -> wire.PlayerDescriptor:
    """The fresh descriptor every web play starts from; 404 when not playable."""
    descriptor = (
        projection.player_descriptors(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
        if can_read_media(db, viewer_id, media_id)
        else None
    )
    if descriptor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return descriptor


def get_reader_cursor(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    return reader_cursor.load_snapshot(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media_kind=_reader_kind(db, viewer_id, media_id),
    )


def put_reader_cursor(viewer_id: UUID, media_id: UUID, write: CursorWrite) -> ReaderCursorSnapshot:
    """Replace the cursor, engagement and any first completion atomically."""

    def run(db: Session) -> ReaderCursorSnapshot:
        snapshot = put_reader_cursor_in_txn(db, viewer_id=viewer_id, media_id=media_id, write=write)
        db.commit()
        return snapshot

    with fresh_session() as db:
        try:
            return retry_serializable(db, "reader_cursor_write", lambda: run(db))
        except IntegrityError as exc:
            if integrity_constraint_name(exc) != reader_cursor.MEDIA_FK:
                raise
            # The media was torn down mid-write: answer with the not-found it now is.
            _reader_kind(db, viewer_id, media_id)
            raise


def put_reader_cursor_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, write: CursorWrite
) -> ReaderCursorSnapshot:
    lock_viewer(db, viewer_id)
    kind = _reader_kind(db, viewer_id, media_id)
    if write.expected_reader_generation is not None and (
        lock_publication_generation(db, media_id=media_id) != write.expected_reader_generation
    ):
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
    snapshot = reader_cursor.put_in_txn(
        db, viewer_id=viewer_id, media_id=media_id, media_kind=kind, write=write
    )
    db.execute(
        text("""
            INSERT INTO reader_engagement_states (id, user_id, media_id, last_engaged_at)
            VALUES (:id, :viewer_id, :media_id, now())
            ON CONFLICT (user_id, media_id) DO UPDATE SET last_engaged_at = now()
        """),
        {"id": new_uuid7(), "viewer_id": viewer_id, "media_id": media_id},
    )
    # A podcast transcript is not listening activity.
    if kind != _PODCAST:
        _resume(db, viewer_id, media_id)
    _bump(db, viewer_id, podcast=kind == _PODCAST)
    return snapshot


def run_lectern_command(viewer_id: UUID, command: wire.LecternCommand) -> wire.LecternResult:
    def apply(db: Session) -> dict[str, Any]:
        outcome: wire.LecternOutcome
        if isinstance(command, wire.PlaceItemsCommand):
            media_ids = lectern.dedupe(command.media_ids)
            # Tearing-down targets stay readable here so they answer E_MEDIA_DELETING.
            for media_id in media_ids:
                if not can_read_media(db, viewer_id, media_id, include_tearing_down=True):
                    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
            outcome = wire.PlacedOutcome(
                item_ids=lectern.place(
                    db, viewer_id=viewer_id, media_ids=media_ids, placement=command.placement
                )
            )
        elif isinstance(command, wire.RemoveItemCommand):
            if not lectern.remove(db, viewer_id=viewer_id, item_id=command.item_id):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Lectern item not found")
            outcome = wire.RemovedOutcome(item_id=command.item_id)
        else:
            lectern.set_order(db, viewer_id=viewer_id, item_ids=command.item_ids)
            outcome = wire.OrderedOutcome()
        return {"outcome": outcome.model_dump(mode="json", by_alias=True)}

    def answer(db: Session, memo: Mapping[str, Any]) -> wire.LecternResult:
        return wire.LecternResult(
            outcome=_LECTERN_OUTCOME.validate_python(memo["outcome"]),
            lectern=get_lectern(db, viewer_id),
        )

    return replayed_command(
        "lectern_command", "Lectern.Commands", viewer_id, command, apply, answer
    )


def run_consumption_command(
    viewer_id: UUID, command: wire.ConsumptionCommand
) -> wire.ConsumptionResult:
    return replayed_command(
        "consumption_command",
        _COMMANDS,
        viewer_id,
        command,
        lambda db: _apply(db, viewer_id, command),
        lambda db, memo: _answer(db, viewer_id, command, memo),
    )


def _apply(db: Session, viewer_id: UUID, command: wire.ConsumptionCommand) -> dict[str, Any]:
    """Apply one command; returns the replay memo :func:`_answer` builds the result from.

    ``next`` names where the successor search starts (the removed row's visible index) and
    the activation it needs; ``finish`` what an UndoFinish of this command restores;
    ``progress`` the media whose reset progress the answer carries.
    """
    memo: dict[str, Any] = {"outcome": "Done", "next": None, "finish": None, "progress": None}
    media_id = command.media_id
    if isinstance(command, wire.SettleNaturalEndCommand):
        memo["outcome"] = _settle(db, viewer_id, command, memo)
        return memo
    if isinstance(command, wire.ResetProgressCommand):
        kind = _reader_kind(db, viewer_id, media_id)
        reader_cursor.reset_in_txn(db, viewer_id=viewer_id, media_id=media_id)
        for table in ("reader_engagement_states", "consumption_overrides"):
            db.execute(
                text(f"DELETE FROM {table} WHERE user_id = :viewer_id AND media_id = :media_id"),
                {"viewer_id": viewer_id, "media_id": media_id},
            )
        if kind == _PODCAST:
            listening.reset(db, viewer_id=viewer_id, media_id=media_id)
        memo["progress"] = str(media_id)
        _bump(db, viewer_id, podcast=kind == _PODCAST)
        return memo
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    kind = projection.media_kind(db, media_id)
    if isinstance(command, wire.EnsureMediaFinishedCommand):
        memo["finish"] = _finish(db, viewer_id, media_id)
    elif isinstance(command, wire.DoneCommand):
        memo["finish"] = _finish(db, viewer_id, media_id)
        index = lectern.remove_media(db, viewer_id=viewer_id, media_id=media_id)
        memo["next"] = None if index is None else {"from": index, "activation": "Readable"}
    elif isinstance(command, wire.SetUnreadCommand):
        _mark_unread(db, viewer_id, media_id, podcast=kind == _PODCAST)
    elif isinstance(command, wire.UndoFinishCommand):
        _undo_finish(db, viewer_id, command)
    _bump(db, viewer_id, podcast=kind == _PODCAST)
    return memo


def _undo_finish(db: Session, viewer_id: UUID, command: wire.UndoFinishCommand) -> None:
    """Undo one finish while the override is still the one it wrote: put back the override it
    replaced (or none), drop the first-completion fact it recorded and put back the row a Done
    removed, all in one transaction. A finish never moves progress, so this is the prior state."""
    memo = db.scalar(
        text("""
            SELECT response_json FROM resource_mutations
            WHERE user_id = :viewer_id AND mutation_scope = :scope AND client_mutation_id = :id
        """),
        {"viewer_id": viewer_id, "scope": _COMMANDS, "id": str(command.finish_id)},
    )
    finish = None if memo is None else memo["finish"]
    if (
        finish is None
        or finish["mediaId"] != str(command.media_id)
        or projection.override_revision(db, viewer_id=viewer_id, media_id=command.media_id)
        != finish["revision"]
    ):
        raise InvalidRequestError(message="Completion is no longer undoable")
    params = {"viewer_id": viewer_id, "media_id": command.media_id, "fact": finish["completion"]}
    db.execute(
        text("""
            DELETE FROM consumption_completion_facts WHERE id = :fact AND user_id = :viewer_id
        """),
        params,
    )
    if finish["prior"] is None:
        db.execute(
            text("""
                DELETE FROM consumption_overrides WHERE user_id = :viewer_id AND media_id = :media_id
            """),
            params,
        )
    else:
        status, revision = finish["prior"]
        db.execute(
            text("""
                UPDATE consumption_overrides SET status = :status, revision = :revision
                WHERE user_id = :viewer_id AND media_id = :media_id
            """),
            {**params, "status": status, "revision": revision},
        )
    reader_cursor.fence_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
    if projection.media_kind(db, command.media_id) == _PODCAST:
        listening.fence(db, viewer_id=viewer_id, media_id=command.media_id)
    if isinstance(command.restore, Present):
        restore = command.restore.value
        lectern.restore(
            db,
            viewer_id=viewer_id,
            media_id=command.media_id,
            item_id=restore.item_id,
            added_at=restore.added_at,
            after=nullable_from_presence(restore.after),
        )


def _settle(
    db: Session, viewer_id: UUID, command: wire.SettleNaturalEndCommand, memo: dict[str, Any]
) -> str:
    """Finish an episode its device heard end, fenced on the override revision captured at
    load and on the reset epoch of the terminal sample; leave the Lectern."""
    media_id = command.media_id
    if not can_read_media(db, viewer_id, media_id):
        return "Gone"
    if projection.media_kind(db, media_id) != _PODCAST:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Natural-end settlement is podcast-episode only"
        )
    expected = nullable_from_presence(command.expected_consumption_override_revision)
    if projection.override_revision(db, viewer_id=viewer_id, media_id=media_id) != expected:
        return "Superseded"
    was_finished = _is_finished(db, viewer_id, media_id)
    if _write_listening(db, viewer_id, media_id, command.terminal_listening) is None:
        return "Superseded"
    _finish(db, viewer_id, media_id, was_finished=was_finished)
    index = lectern.remove_media(db, viewer_id=viewer_id, media_id=media_id)
    memo["next"] = None if index is None else {"from": index, "activation": "FooterAudio"}
    _bump(db, viewer_id, podcast=True)
    return "Done"


def _answer(
    db: Session, viewer_id: UUID, command: wire.ConsumptionCommand, memo: Mapping[str, Any]
) -> wire.ConsumptionResult:
    """The result of a fresh or replayed command, read from current state and its memo."""
    snapshot = get_lectern(db, viewer_id)
    next_item = None
    if memo["next"] is not None:
        next_item = next(
            (
                item
                for item in snapshot.items[memo["next"]["from"] :]
                if item.activation.kind == memo["next"]["activation"]
            ),
            None,
        )
    progress: Absent | Present[wire.MediaProgressState] = absent()
    if memo["progress"] is not None:
        media_id = UUID(memo["progress"])
        kind = _reader_kind(db, viewer_id, media_id)
        heard = listening.load_many(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
        progress = present(
            wire.MediaProgressState(
                media_id=media_id,
                reader_cursor=reader_cursor.load_snapshot(
                    db, viewer_id=viewer_id, media_id=media_id, media_kind=kind
                ),
                listening_state=present(
                    wire.ListeningPositionOut(
                        position_ms=heard.position_ms if heard else 0,
                        reset_epoch=heard.reset_epoch if heard else 0,
                        consumption_override_revision=presence_from_nullable(
                            projection.override_revision(db, viewer_id=viewer_id, media_id=media_id)
                        ),
                    )
                )
                if kind == _PODCAST
                else absent(),
            )
        )
    return wire.ConsumptionResult(
        outcome=memo["outcome"],
        lectern=snapshot,
        next_item=absent() if next_item is None else present(next_item),
        finish_id=absent() if memo["finish"] is None else present(command.client_mutation_id),
        progress_state=progress,
        library_entries_collection_revision=read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        ),
    )


def set_podcast_episode_states_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], state: Literal["Finished", "Unread"]
) -> int:
    """Apply already-resolved, readable episode ids in the caller's transaction; how many
    changed state."""
    media_ids = lectern.dedupe(media_ids)
    before = projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)
    for media_id in media_ids:
        if state == "Finished":
            _finish(db, viewer_id, media_id, was_finished=before[media_id].state == "finished")
        else:
            _mark_unread(db, viewer_id, media_id, podcast=True)
    target = "finished" if state == "Finished" else "unread"
    changed = sum(1 for media_id in media_ids if before[media_id].state != target)
    if media_ids:
        _bump(db, viewer_id, podcast=True)
    return changed


def record_listening(
    viewer_id: UUID, media_id: UUID, body: wire.ListeningIn
) -> wire.ListeningPositionOut:
    """Store a sample and acknowledge its current fences in the same transaction."""

    def run(db: Session) -> wire.ListeningPositionOut:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if projection.media_kind(db, media_id) != _PODCAST:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, "Listening state is podcast-episode only"
            )
        heard = _write_listening(db, viewer_id, media_id, body)
        if heard is None:
            heard = listening.load_many(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
            raise ConflictError(
                ApiErrorCode.E_STALE_LISTENING_REVISION,
                "Listening progress was reset",
                details={
                    "current": wire.ListeningPositionOut(
                        position_ms=heard.position_ms if heard else 0,
                        reset_epoch=heard.reset_epoch if heard else 0,
                        consumption_override_revision=presence_from_nullable(
                            projection.override_revision(db, viewer_id=viewer_id, media_id=media_id)
                        ),
                    ).model_dump(mode="json", by_alias=True)
                },
            )
        _resume(db, viewer_id, media_id)
        _bump(db, viewer_id, podcast=True)
        result = wire.ListeningPositionOut(
            position_ms=heard.position_ms,
            reset_epoch=heard.reset_epoch,
            consumption_override_revision=presence_from_nullable(
                projection.override_revision(db, viewer_id=viewer_id, media_id=media_id)
            ),
        )
        db.commit()
        return result

    return viewer_txn("record_listening", viewer_id, run)


def install_preview_position(viewer_id: UUID, media_id: UUID, body: wire.PreviewPositionIn) -> None:
    """Transfer a preview's position once after acquisition, never over real progress."""

    def run(db: Session) -> None:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if projection.media_kind(db, media_id) != _PODCAST:
            raise InvalidRequestError(
                message="Preview position is supported only for Podcast episodes"
            )
        duration_ms = nullable_from_presence(body.duration_ms)
        if listening.install_preview(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            position_ms=body.position_ms
            if duration_ms is None or duration_ms <= 0
            else min(body.position_ms, duration_ms),
            duration_ms=duration_ms,
        ):
            _resume(db, viewer_id, media_id)
            _bump(db, viewer_id, podcast=True)
        db.commit()

    viewer_txn("install_preview_position", viewer_id, run)


def ensure_missing_items_for_assistant_in_current_transaction(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[tuple[UUID, UUID]]:
    """Append assistant items; the caller's transaction also commits its tool record."""
    lock_viewer(db, viewer_id)
    return lectern.ensure_missing_in_txn(db, viewer_id=viewer_id, media_ids=media_ids)


def remove_lectern_item_in_current_transaction(
    db: Session, *, viewer_id: UUID, item_id: UUID
) -> None:
    """Assistant undo: an item the viewer already removed is fine."""
    lock_viewer(db, viewer_id)
    lectern.remove(db, viewer_id=viewer_id, item_id=item_id)


def delete_media_consumption_state_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: every viewer's Lectern, state, progress and history rows."""
    lectern.delete_all_users_in_txn(db, media_id=media_id)
    listening.delete_all_users_in_txn(db, media_id=media_id)
    for table in (
        "consumption_overrides",
        "reader_engagement_states",
        "reader_media_state",
        "consumption_activity_exclusions",
        "consumption_activity_spans",
        "consumption_completion_facts",
    ):
        db.execute(text(f"DELETE FROM {table} WHERE media_id = :media_id"), {"media_id": media_id})


def _write_listening(
    db: Session, viewer_id: UUID, media_id: UUID, body: wire.ListeningIn
) -> listening.Listening | None:
    return listening.write(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        position_ms=body.position_ms,
        duration_ms=nullable_from_presence(body.duration_ms),
        episode_rate=nullable_from_presence(body.episode_playback_rate),
        expected_reset_epoch=body.expected_reset_epoch,
    )


def _mark_unread(db: Session, viewer_id: UUID, media_id: UUID, *, podcast: bool) -> None:
    _set_override(db, viewer_id, media_id, "unread")
    reader_cursor.fence_in_txn(db, viewer_id=viewer_id, media_id=media_id)
    if podcast:
        listening.fence(db, viewer_id=viewer_id, media_id=media_id)


def _resume(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Accepted canonical activity clears unread; completion persists independently of position."""
    db.execute(
        text("""
            DELETE FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = :media_id AND status = 'unread'
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    state = projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id]
    if (
        state.state != "finished"
        and state.progress_fraction is not None
        and state.progress_fraction >= projection.FINISHED_PROGRESSION
    ):
        _set_override(db, viewer_id, media_id, "finished")
        _record_completion(db, viewer_id, media_id)


def _finish(
    db: Session, viewer_id: UUID, media_id: UUID, *, was_finished: bool | None = None
) -> dict[str, Any]:
    """Mark finished; returns what an undo restores: the override it replaced (``[status,
    revision]`` or None), the revision it wrote, and the first-completion fact it recorded."""
    if was_finished is None:
        was_finished = _is_finished(db, viewer_id, media_id)
    prior = db.execute(
        text("""
            SELECT status, revision FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    revision = _set_override(db, viewer_id, media_id, "finished")
    completion = None if was_finished else _record_completion(db, viewer_id, media_id)
    return {
        "mediaId": str(media_id),
        "prior": None if prior is None else [prior.status, prior.revision],
        "revision": revision,
        "completion": None if completion is None else str(completion),
    }


def _set_override(
    db: Session, viewer_id: UUID, media_id: UUID, status: Literal["unread", "finished"]
) -> int:
    """Write the explicit override; each write advances ``revision``, the natural-end fence."""
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
    """The one first-completion fact per media, with the modality its kind implies."""
    return db.scalar(
        text("""
            INSERT INTO consumption_completion_facts (id, user_id, media_id, modality)
            SELECT :id, :viewer_id, m.id,
                   CASE m.kind WHEN 'podcast_episode' THEN 'Listening'
                               WHEN 'video' THEN 'Viewing'
                               ELSE 'Reading' END
            FROM media m WHERE m.id = :media_id
            ON CONFLICT (user_id, media_id) DO NOTHING
            RETURNING id
        """),
        {"id": new_uuid7(), "viewer_id": viewer_id, "media_id": media_id},
    )


def _bump(db: Session, viewer_id: UUID, *, podcast: bool) -> None:
    families = _PODCAST_FAMILIES if podcast else _PODCAST_FAMILIES[:1]
    bump_collection_families(db, viewer_ids=(viewer_id,), families=families)


def _reader_kind(db: Session, viewer_id: UUID, media_id: UUID) -> str:
    kind = projection.media_kind(db, media_id) if can_read_media(db, viewer_id, media_id) else None
    if kind is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if not reader_cursor.supports_media_kind(kind):
        raise InvalidRequestError(message=f"Reader state is not supported for media kind '{kind}'")
    return kind


def _is_finished(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    return (
        projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id].state
        == "finished"
    )
