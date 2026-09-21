"""The public consumption boundary: every other module enters here.

Each mutating entry point opens its own session and runs one serializable
transaction that starts by locking the viewer row, because two browser tabs and
the Android player heartbeat the same account at once and every fence below
assumes serialized writers. Command facades additionally claim a replay memo:
a repeated clientMutationId re-reads the snapshot and rolls back. Activity
batches and heartbeats are deliberately unmemoized — capture keys and CAS
tokens already give them identity. Read facades run on the request session.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import MediaKind
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.consumption import (
    ConsumptionCommand,
    ConsumptionOutcomeKind,
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
    SetBatchStateCommand,
    SettleNaturalEndCommand,
    SetUnreadCommand,
    UndoCompletionCommand,
)
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityExclusionResultOut,
    ExcludeActivityIn,
    RestoreActivityExclusionIn,
)
from nexus.schemas.presence import Absent, Present, absent, nullable_from_presence, present
from nexus.schemas.reader import CursorWrite, ReaderCursorSnapshot
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.consumption import (
    _lectern_store,
    _listening_store,
    activity_stats,
    activity_store,
    projection,
    reader_cursor,
    state,
)
from nexus.services.consumption._lectern_store import SUPPORTED_MEDIA_KINDS, LecternRow, _dedupe
from nexus.services.consumption.handles import COMPLETION, EXCLUSION, seal, unseal
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

LECTERN_SCOPE = "Lectern.Commands"
CONSUMPTION_SCOPE = "Consumption.Commands"
CONSUMPTION_ACTIVITY_EXCLUSION_SCOPE = "Consumption.ActivityExclusions"
_ACTIVITY_MAX_AGE = timedelta(days=30)
_ACTIVITY_MAX_FUTURE_SKEW = timedelta(minutes=5)
_PODCAST_FAMILIES = (CollectionFamily.PodcastEpisodes, CollectionFamily.PodcastSubscriptions)
_LECTERN_OUTCOME = TypeAdapter[LecternOutcome](LecternOutcome)
_VISIBLE_READER_MEDIA_KIND_SQL = text(f"""
WITH visible_media AS (
    {visible_media_ids_cte_sql()}
)
SELECT media.kind
FROM media
WHERE media.id = :media_id
  AND EXISTS (SELECT 1 FROM visible_media WHERE media_id = media.id)
""")


def fresh_session() -> Session:
    """The consumption package's sole owner of a command's own session."""
    return get_session_factory()()


def _in_own_txn[T](label: str, op: Callable[[Session], T]) -> T:
    """One fresh session, one serializable transaction, ``op`` commits it."""
    with fresh_session() as db:
        return retry_serializable(db, label, lambda: op(db))


type _ReplayableCommand = (
    LecternCommand | ConsumptionCommand | ExcludeActivityIn | RestoreActivityExclusionIn
)


@dataclass(frozen=True, slots=True)
class _Memo:
    """One replay slot: the key it is filed under, and what was filed there."""

    scope: str
    client_mutation_id: str
    request_bytes: bytes
    stored: dict[str, Any] | None


def _claim_memo(db: Session, viewer_id: UUID, scope: str, command: _ReplayableCommand) -> _Memo:
    """Look the command up by (viewer, scope, mutation id, canonical request)."""
    client_mutation_id = str(command.client_mutation_id)
    request_bytes = canonical_json_bytes(command.model_dump(mode="json", by_alias=True))
    return _Memo(
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        stored=lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
        ),
    )


def _file_memo(db: Session, viewer_id: UUID, memo: _Memo, response_json: dict[str, Any]) -> None:
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=memo.scope,
        client_mutation_id=memo.client_mutation_id,
        request_bytes=memo.request_bytes,
        response_json=response_json,
    )


def _lock_viewer(db: Session, viewer_id: UUID) -> None:
    db.execute(
        text("SELECT 1 FROM users WHERE id = :viewer_id FOR UPDATE"), {"viewer_id": viewer_id}
    )


def get_lectern(db: Session, viewer_id: UUID) -> LecternSnapshot:
    """Canonical Lectern snapshot for a viewer (visible rows only)."""
    return projection.build_snapshot(
        db, viewer_id=viewer_id, rows=_lectern_store.load_rows(db, viewer_id=viewer_id)
    )


def lectern_has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the complete Lectern membership is below its owned row cap."""
    return projection.lectern_item_count(db, viewer_id=viewer_id) < _lectern_store.LECTERN_MAX_ITEMS


def get_listening_state(db: Session, viewer_id: UUID, media_id: UUID) -> ListeningStateOut:
    """Per-media listening state; zero/Absent defaults when no row exists."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return projection.to_listening_state_out(
        _listening_store.load_state(db, viewer_id=viewer_id, media_id=media_id)
    )


def get_reader_cursor(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    """Canonical reader cursor snapshot for a visible media item."""
    return reader_cursor.load_snapshot(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media_kind=_visible_reader_media_kind(db, viewer_id=viewer_id, media_id=media_id),
    )


def put_reader_cursor(viewer_id: UUID, media_id: UUID, write: CursorWrite) -> ReaderCursorSnapshot:
    """Atomically replace the cursor, engagement, and completion transition."""

    def write_cursor(db: Session) -> ReaderCursorSnapshot:
        snapshot = put_reader_cursor_in_txn(db, viewer_id=viewer_id, media_id=media_id, write=write)
        db.commit()
        return snapshot

    with fresh_session() as db:
        try:
            return retry_serializable(db, "reader_cursor_write", lambda: write_cursor(db))
        except IntegrityError as exc:
            if integrity_constraint_name(exc) != reader_cursor.MEDIA_FK:
                raise
            # The media was torn down mid-write: answer with the not-found it now is.
            _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=media_id)
            raise


def put_reader_cursor_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, write: CursorWrite
) -> ReaderCursorSnapshot:
    """Apply the canonical cursor mutation inside the caller's transaction."""
    _lock_viewer(db, viewer_id)
    media_kind = _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=media_id)
    was_finished = _is_finished(db, viewer_id=viewer_id, media_id=media_id)
    snapshot = reader_cursor.put_in_txn(
        db, viewer_id=viewer_id, media_id=media_id, media_kind=media_kind, write=write
    )
    state.record_engagement_in_txn(
        db, viewer_id=viewer_id, media_id=media_id, locator=write.locator
    )
    if not was_finished and _is_finished(db, viewer_id=viewer_id, media_id=media_id):
        _record_completion(db, viewer_id=viewer_id, media_id=media_id, kind=media_kind)
    _bump(db, viewer_id, podcast=media_kind == MediaKind.podcast_episode.value)
    return snapshot


def run_lectern_command(viewer_id: UUID, command: LecternCommand) -> LecternResult:
    """Replayable Lectern mutation."""
    return _in_own_txn("lectern_command", lambda db: _run_lectern_command(db, viewer_id, command))


def _run_lectern_command(db: Session, viewer_id: UUID, command: LecternCommand) -> LecternResult:
    _lock_viewer(db, viewer_id)
    memo = _claim_memo(db, viewer_id, LECTERN_SCOPE, command)
    if memo.stored is not None:
        result = LecternResult(
            outcome=_LECTERN_OUTCOME.validate_python(memo.stored["outcome"]),
            lectern=get_lectern(db, viewer_id),
        )
        db.rollback()
        return result

    if isinstance(command, PlaceItemsCommand):
        media_ids = _dedupe(command.media_ids)
        _validate_add_targets(db, viewer_id, media_ids)
        outcome: LecternOutcome = PlacedOutcome(
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

    snapshot = get_lectern(db, viewer_id)
    _file_memo(db, viewer_id, memo, {"outcome": outcome.model_dump(mode="json", by_alias=True)})
    db.commit()
    return LecternResult(outcome=outcome, lectern=snapshot)


def _validate_add_targets(db: Session, viewer_id: UUID, media_ids: list[UUID]) -> None:
    # include_tearing_down keeps a reachable target mid-teardown visible here so
    # it hits E_MEDIA_DELETING rather than a generic not-found; an unreachable
    # or tombstoned target still 404s, so teardown never leaks to a non-member.
    for media_id in media_ids:
        if not can_read_media(db, viewer_id, media_id, include_tearing_down=True):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if _lectern_store.teardown_intent_media(db, media_ids=media_ids):
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted")
    kinds = projection.media_kinds(db, media_ids)
    if any(kinds.get(media_id) not in SUPPORTED_MEDIA_KINDS for media_id in media_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Media cannot be added to the Lectern"
        )


@dataclass
class _Effect:
    """What one applied command changed, before the result snapshot is read."""

    kind: ConsumptionOutcomeKind | Literal["Removed"]
    removed_item_id: UUID | None = None
    next_item_id: UUID | None = None
    progress_media_id: UUID | None = None
    completion_handle: str | None = None
    revision_media_id: UUID | None = None


def run_consumption_command(viewer_id: UUID, command: ConsumptionCommand) -> ConsumptionResult:
    """Replayable consumption mutation."""
    return _in_own_txn(
        "consumption_command", lambda db: _run_consumption_command(db, viewer_id, command)
    )


def _run_consumption_command(
    db: Session, viewer_id: UUID, command: ConsumptionCommand
) -> ConsumptionResult:
    _lock_viewer(db, viewer_id)
    memo = _claim_memo(db, viewer_id, CONSUMPTION_SCOPE, command)
    if memo.stored is not None:
        result = _build_result(
            db,
            viewer_id,
            command,
            outcome=cast("dict[str, object]", memo.stored["outcome"]),
            next_item_id=_uuid_or_none(memo.stored["nextItemId"]),
            progress_media_id=_uuid_or_none(memo.stored["progressMediaId"]),
            completion_handle=_str_or_none(memo.stored["completionHandle"]),
        )
        db.rollback()
        return result

    effect = _apply_consumption_command(db, viewer_id, command)
    _bump_for_command(db, viewer_id=viewer_id, command=command, effect=effect)
    outcome: dict[str, object] = {"kind": effect.kind}
    if effect.removed_item_id is not None:
        outcome["itemId"] = str(effect.removed_item_id)
    result = _build_result(
        db,
        viewer_id,
        command,
        outcome=outcome,
        next_item_id=effect.next_item_id,
        progress_media_id=effect.progress_media_id,
        completion_handle=effect.completion_handle,
    )
    _file_memo(
        db,
        viewer_id,
        memo,
        {
            "outcome": outcome,
            "nextItemId": _str_or_none(effect.next_item_id),
            "progressMediaId": _str_or_none(effect.progress_media_id),
            "completionHandle": effect.completion_handle,
        },
    )
    db.commit()
    return result


def _apply_consumption_command(
    db: Session, viewer_id: UUID, command: ConsumptionCommand
) -> _Effect:
    if isinstance(command, EnsureMediaFinishedCommand):
        _require_readable(db, viewer_id, command.media_id)
        completion_id = _write_finished_state(db, viewer_id, command.media_id)
        return _Effect(
            kind="StateOnly",
            completion_handle=seal(COMPLETION, completion_id) if completion_id else None,
        )
    if isinstance(command, SettleNaturalEndCommand):
        return _settle_natural_end(db, viewer_id, command)
    if isinstance(command, FinishLecternItemCommand):
        rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
        target = next((row for row in rows if row.item_id == command.item_id), None)
        if target is None or target.media_id != command.media_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Lectern item not found")
        next_item_id = _select_next(rows, target.position, command.next_capability)
        completion_id = _write_finished_state(db, viewer_id, command.media_id)
        _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=command.item_id)
        return _Effect(
            kind="Removed",
            removed_item_id=command.item_id,
            next_item_id=next_item_id,
            completion_handle=seal(COMPLETION, completion_id) if completion_id else None,
        )
    if isinstance(command, SetUnreadCommand):
        _require_readable(db, viewer_id, command.media_id)
        state.set_override_in_txn(
            db, viewer_id=viewer_id, media_id=command.media_id, state="Unread"
        )
        return _Effect(kind="StateOnly", revision_media_id=command.media_id)
    if isinstance(command, ResetProgressCommand):
        return _reset_progress(db, viewer_id, command)
    if isinstance(command, UndoCompletionCommand):
        media_id = activity_store.delete_completion_fact_in_txn(
            db, viewer_id=viewer_id, completion_id=unseal(COMPLETION, command.completion_handle)
        )
        if media_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Completion is no longer undoable"
            )
        state.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Unread")
        return _Effect(kind="StateOnly", revision_media_id=media_id)
    _write_podcast_episode_states(db, viewer_id, _dedupe(command.media_ids), command.state)
    return _Effect(kind="StateOnly")


def _settle_natural_end(db: Session, viewer_id: UUID, command: SettleNaturalEndCommand) -> _Effect:
    """Fence one receipt-backed natural end on the override and listening state."""
    if not can_read_media(db, viewer_id, command.media_id):
        return _Effect(kind="TargetGone")
    media_kind = projection.media_kinds(db, [command.media_id]).get(command.media_id)
    if media_kind != MediaKind.podcast_episode.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Natural-end settlement is podcast-episode only"
        )
    if not state.override_revision_matches(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
        expected_revision=command.expected_consumption_override_revision,
    ):
        return _Effect(kind="Superseded")

    terminal = command.terminal_listening
    was_finished = _is_finished(db, viewer_id=viewer_id, media_id=command.media_id)
    listening = _listening_store.record_heartbeat_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
        position_ms=terminal.position_ms,
        duration_ms=nullable_from_presence(terminal.duration_ms),
        episode_playback_rate=terminal.episode_playback_rate,
        expected_write_revision=terminal.expected_write_revision,
        expected_reset_epoch=terminal.expected_reset_epoch,
    )
    if listening is None:
        return _Effect(kind="Superseded")

    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    target: LecternRow | None = None
    if isinstance(command.origin, LecternNaturalEndOrigin):
        target = next(
            (
                row
                for row in rows
                if row.item_id == command.origin.item_id
                and row.media_id == command.media_id
                and row.visible
            ),
            None,
        )
    if target is None:
        _write_finished_state(
            db, viewer_id, command.media_id, kind=media_kind, was_finished=was_finished
        )
        return _Effect(kind="CompletedWithoutAdvance", revision_media_id=command.media_id)
    next_item_id = _select_next(rows, target.position, command.next_capability)
    _write_finished_state(
        db, viewer_id, command.media_id, kind=media_kind, was_finished=was_finished
    )
    _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=target.item_id)
    return _Effect(kind="Completed", next_item_id=next_item_id, revision_media_id=command.media_id)


def _reset_progress(db: Session, viewer_id: UUID, command: ResetProgressCommand) -> _Effect:
    """Clear the override, tombstone the cursor, drop engagement, rewind audio."""
    media_kind = _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=command.media_id)
    reader_cursor.reset_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
    state.delete_engagement_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
    state.clear_override_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
    if media_kind == MediaKind.podcast_episode.value:
        _listening_store.reset_progress_in_txn(db, viewer_id=viewer_id, media_id=command.media_id)
    return _Effect(kind="StateOnly", progress_media_id=command.media_id)


def _write_finished_state(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    kind: str | None = None,
    was_finished: bool | None = None,
) -> UUID | None:
    """Mark finished, returning the new completion fact id on a real transition.

    ``kind`` and ``was_finished`` let a caller that already knows them skip a
    query each; single-media callers pass neither.
    """
    resolved_kind = kind if kind is not None else projection.media_kinds(db, [media_id])[media_id]
    prior_finished = (
        _is_finished(db, viewer_id=viewer_id, media_id=media_id)
        if was_finished is None
        else was_finished
    )
    state.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Finished")
    if resolved_kind == MediaKind.podcast_episode.value:
        _listening_store.mark_completed_in_txn(db, viewer_id=viewer_id, media_id=media_id)
    if prior_finished:
        return None
    return _record_completion(db, viewer_id=viewer_id, media_id=media_id, kind=resolved_kind)


def _write_podcast_episode_states(
    db: Session, viewer_id: UUID, media_ids: list[UUID], target: Literal["Finished", "Unread"]
) -> None:
    """Authorize every deduped media, reject non-episodes, then write the batch."""
    for media_id in media_ids:
        _require_readable(db, viewer_id, media_id)
    kinds = projection.media_kinds(db, media_ids)
    if any(kinds.get(media_id) != MediaKind.podcast_episode.value for media_id in media_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Batch state changes are podcast-episode only"
        )
    for media_id in media_ids:
        if target == "Finished":
            _write_finished_state(db, viewer_id, media_id, kind=MediaKind.podcast_episode.value)
        else:
            state.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Unread")


def set_podcast_episode_states_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], state: Literal["Finished", "Unread"]
) -> int:
    """Apply already-resolved episode ids in the caller's transaction."""
    normalized = _dedupe(media_ids)
    if not normalized:
        return 0
    before = projection.media_read_states(db, viewer_id=viewer_id, media_ids=normalized)
    _write_podcast_episode_states(db, viewer_id, normalized, state)
    target = "finished" if state == "Finished" else "unread"
    changed = sum(1 for media_id in normalized if before[media_id].state != target)
    if changed:
        _bump(db, viewer_id, podcast=True)
    return changed


def _build_result(
    db: Session,
    viewer_id: UUID,
    command: ConsumptionCommand,
    *,
    outcome: dict[str, object],
    next_item_id: UUID | None,
    progress_media_id: UUID | None,
    completion_handle: str | None,
) -> ConsumptionResult:
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    resolved_next_id: UUID | None = None
    next_item: Absent | Present[LecternItemOut] = absent()
    if next_item_id is not None and isinstance(
        command, FinishLecternItemCommand | SettleNaturalEndCommand
    ):
        candidate = next((row for row in rows if row.visible and row.item_id == next_item_id), None)
        if candidate is not None and projection.activation_kind(candidate) == (
            command.next_capability
        ):
            resolved_next_id = next_item_id
            next_item = present(projection.build_item(db, viewer_id=viewer_id, row=candidate))

    progress_state: Absent | Present[MediaProgressState] = absent()
    if progress_media_id is not None:
        media_kind = _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=progress_media_id)
        progress_state = present(
            MediaProgressState(
                media_id=progress_media_id,
                reader_cursor=reader_cursor.load_snapshot(
                    db, viewer_id=viewer_id, media_id=progress_media_id, media_kind=media_kind
                ),
                listening_state=(
                    present(
                        projection.to_listening_state_out(
                            _listening_store.load_state(
                                db, viewer_id=viewer_id, media_id=progress_media_id
                            )
                        )
                    )
                    if media_kind == MediaKind.podcast_episode.value
                    else absent()
                ),
            )
        )
    return ConsumptionResult(
        outcome=(
            ConsumptionRemovedOutcome(
                item_id=UUID(str(outcome["itemId"])),
                next_item_id=present(resolved_next_id) if resolved_next_id else absent(),
            )
            if outcome["kind"] == "Removed"
            else ConsumptionStateOutcome(kind=cast(ConsumptionOutcomeKind, outcome["kind"]))
        ),
        lectern=projection.build_snapshot(db, viewer_id=viewer_id, rows=rows),
        next_item=next_item,
        progress_state=progress_state,
        completion_handle=present(completion_handle) if completion_handle else absent(),
        library_entries_collection_revision=read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        ),
    )


def _select_next(
    rows: list[LecternRow], removed_position: int, capability: NextCapability
) -> UUID | None:
    if capability == "Stop":
        return None
    for row in sorted(rows, key=lambda candidate: candidate.position):
        if not row.visible or row.position <= removed_position:
            continue
        if projection.activation_kind(row) == capability:
            return row.item_id
    return None


def _bump_for_command(
    db: Session, *, viewer_id: UUID, command: ConsumptionCommand, effect: _Effect
) -> None:
    if isinstance(command, SetBatchStateCommand):
        media_ids = command.media_ids
    elif isinstance(
        command,
        EnsureMediaFinishedCommand
        | SetUnreadCommand
        | ResetProgressCommand
        | FinishLecternItemCommand,
    ):
        media_ids = [command.media_id]
    elif effect.revision_media_id is not None:
        media_ids = [effect.revision_media_id]
    else:
        return
    kinds = projection.media_kinds(db, _dedupe(media_ids))
    _bump(db, viewer_id, podcast=MediaKind.podcast_episode.value in kinds.values())


def _bump(db: Session, viewer_id: UUID, *, podcast: bool) -> None:
    bump_collection_families(
        db,
        viewer_ids=(viewer_id,),
        families=(
            (CollectionFamily.LibraryEntries, *_PODCAST_FAMILIES)
            if podcast
            else (CollectionFamily.LibraryEntries,)
        ),
    )


def record_activity_batch(
    viewer_id: UUID,
    *,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Persist one server-validated observation batch."""
    _in_own_txn(
        "record_activity_batch",
        lambda db: _record_activity_batch(db, viewer_id, media_id, device_id, device_class, batch),
    )


def _record_activity_batch(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    _lock_viewer(db, viewer_id)
    _validate_activity_spans(batch)
    _require_activity_media_readable(db, viewer_id, media_id)
    activity_store.insert_activity_batch_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        device_id=device_id,
        device_class=device_class,
        batch=batch,
    )
    db.commit()


def _validate_activity_spans(batch: ActivityBatchIn) -> None:
    """Spans are recent, not from the future, ordered, and non-overlapping."""
    now = datetime.now(UTC)
    previous_end: datetime | None = None
    for span in batch.spans:
        if span.occurred_at < now - _ACTIVITY_MAX_AGE:
            raise InvalidRequestError(ApiErrorCode.E_ACTIVITY_EXPIRED, "Activity span is too old")
        if span.occurred_at > now + _ACTIVITY_MAX_FUTURE_SKEW:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Activity span is in the future"
            )
        if previous_end is not None and span.occurred_at < previous_end:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Activity spans must be ordered and non-overlapping"
            )
        previous_end = span.occurred_at + timedelta(milliseconds=span.duration_ms)


def exclude_activity(
    viewer_id: UUID, *, command: ExcludeActivityIn, media_id: UUID
) -> ActivityExclusionResultOut:
    """Drop one exact observed session from every statistic."""
    return _in_own_txn(
        "apply_activity_exclusion", lambda db: _exclude_activity(db, viewer_id, command, media_id)
    )


def _exclude_activity(
    db: Session, viewer_id: UUID, command: ExcludeActivityIn, media_id: UUID
) -> ActivityExclusionResultOut:
    _lock_viewer(db, viewer_id)
    memo = _claim_memo(db, viewer_id, CONSUMPTION_ACTIVITY_EXCLUSION_SCOPE, command)
    if memo.stored is not None:
        return _replayed_exclusion(db, memo)
    if command.started_at >= command.ended_at:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Excluded activity session has an invalid interval"
        )
    _require_activity_media_readable(db, viewer_id, media_id)
    device_id = activity_stats.resolve_device_handle(
        db, viewer_id=viewer_id, raw=command.device_handle
    )
    if device_id is None or not activity_store.observed_session_exists_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        modality=command.modality,
        device_id=device_id,
        started_at=command.started_at,
        ended_at=command.ended_at,
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Excluded activity must name one exact current observed session",
        )
    exclusion_id = activity_store.insert_exclusion_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        modality=command.modality,
        device_id=device_id,
        started_at=command.started_at,
        ended_at=command.ended_at,
    )
    return _exclusion_result(db, viewer_id, memo, "Excluded", exclusion_id)


def restore_activity_exclusion(
    viewer_id: UUID, *, command: RestoreActivityExclusionIn
) -> ActivityExclusionResultOut:
    """Bring one excluded session's time back."""
    return _in_own_txn(
        "apply_activity_exclusion", lambda db: _restore_activity_exclusion(db, viewer_id, command)
    )


def _restore_activity_exclusion(
    db: Session, viewer_id: UUID, command: RestoreActivityExclusionIn
) -> ActivityExclusionResultOut:
    _lock_viewer(db, viewer_id)
    memo = _claim_memo(db, viewer_id, CONSUMPTION_ACTIVITY_EXCLUSION_SCOPE, command)
    if memo.stored is not None:
        return _replayed_exclusion(db, memo)
    exclusion_id = unseal(EXCLUSION, command.exclusion_handle)
    outcome = activity_store.restore_exclusion_in_txn(
        db, viewer_id=viewer_id, exclusion_id=exclusion_id
    )
    if outcome == "Missing":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Activity exclusion not found")
    if outcome == "AlreadyRestored":
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Activity exclusion is already restored"
        )
    return _exclusion_result(db, viewer_id, memo, "Restored", exclusion_id)


def _replayed_exclusion(db: Session, memo: _Memo) -> ActivityExclusionResultOut:
    db.rollback()
    return ActivityExclusionResultOut.model_validate(memo.stored)


def _exclusion_result(
    db: Session,
    viewer_id: UUID,
    memo: _Memo,
    outcome: Literal["Excluded", "Restored"],
    exclusion_id: UUID,
) -> ActivityExclusionResultOut:
    response = ActivityExclusionResultOut(
        outcome=outcome, exclusion_handle=seal(EXCLUSION, exclusion_id)
    )
    _file_memo(db, viewer_id, memo, response.model_dump(mode="json", by_alias=True))
    db.commit()
    return response


def record_listening_heartbeat(
    viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    """Fence and write position, duration, and episode rate in one transaction."""
    return _in_own_txn(
        "listening_heartbeat", lambda db: _record_heartbeat(db, viewer_id, media_id, heartbeat)
    )


def _record_heartbeat(
    db: Session, viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    _lock_viewer(db, viewer_id)
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    was_finished = _is_finished(db, viewer_id=viewer_id, media_id=media_id)
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
        db.rollback()
        raise ConflictError(ApiErrorCode.E_STALE_LISTENING_REVISION, "Listening revision is stale")
    if not was_finished and _is_finished(db, viewer_id=viewer_id, media_id=media_id):
        _record_completion(
            db, viewer_id=viewer_id, media_id=media_id, kind=MediaKind.podcast_episode.value
        )
    _bump(db, viewer_id, podcast=True)
    db.commit()
    return ListeningHeartbeatResult(
        listening_state=projection.to_listening_state_out(row),
        heartbeat_generation=heartbeat.heartbeat_generation,
        heartbeat_sequence=heartbeat.heartbeat_sequence,
    )


def install_preview_position(
    viewer_id: UUID, media_id: UUID, *, position: PreviewPositionIn
) -> None:
    """Transfer Preview progress once after acquisition, never over real progress."""
    _in_own_txn(
        "install_preview_position",
        lambda db: _install_preview_position(db, viewer_id, media_id, position),
    )


def _install_preview_position(
    db: Session, viewer_id: UUID, media_id: UUID, position: PreviewPositionIn
) -> None:
    _lock_viewer(db, viewer_id)
    if not can_read_media(db, viewer_id, media_id):
        db.rollback()
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if projection.media_kinds(db, [media_id])[media_id] != MediaKind.podcast_episode.value:
        db.rollback()
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Preview position is supported only for Podcast episodes",
        )
    duration_ms = nullable_from_presence(position.duration_ms)
    installed = _listening_store.install_preview_position_if_empty_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        position_ms=(
            min(position.position_ms, duration_ms)
            if duration_ms is not None
            else position.position_ms
        ),
        duration_ms=duration_ms,
    )
    if installed:
        _bump(db, viewer_id, podcast=True)
    db.commit()


def ensure_missing_items_for_assistant_in_current_transaction(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[tuple[UUID, UUID]]:
    """Append assistant items under the queue's viewer-lock invariant.

    The caller owns the transaction so the queue effect commits with its
    durable assistant-step record and completed tool row.
    """
    _lock_viewer(db, viewer_id)
    return _lectern_store.ensure_missing_in_txn(
        db, viewer_id=viewer_id, media_ids=media_ids, source="Assistant"
    )


def remove_lectern_item(viewer_id: UUID, item_id: UUID) -> None:
    """Remove one Lectern row, tolerating an already-removed item (assistant undo)."""

    def remove(db: Session) -> None:
        _lock_viewer(db, viewer_id)
        _lectern_store.remove_item_if_present_in_txn(db, viewer_id=viewer_id, item_id=item_id)
        db.commit()

    _in_own_txn("remove_lectern_item", remove)


def delete_media_consumption_state_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: drop every viewer's Lectern, state, progress, and history rows."""
    _lectern_store.delete_all_users_in_txn(db, media_id=media_id)
    state.delete_all_users_in_txn(db, media_id=media_id)
    _listening_store.delete_all_users_in_txn(db, media_id=media_id)
    reader_cursor.delete_all_users_in_txn(db, media_id=media_id)
    activity_store.delete_all_for_media_in_txn(db, media_id=media_id)


def _require_readable(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")


def _require_activity_media_readable(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """The activity paths report a different code: the web branches on it."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")


def _visible_reader_media_kind(db: Session, *, viewer_id: UUID, media_id: UUID) -> str:
    media_kind = db.execute(
        _VISIBLE_READER_MEDIA_KIND_SQL, {"viewer_id": viewer_id, "media_id": media_id}
    ).scalar_one_or_none()
    if media_kind is None:
        db.rollback()
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    resolved = str(media_kind)
    if not reader_cursor.supports_media_kind(resolved):
        db.rollback()
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{resolved}'",
        )
    return resolved


def _is_finished(db: Session, *, viewer_id: UUID, media_id: UUID) -> bool:
    read_state = projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id]).get(
        media_id
    )
    return read_state is not None and read_state.state == "finished"


def _record_completion(db: Session, *, viewer_id: UUID, media_id: UUID, kind: str) -> UUID | None:
    return activity_store.insert_completion_fact_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        modality=projection.completion_modality_for_kind(kind),
    )


def _uuid_or_none(value: object) -> UUID | None:
    return UUID(str(value)) if value is not None else None


def _str_or_none(value: object) -> str | None:
    return str(value) if value is not None else None
