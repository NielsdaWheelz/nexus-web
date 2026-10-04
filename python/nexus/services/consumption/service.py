"""Current consumption state: Lectern, read state, completion, listening and the reader cursor.

Writes follow the package's viewer-locked transaction discipline; commands replay by
``clientMutationId``, while heartbeats and cursor saves carry their own CAS tokens instead.
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
from nexus.schemas.consumption import (
    ConsumptionCommand,
    ConsumptionRemovedOutcome,
    ConsumptionResult,
    ConsumptionStateOutcome,
    EnsureMediaFinishedCommand,
    FinishLecternItemCommand,
    LecternCommand,
    LecternItemOut,
    LecternNaturalEndOrigin,
    LecternOutcome,
    LecternResult,
    LecternSnapshot,
    ListeningHeartbeatIn,
    ListeningHeartbeatResult,
    ListeningStateOut,
    MediaProgressState,
    NextCapability,
    OrderedOutcome,
    PlacedOutcome,
    PlaceItemsCommand,
    PreviewPositionIn,
    RemovedOutcome,
    RemoveItemCommand,
    ResetProgressCommand,
    SettleNaturalEndCommand,
    SetUnreadCommand,
    UndoCompletionCommand,
)
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Absent, Present, absent, nullable_from_presence, present
from nexus.schemas.reader import CursorWrite, PdfReaderResumeState, ReaderCursorSnapshot
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.consumption import (
    _lectern_store,
    _listening_store,
    fresh_session,
    lock_viewer,
    projection,
    reader_cursor,
    replayed_command,
    viewer_txn,
)
from nexus.services.consumption._lectern_store import LecternRow, _dedupe
from nexus.services.consumption.handles import COMPLETION, seal, unseal
from nexus.services.reader_publication import lock_publication_generation

LECTERN_SCOPE = "Lectern.Commands"
CONSUMPTION_SCOPE = "Consumption.Commands"
_PODCAST = "podcast_episode"
_LECTERN_OUTCOME = TypeAdapter[LecternOutcome](LecternOutcome)
_PODCAST_FAMILIES = (
    CollectionFamily.LibraryEntries,
    CollectionFamily.PodcastEpisodes,
    CollectionFamily.PodcastSubscriptions,
)


def get_lectern(db: Session, viewer_id: UUID) -> LecternSnapshot:
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    return projection.build_snapshot(
        db, viewer_id=viewer_id, rows=rows, summaries=_media_summaries(db, viewer_id, rows)
    )


def _media_summaries(
    db: Session, viewer_id: UUID, rows: list[LecternRow]
) -> dict[UUID, MediaSummaryOut]:
    from nexus.services.media import list_collection_media_for_viewer_by_ids

    return {
        media.id: media.summary
        for media in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=[row.media_id for row in rows if row.visible]
        )
    }


def lectern_has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the whole Lectern membership, hidden rows included, is below its cap."""
    count = db.scalar(
        text("SELECT count(*) FROM consumption_queue_items WHERE user_id = :viewer_id"),
        {"viewer_id": viewer_id},
    )
    return count < _lectern_store.LECTERN_MAX_ITEMS


def get_listening_state(db: Session, viewer_id: UUID, media_id: UUID) -> ListeningStateOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return projection.to_listening_state_out(
        _listening_store.load_state(db, viewer_id=viewer_id, media_id=media_id)
    )


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
    was_finished = _is_finished(db, viewer_id, media_id)
    snapshot = reader_cursor.put_in_txn(
        db, viewer_id=viewer_id, media_id=media_id, media_kind=kind, write=write
    )
    # A PDF page progression is page-local, so PDF saves never raise the maximum.
    db.execute(
        text("""
            INSERT INTO reader_engagement_states (
                id, user_id, media_id, last_engaged_at, max_total_progression
            ) VALUES (:id, :viewer_id, :media_id, now(), :progression)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET last_engaged_at = now(),
                max_total_progression = GREATEST(
                    reader_engagement_states.max_total_progression,
                    EXCLUDED.max_total_progression
                )
        """),
        {
            "id": new_uuid7(),
            "viewer_id": viewer_id,
            "media_id": media_id,
            "progression": None
            if isinstance(write.locator, PdfReaderResumeState)
            else write.locator.locations.total_progression,
        },
    )
    if not was_finished and _is_finished(db, viewer_id, media_id):
        _record_completion(db, viewer_id, media_id)
    _bump(db, viewer_id, podcast=kind == _PODCAST)
    return snapshot


def run_lectern_command(viewer_id: UUID, command: LecternCommand) -> LecternResult:
    def apply(db: Session) -> dict[str, Any]:
        outcome: LecternOutcome
        if isinstance(command, PlaceItemsCommand):
            media_ids = _dedupe(command.media_ids)
            # Tearing-down targets stay readable here so they answer E_MEDIA_DELETING.
            for media_id in media_ids:
                if not can_read_media(db, viewer_id, media_id, include_tearing_down=True):
                    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
            if _lectern_store.teardown_intent_media(db, media_ids=media_ids):
                raise ConflictError(
                    ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted"
                )
            outcome = PlacedOutcome(
                item_ids=_lectern_store.place_items_in_txn(
                    db,
                    viewer_id=viewer_id,
                    media_ids=media_ids,
                    placement=command.placement,
                    source="Manual",
                )
            )
        elif isinstance(command, RemoveItemCommand):
            outcome = RemovedOutcome(
                item_id=_lectern_store.remove_item_in_txn(
                    db, viewer_id=viewer_id, item_id=command.item_id
                )
            )
        else:
            _lectern_store.set_order_in_txn(db, viewer_id=viewer_id, item_ids=command.item_ids)
            outcome = OrderedOutcome()
        return {"outcome": outcome.model_dump(mode="json", by_alias=True)}

    def answer(db: Session, memo: Mapping[str, Any]) -> LecternResult:
        outcome = _LECTERN_OUTCOME.validate_python(memo["outcome"])
        return LecternResult(outcome=outcome, lectern=get_lectern(db, viewer_id))

    return replayed_command("lectern_command", LECTERN_SCOPE, viewer_id, command, apply, answer)


def run_consumption_command(viewer_id: UUID, command: ConsumptionCommand) -> ConsumptionResult:
    return replayed_command(
        "consumption_command",
        CONSUMPTION_SCOPE,
        viewer_id,
        command,
        lambda db: _apply(db, viewer_id, command),
        lambda db, memo: _result(db, viewer_id, command, memo),
    )


def _apply(db: Session, viewer_id: UUID, command: ConsumptionCommand) -> dict[str, Any]:
    """Apply one command; returns its replay memo, from which :func:`_result` builds the answer."""
    memo: dict[str, Any] = {
        "outcome": {"kind": "StateOnly"},
        "nextItemId": None,
        "progressMediaId": None,
        "completionHandle": None,
    }
    if isinstance(command, EnsureMediaFinishedCommand):
        _require_readable(db, viewer_id, command.media_id)
        kind = _kind(db, command.media_id)
        memo["completionHandle"] = _handle(_write_finished(db, viewer_id, command.media_id, kind))
        _bump(db, viewer_id, podcast=kind == _PODCAST)
    elif isinstance(command, FinishLecternItemCommand):
        rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
        target = next((row for row in rows if row.item_id == command.item_id), None)
        if target is None or target.media_id != command.media_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Lectern item not found")
        memo["nextItemId"] = _next_item(rows, target.position, command.next_capability)
        memo["completionHandle"] = _handle(
            _write_finished(db, viewer_id, command.media_id, target.kind)
        )
        _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=command.item_id)
        memo["outcome"] = {"kind": "Removed", "itemId": str(command.item_id)}
        _bump(db, viewer_id, podcast=target.kind == _PODCAST)
    elif isinstance(command, SetUnreadCommand):
        _require_readable(db, viewer_id, command.media_id)
        _set_override(db, viewer_id, command.media_id, "unread")
        _bump(db, viewer_id, podcast=_kind(db, command.media_id) == _PODCAST)
    elif isinstance(command, ResetProgressCommand):
        kind = _reader_kind(db, viewer_id, command.media_id)
        reader_cursor.reset_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
        params = {"viewer_id": viewer_id, "media_id": command.media_id}
        for table in ("reader_engagement_states", "consumption_overrides"):
            db.execute(
                text(f"DELETE FROM {table} WHERE user_id = :viewer_id AND media_id = :media_id"),
                params,
            )
        if kind == _PODCAST:
            _listening_store.reset_progress_in_txn(
                db, viewer_id=viewer_id, media_id=command.media_id
            )
        memo["progressMediaId"] = str(command.media_id)
        _bump(db, viewer_id, podcast=kind == _PODCAST)
    elif isinstance(command, UndoCompletionCommand):
        media_id = db.scalar(
            text("""
                DELETE FROM consumption_completion_facts
                WHERE id = :id AND user_id = :viewer_id
                RETURNING media_id
            """),
            {"id": unseal(COMPLETION, command.completion_handle), "viewer_id": viewer_id},
        )
        if media_id is None:
            raise InvalidRequestError(message="Completion is no longer undoable")
        _set_override(db, viewer_id, media_id, "unread")
        _bump(db, viewer_id, podcast=_kind(db, media_id) == _PODCAST)
    elif isinstance(command, SettleNaturalEndCommand):
        memo["outcome"] = {"kind": _settle(db, viewer_id, command, memo)}
    else:
        _write_episode_states(db, viewer_id, _dedupe(command.media_ids), command.state)
        _bump(db, viewer_id, podcast=True)
    return memo


def _settle(
    db: Session, viewer_id: UUID, command: SettleNaturalEndCommand, memo: dict[str, Any]
) -> str:
    """Fence one receipt-backed natural end on the override revision and listening state."""
    if not can_read_media(db, viewer_id, command.media_id):
        return "TargetGone"
    if _kind(db, command.media_id) != _PODCAST:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Natural-end settlement is podcast-episode only"
        )
    revision = projection.override_revisions(
        db, viewer_id=viewer_id, media_ids=[command.media_id]
    ).get(command.media_id)
    if nullable_from_presence(command.expected_consumption_override_revision) != revision:
        return "Superseded"
    was_finished = _is_finished(db, viewer_id, command.media_id)
    terminal = command.terminal_listening
    if (
        _listening_store.record_heartbeat_in_txn(
            db,
            viewer_id=viewer_id,
            media_id=command.media_id,
            position_ms=terminal.position_ms,
            duration_ms=nullable_from_presence(terminal.duration_ms),
            episode_playback_rate=terminal.episode_playback_rate,
            expected_write_revision=terminal.expected_write_revision,
            expected_reset_epoch=terminal.expected_reset_epoch,
        )
        is None
    ):
        return "Superseded"
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    origin = command.origin
    target = next(
        (
            row
            for row in rows
            if isinstance(origin, LecternNaturalEndOrigin)
            and row.item_id == origin.item_id
            and row.media_id == command.media_id
            and row.visible
        ),
        None,
    )
    if target is not None:
        memo["nextItemId"] = _next_item(rows, target.position, command.next_capability)
    _write_finished(db, viewer_id, command.media_id, _PODCAST, was_finished=was_finished)
    _bump(db, viewer_id, podcast=True)
    if target is None:
        return "CompletedWithoutAdvance"
    _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=target.item_id)
    return "Completed"


def _result(
    db: Session, viewer_id: UUID, command: ConsumptionCommand, memo: Mapping[str, Any]
) -> ConsumptionResult:
    """The answer to a fresh or replayed command, read from current state and its memo."""
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    summaries = _media_summaries(db, viewer_id, rows)
    candidate = next(
        (row for row in rows if row.visible and str(row.item_id) == memo["nextItemId"]), None
    )
    next_id: UUID | None = None
    next_item: Absent | Present[LecternItemOut] = absent()
    if (
        candidate is not None
        and isinstance(command, FinishLecternItemCommand | SettleNaturalEndCommand)
        and projection.activation_kind(candidate) == command.next_capability
    ):
        next_id = candidate.item_id
        next_item = present(
            projection.build_item(db, viewer_id=viewer_id, row=candidate, summaries=summaries)
        )
    progress_state: Absent | Present[MediaProgressState] = absent()
    if memo["progressMediaId"] is not None:
        media_id = UUID(memo["progressMediaId"])
        kind = _reader_kind(db, viewer_id, media_id)
        progress_state = present(
            MediaProgressState(
                media_id=media_id,
                reader_cursor=reader_cursor.load_snapshot(
                    db, viewer_id=viewer_id, media_id=media_id, media_kind=kind
                ),
                listening_state=present(
                    projection.to_listening_state_out(
                        _listening_store.load_state(db, viewer_id=viewer_id, media_id=media_id)
                    )
                )
                if kind == _PODCAST
                else absent(),
            )
        )
    outcome = memo["outcome"]
    return ConsumptionResult(
        outcome=ConsumptionRemovedOutcome(
            item_id=UUID(outcome["itemId"]),
            next_item_id=present(next_id) if next_id is not None else absent(),
        )
        if outcome["kind"] == "Removed"
        else ConsumptionStateOutcome(kind=outcome["kind"]),
        lectern=projection.build_snapshot(db, viewer_id=viewer_id, rows=rows, summaries=summaries),
        next_item=next_item,
        progress_state=progress_state,
        completion_handle=present(memo["completionHandle"])
        if memo["completionHandle"] is not None
        else absent(),
        library_entries_collection_revision=read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        ),
    )


def _next_item(
    rows: list[LecternRow], removed_position: int, capability: NextCapability
) -> str | None:
    """The first visible later item of the requested capability."""
    if capability == "Stop":
        return None
    for row in sorted(rows, key=lambda row: row.position):
        if (
            row.visible
            and row.position > removed_position
            and projection.activation_kind(row) == capability
        ):
            return str(row.item_id)
    return None


def _write_finished(
    db: Session, viewer_id: UUID, media_id: UUID, kind: str, *, was_finished: bool | None = None
) -> UUID | None:
    """Mark finished; returns the new completion fact on a first transition to Finished."""
    if was_finished is None:
        was_finished = _is_finished(db, viewer_id, media_id)
    _set_override(db, viewer_id, media_id, "finished")
    if kind == _PODCAST:
        _listening_store.mark_completed_in_txn(db, viewer_id=viewer_id, media_id=media_id)
    return None if was_finished else _record_completion(db, viewer_id, media_id)


def _write_episode_states(
    db: Session, viewer_id: UUID, media_ids: list[UUID], state: Literal["Finished", "Unread"]
) -> None:
    for media_id in media_ids:
        _require_readable(db, viewer_id, media_id)
    kinds = projection.media_kinds(db, media_ids)
    if any(kinds.get(media_id) != _PODCAST for media_id in media_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Batch state changes are podcast-episode only"
        )
    for media_id in media_ids:
        if state == "Finished":
            _write_finished(db, viewer_id, media_id, _PODCAST)
        else:
            _set_override(db, viewer_id, media_id, "unread")


def set_podcast_episode_states_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], state: Literal["Finished", "Unread"]
) -> int:
    """Apply already-resolved episode ids in the caller's transaction; returns how many changed."""
    normalized = _dedupe(media_ids)
    if not normalized:
        return 0
    before = projection.media_read_states(db, viewer_id=viewer_id, media_ids=normalized)
    _write_episode_states(db, viewer_id, normalized, state)
    target = "finished" if state == "Finished" else "unread"
    changed = sum(1 for media_id in normalized if before[media_id].state != target)
    if changed:
        _bump(db, viewer_id, podcast=True)
    return changed


def record_listening_heartbeat(
    viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    """Fence and write position, duration and episode rate."""

    def run(db: Session) -> ListeningHeartbeatResult:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        was_finished = _is_finished(db, viewer_id, media_id)
        row = _listening_store.record_heartbeat_in_txn(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            position_ms=heartbeat.position_ms,
            duration_ms=nullable_from_presence(heartbeat.duration_ms),
            episode_playback_rate=heartbeat.episode_playback_rate,
            expected_write_revision=heartbeat.expected_write_revision,
            expected_reset_epoch=heartbeat.expected_reset_epoch,
        )
        if row is None:
            raise ConflictError(
                ApiErrorCode.E_STALE_LISTENING_REVISION, "Listening revision is stale"
            )
        if not was_finished and _is_finished(db, viewer_id, media_id):
            _record_completion(db, viewer_id, media_id)
        _bump(db, viewer_id, podcast=True)
        db.commit()
        return ListeningHeartbeatResult(
            listening_state=projection.to_listening_state_out(row),
            heartbeat_generation=heartbeat.heartbeat_generation,
            heartbeat_sequence=heartbeat.heartbeat_sequence,
        )

    return viewer_txn("listening_heartbeat", viewer_id, run)


def install_preview_position(
    viewer_id: UUID, media_id: UUID, *, position: PreviewPositionIn
) -> None:
    """Transfer Preview progress once after acquisition, never over real progress."""

    def run(db: Session) -> None:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if _kind(db, media_id) != _PODCAST:
            raise InvalidRequestError(
                message="Preview position is supported only for Podcast episodes"
            )
        duration_ms = nullable_from_presence(position.duration_ms)
        if _listening_store.install_preview_position_if_empty_in_txn(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            position_ms=position.position_ms
            if duration_ms is None
            else min(position.position_ms, duration_ms),
            duration_ms=duration_ms,
        ):
            _bump(db, viewer_id, podcast=True)
        db.commit()

    viewer_txn("install_preview_position", viewer_id, run)


def ensure_missing_items_for_assistant_in_current_transaction(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[tuple[UUID, UUID]]:
    """Append assistant items; the caller's transaction also commits its tool record."""
    lock_viewer(db, viewer_id)
    return _lectern_store.ensure_missing_in_txn(
        db, viewer_id=viewer_id, media_ids=media_ids, source="Assistant"
    )


def remove_lectern_item_in_current_transaction(
    db: Session, *, viewer_id: UUID, item_id: UUID
) -> None:
    lock_viewer(db, viewer_id)
    _lectern_store.remove_item_if_present_in_txn(db, viewer_id=viewer_id, item_id=item_id)


def delete_media_consumption_state_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: every viewer's Lectern, state, progress and history rows."""
    _lectern_store.delete_all_users_in_txn(db, media_id=media_id)
    _listening_store.delete_all_users_in_txn(db, media_id=media_id)
    for table in (
        "consumption_overrides",
        "reader_engagement_states",
        "reader_media_state",
        "consumption_activity_exclusions",
        "consumption_activity_spans",
        "consumption_completion_facts",
    ):
        db.execute(text(f"DELETE FROM {table} WHERE media_id = :media_id"), {"media_id": media_id})


def _set_override(
    db: Session, viewer_id: UUID, media_id: UUID, status: Literal["unread", "finished"]
) -> None:
    """Write the explicit override; each write advances ``revision``, the natural-end fence."""
    db.execute(
        text("""
            INSERT INTO consumption_overrides (user_id, media_id, status, revision)
            VALUES (:viewer_id, :media_id, :status, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET status = EXCLUDED.status, revision = consumption_overrides.revision + 1
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


def _handle(completion_id: UUID | None) -> str | None:
    return seal(COMPLETION, completion_id) if completion_id is not None else None


def _kind(db: Session, media_id: UUID) -> str:
    return projection.media_kinds(db, [media_id])[media_id]


def _require_readable(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")


def _reader_kind(db: Session, viewer_id: UUID, media_id: UUID) -> str:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    kind = _kind(db, media_id)
    if not reader_cursor.supports_media_kind(kind):
        raise InvalidRequestError(message=f"Reader state is not supported for media kind '{kind}'")
    return kind


def _is_finished(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    return (
        projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])[media_id].state
        == "finished"
    )
