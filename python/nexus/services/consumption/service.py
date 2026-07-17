"""Public consumption boundary: the only module other code imports.

Command facades (``run_lectern_command`` / ``run_consumption_command``) each open
a fresh session and own one ``retry_serializable`` transaction: viewer lock ->
replay claim -> validation -> domain writes -> semantic memo -> snapshot read
(spec §5). Read facades (``get_lectern`` / ``get_listening_state``) run on the
request-scoped session. The heartbeat facade is the separately specified
unreplayable CAS mutation. Narrow in-transaction helpers exist only for media
lifecycle cleanup and the trusted ensure path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from typing import Literal, cast
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import MediaKind
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.attention import AttentionBlock
from nexus.schemas.consumption import (
    ConsumptionCommand,
    ConsumptionRemovedOutcome,
    ConsumptionResult,
    EnsureMediaFinishedCommand,
    FinishLecternItemCommand,
    LecternCommand,
    LecternItemOut,
    LecternOutcome,
    LecternResult,
    LecternSnapshot,
    ListeningHeartbeatIn,
    ListeningHeartbeatResult,
    ListeningStateEntry,
    ListeningStateOut,
    NextCapability,
    OrderedOutcome,
    PlacedOutcome,
    PlaceItemsCommand,
    PlayerDescriptor,
    RemovedOutcome,
    RemoveItemCommand,
    SetBatchStateCommand,
    SetUnreadCommand,
    StateOnlyOutcome,
)
from nexus.schemas.presence import Absent, Present, absent, nullable_from_presence, present
from nexus.services import attention
from nexus.services.consumption import _lectern_store, _listening_store, _projection, _state_store
from nexus.services.consumption._lectern_store import (
    SUPPORTED_MEDIA_KINDS,
    LecternRow,
    LecternSource,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

LECTERN_SCOPE = "Lectern.Commands"
CONSUMPTION_SCOPE = "Consumption.Commands"

_LECTERN_OUTCOME_ADAPTER: TypeAdapter[LecternOutcome] = TypeAdapter(LecternOutcome)


# ---------------------------------------------------------------------------
# Read facades (request-scoped session)
# ---------------------------------------------------------------------------


def get_lectern(db: Session, viewer_id: UUID) -> LecternSnapshot:
    """Canonical Lectern snapshot for a viewer (visible rows only)."""
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    return _projection.build_snapshot(db, viewer_id=viewer_id, rows=rows)


def get_listening_state(db: Session, viewer_id: UUID, media_id: UUID) -> ListeningStateOut:
    """Per-media listening state; zeros/Absent defaults when no row exists."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = _listening_store.load_state(db, viewer_id=viewer_id, media_id=media_id)
    return _projection.to_listening_state_out(row)


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, _projection.MediaReadStateOut]:
    """Batch collection read-state for arbitrary media (MediaOut/episode surfaces).

    The one read boundary adopters use for read-state; the projection owns the
    explicit-override + listening-threshold + attention-aggregate derivation."""
    return _projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)


def listening_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media listening-engagement recency (owner-scoped read for MediaOut)."""
    return _projection.listening_recency(db, viewer_id=viewer_id, media_ids=media_ids)


def player_descriptors(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, PlayerDescriptor]:
    """Batch ``PlayerDescriptor`` for podcast-episode media (MediaOut/episode-list
    adopters, spec §6). The one boundary adopters use; ``_projection`` owns the
    Lectern-identical derivation."""
    return _projection.player_descriptors(db, viewer_id=viewer_id, media_ids=media_ids)


def get_lectern_item_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> tuple[UUID, str] | None:
    """The viewer's Lectern ``(item_id, title)`` for a media, or ``None`` (assistant
    add echoes the resulting row whether it was newly ensured or already present)."""
    return _lectern_store.find_item_for_media(db, viewer_id=viewer_id, media_id=media_id)


# ---------------------------------------------------------------------------
# Episode-state SQL fragments (podcast list/detail/library adopters compose these
# through the service boundary; the raw table reads stay inside _projection).
# ---------------------------------------------------------------------------


def episode_state_case_sql(*, listening_alias: str, override_alias: str, episode_alias: str) -> str:
    """CASE expr deriving ``played``|``in_progress``|``unplayed`` (see _projection)."""
    return _projection.episode_state_case_sql(
        listening_alias=listening_alias,
        override_alias=override_alias,
        episode_alias=episode_alias,
    )


def episode_state_joins_sql(
    *, user_param: str, media_expr: str, listening_alias: str, override_alias: str
) -> str:
    """LEFT JOINs binding the viewer's listening + override rows for ``media_expr``."""
    return _projection.episode_state_joins_sql(
        user_param=user_param,
        media_expr=media_expr,
        listening_alias=listening_alias,
        override_alias=override_alias,
    )


def listening_recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> the viewer's listening-row recency for one media."""
    return _projection.listening_recency_subquery_sql(user_param=user_param, media_expr=media_expr)


def listening_recency_max_subquery_sql(*, user_param: str, podcast_expr: str) -> str:
    """Scalar subquery -> MAX listening recency across a podcast's episodes."""
    return _projection.listening_recency_max_subquery_sql(
        user_param=user_param, podcast_expr=podcast_expr
    )


# ---------------------------------------------------------------------------
# Lectern command facade
# ---------------------------------------------------------------------------


def run_lectern_command(viewer_id: UUID, command: LecternCommand) -> LecternResult:
    """Replayable Lectern mutation (fresh session + one serializable txn)."""
    fresh = _fresh_session()
    try:
        return retry_serializable(
            fresh, "lectern_command", partial(_run_lectern_command_op, fresh, viewer_id, command)
        )
    finally:
        fresh.close()


def _run_lectern_command_op(db: Session, viewer_id: UUID, command: LecternCommand) -> LecternResult:
    _lock_viewer(db, viewer_id)
    request_bytes = canonical_json_bytes(command.model_dump(mode="json", by_alias=True))
    client_mutation_id = str(command.client_mutation_id)
    stored = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=LECTERN_SCOPE,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        result = LecternResult(
            outcome=_LECTERN_OUTCOME_ADAPTER.validate_python(stored["outcome"]),
            lectern=get_lectern(db, viewer_id),
        )
        db.rollback()
        return result

    outcome = _apply_lectern_command(db, viewer_id, command)
    snapshot = get_lectern(db, viewer_id)
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=LECTERN_SCOPE,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        response_json={"outcome": outcome.model_dump(mode="json", by_alias=True)},
        changed_lanes={},
    )
    db.commit()
    return LecternResult(outcome=outcome, lectern=snapshot)


def _apply_lectern_command(db: Session, viewer_id: UUID, command: LecternCommand) -> LecternOutcome:
    if isinstance(command, PlaceItemsCommand):
        media_ids = _dedupe(command.media_ids)
        _validate_add_targets(db, viewer_id, media_ids)
        placed = _lectern_store.place_items_in_txn(
            db,
            viewer_id=viewer_id,
            media_ids=media_ids,
            placement=command.placement,
            source="Manual",
        )
        return PlacedOutcome(item_ids=placed)
    if isinstance(command, RemoveItemCommand):
        removed = _lectern_store.remove_item_in_txn(
            db, viewer_id=viewer_id, item_id=command.item_id
        )
        return RemovedOutcome(item_id=removed)
    _lectern_store.set_order_in_txn(db, viewer_id=viewer_id, item_ids=command.item_ids)
    return OrderedOutcome()


# ---------------------------------------------------------------------------
# Consumption command facade
# ---------------------------------------------------------------------------


@dataclass
class _ConsumptionEffect:
    kind: Literal["StateOnly", "Removed"]
    removed_item_id: UUID | None = None
    next_item_id: UUID | None = None
    reset_media_ids: list[UUID] = field(default_factory=list)


def run_consumption_command(viewer_id: UUID, command: ConsumptionCommand) -> ConsumptionResult:
    """Replayable consumption mutation (fresh session + one serializable txn)."""
    fresh = _fresh_session()
    try:
        return retry_serializable(
            fresh,
            "consumption_command",
            partial(_run_consumption_command_op, fresh, viewer_id, command),
        )
    finally:
        fresh.close()


def _run_consumption_command_op(
    db: Session, viewer_id: UUID, command: ConsumptionCommand
) -> ConsumptionResult:
    _lock_viewer(db, viewer_id)
    request_bytes = canonical_json_bytes(command.model_dump(mode="json", by_alias=True))
    client_mutation_id = str(command.client_mutation_id)
    stored = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=CONSUMPTION_SCOPE,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        result = _build_consumption_result(
            db,
            viewer_id,
            command,
            outcome_memo=cast("dict[str, object]", stored["outcome"]),
            next_item_id=_uuid_or_none(stored["nextItemId"]),
            reset_media_ids=[
                UUID(str(value)) for value in cast("list[object]", stored["resetMediaIds"])
            ],
        )
        db.rollback()
        return result

    effect = _apply_consumption_command(db, viewer_id, command)
    outcome_memo: dict[str, object] = {"kind": effect.kind}
    if effect.removed_item_id is not None:
        outcome_memo["itemId"] = str(effect.removed_item_id)
    result = _build_consumption_result(
        db,
        viewer_id,
        command,
        outcome_memo=outcome_memo,
        next_item_id=effect.next_item_id,
        reset_media_ids=effect.reset_media_ids,
    )
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=CONSUMPTION_SCOPE,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        response_json={
            "outcome": outcome_memo,
            "nextItemId": str(effect.next_item_id) if effect.next_item_id is not None else None,
            "resetMediaIds": [str(media_id) for media_id in effect.reset_media_ids],
        },
        changed_lanes={},
    )
    db.commit()
    return result


def _apply_consumption_command(
    db: Session, viewer_id: UUID, command: ConsumptionCommand
) -> _ConsumptionEffect:
    if isinstance(command, EnsureMediaFinishedCommand):
        _require_readable(db, viewer_id, command.media_id)
        _write_finished_state(db, viewer_id, command.media_id)
        return _ConsumptionEffect(kind="StateOnly")
    if isinstance(command, FinishLecternItemCommand):
        return _apply_finish_lectern_item(db, viewer_id, command)
    if isinstance(command, SetUnreadCommand):
        _require_readable(db, viewer_id, command.media_id)
        reset = _write_unread_state(db, viewer_id, command.media_id)
        return _ConsumptionEffect(
            kind="StateOnly", reset_media_ids=[command.media_id] if reset else []
        )
    return _apply_set_batch_state(db, viewer_id, command)


def _apply_finish_lectern_item(
    db: Session, viewer_id: UUID, command: FinishLecternItemCommand
) -> _ConsumptionEffect:
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    target = next((row for row in rows if row.item_id == command.item_id), None)
    if target is None or target.media_id != command.media_id:
        # Exact viewer/item/media agreement (spec §5.2).
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Lectern item not found")
    next_item_id = _select_next(rows, target.position, command.next_capability)
    _write_finished_state(db, viewer_id, command.media_id)
    _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=command.item_id)
    return _ConsumptionEffect(
        kind="Removed", removed_item_id=command.item_id, next_item_id=next_item_id
    )


def _apply_set_batch_state(
    db: Session, viewer_id: UUID, command: SetBatchStateCommand
) -> _ConsumptionEffect:
    media_ids = _dedupe(command.media_ids)
    for media_id in media_ids:
        _require_readable(db, viewer_id, media_id)
    kinds = _media_kinds(db, media_ids)
    if any(kinds.get(media_id) != MediaKind.podcast_episode.value for media_id in media_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Batch state changes are podcast-episode only"
        )
    # The batch already knows every media's kind (validated above); pass it
    # through instead of re-querying it once per media inside the per-media
    # writers below.
    reset_media_ids: list[UUID] = []
    for media_id in media_ids:
        if command.state == "Finished":
            _write_finished_state(db, viewer_id, media_id, kind=kinds.get(media_id))
        else:
            if _write_unread_state(db, viewer_id, media_id, kind=kinds.get(media_id)):
                reset_media_ids.append(media_id)
    return _ConsumptionEffect(kind="StateOnly", reset_media_ids=reset_media_ids)


def _write_finished_state(
    db: Session, viewer_id: UUID, media_id: UUID, *, kind: str | None = None
) -> None:
    """``kind`` lets an already-batch-known media kind (SetBatchState) skip the
    single-media kind lookup below; single-media callers omit it and pay one
    query, unchanged from before."""
    _state_store.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Finished")
    resolved_kind = kind if kind is not None else _media_kinds(db, [media_id]).get(media_id)
    if resolved_kind == MediaKind.podcast_episode.value:
        _listening_store.mark_completed_in_txn(db, viewer_id=viewer_id, media_id=media_id)


def _write_unread_state(
    db: Session, viewer_id: UUID, media_id: UUID, *, kind: str | None = None
) -> bool:
    """Set the unread override; reset an EXISTING podcast listening row. Returns
    whether a listening row was reset (and thus belongs in ``listeningStates``).

    ``kind`` lets an already-batch-known media kind (SetBatchState) skip the
    single-media kind lookup below; single-media callers omit it and pay one
    query, unchanged from before."""
    _state_store.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Unread")
    resolved_kind = kind if kind is not None else _media_kinds(db, [media_id]).get(media_id)
    if resolved_kind != MediaKind.podcast_episode.value:
        return False
    return _listening_store.reset_for_unread_in_txn(db, viewer_id=viewer_id, media_id=media_id)


def _build_consumption_result(
    db: Session,
    viewer_id: UUID,
    command: ConsumptionCommand,
    *,
    outcome_memo: dict[str, object],
    next_item_id: UUID | None,
    reset_media_ids: list[UUID],
) -> ConsumptionResult:
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    snapshot = _projection.build_snapshot(db, viewer_id=viewer_id, rows=rows)

    resolved_next_id: UUID | None = None
    next_item: Absent | Present[LecternItemOut] = absent()
    if next_item_id is not None and isinstance(command, FinishLecternItemCommand):
        candidate = next((row for row in rows if row.visible and row.item_id == next_item_id), None)
        if candidate is not None and _capability_matches(
            _projection.activation_kind(candidate), command.next_capability
        ):
            resolved_next_id = next_item_id
            next_item = present(_projection.build_item(db, viewer_id=viewer_id, row=candidate))

    outcome = _consumption_outcome(outcome_memo, resolved_next_id)
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=reset_media_ids)
    listening_states = [
        ListeningStateEntry(
            media_id=media_id, state=_projection.to_listening_state_out(listening.get(media_id))
        )
        for media_id in reset_media_ids
    ]
    return ConsumptionResult(
        outcome=outcome,
        lectern=snapshot,
        next_item=next_item,
        listening_states=listening_states,
    )


def _consumption_outcome(outcome_memo: dict[str, object], resolved_next_id: UUID | None):
    if outcome_memo["kind"] == "StateOnly":
        return StateOnlyOutcome()
    next_presence: Absent | Present[UUID] = (
        present(resolved_next_id) if resolved_next_id is not None else absent()
    )
    return ConsumptionRemovedOutcome(
        item_id=UUID(str(outcome_memo["itemId"])), next_item_id=next_presence
    )


def _select_next(
    rows: list[LecternRow], removed_position: int, capability: NextCapability
) -> UUID | None:
    if capability == "Stop":
        return None
    for row in sorted(rows, key=lambda candidate: candidate.position):
        if not row.visible or row.position <= removed_position:
            continue
        if _capability_matches(_projection.activation_kind(row), capability):
            return row.item_id
    return None


def _capability_matches(activation_kind: str, capability: NextCapability) -> bool:
    return activation_kind == capability


# ---------------------------------------------------------------------------
# Listening heartbeat (unreplayable CAS)
# ---------------------------------------------------------------------------


def record_listening_heartbeat(
    viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    """Fence, write position/duration/speed, and record dwell in one txn."""
    fresh = _fresh_session()
    try:
        return retry_serializable(
            fresh,
            "listening_heartbeat",
            partial(_record_heartbeat_op, fresh, viewer_id, media_id, heartbeat),
        )
    finally:
        fresh.close()


def _record_heartbeat_op(
    db: Session, viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    _lock_viewer(db, viewer_id)
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    duration_ms = nullable_from_presence(heartbeat.duration_ms)
    row = _listening_store.record_heartbeat_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        position_ms=heartbeat.position_ms,
        duration_ms=duration_ms,
        playback_speed=heartbeat.playback_speed,
        expected_write_revision=heartbeat.expected_write_revision,
        expected_reset_epoch=heartbeat.expected_reset_epoch,
    )
    if row is None:
        db.rollback()
        raise ConflictError(ApiErrorCode.E_STALE_LISTENING_REVISION, "Listening revision is stale")
    attention.record_attention_in_txn(
        db,
        viewer_id,
        media_id,
        AttentionBlock(
            dwell_ms_delta=heartbeat.dwell_ms_delta,
            device_id=heartbeat.device_id,
            spans_touched=[],
            progression=_audio_progression(heartbeat.position_ms, duration_ms),
        ),
    )
    db.commit()
    return ListeningHeartbeatResult(
        listening_state=_projection.to_listening_state_out(row),
        heartbeat_generation=heartbeat.heartbeat_generation,
        heartbeat_sequence=heartbeat.heartbeat_sequence,
    )


def _audio_progression(position_ms: int, duration_ms: int | None) -> float | None:
    if duration_ms is not None and duration_ms > 0:
        return min(1.0, position_ms / duration_ms)
    return None


# ---------------------------------------------------------------------------
# Trusted ensure + media-lifecycle composition helpers
# ---------------------------------------------------------------------------


def ensure_missing_items(
    viewer_id: UUID, media_ids: list[UUID], *, source: LecternSource
) -> list[tuple[UUID, UUID]]:
    """Append absent Lectern rows for a trusted source (no replay memo)."""
    fresh = _fresh_session()
    try:
        return retry_serializable(
            fresh,
            "ensure_missing_items",
            partial(_ensure_missing_items_op, fresh, viewer_id, media_ids, source),
        )
    finally:
        fresh.close()


def _ensure_missing_items_op(
    db: Session, viewer_id: UUID, media_ids: list[UUID], source: LecternSource
) -> list[tuple[UUID, UUID]]:
    _lock_viewer(db, viewer_id)
    pairs = _lectern_store.ensure_missing_in_txn(
        db, viewer_id=viewer_id, media_ids=media_ids, source=source
    )
    db.commit()
    return pairs


def ensure_missing_items_in_txn(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID], source: LecternSource
) -> list[tuple[UUID, UUID]]:
    """Compose the trusted ensure inside a caller-owned, viewer-locked txn
    (the auto-subscription watermark commit; spec §5.3)."""
    return _lectern_store.ensure_missing_in_txn(
        db, viewer_id=viewer_id, media_ids=media_ids, source=source
    )


def remove_lectern_item(viewer_id: UUID, item_id: UUID) -> None:
    """Remove one viewer Lectern row, tolerating an already-removed item.

    Service-internal (assistant undo of a trusted add); no replay memo. Fresh
    session + one serializable txn with the viewer lock (invariant 7)."""
    fresh = _fresh_session()
    try:
        retry_serializable(
            fresh,
            "remove_lectern_item",
            partial(_remove_lectern_item_op, fresh, viewer_id, item_id),
        )
    finally:
        fresh.close()


def _remove_lectern_item_op(db: Session, viewer_id: UUID, item_id: UUID) -> None:
    _lock_viewer(db, viewer_id)
    _lectern_store.remove_item_if_present_in_txn(db, viewer_id=viewer_id, item_id=item_id)
    db.commit()


def delete_media_consumption_state_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete all users' Lectern/override/listening rows for a media (teardown).

    Composed by media teardown inside its owning deletion transaction; the three
    stores stay the sole DML owners of their tables."""
    _lectern_store.delete_all_users_in_txn(db, media_id=media_id)
    _state_store.delete_all_users_in_txn(db, media_id=media_id)
    _listening_store.delete_all_users_in_txn(db, media_id=media_id)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _fresh_session() -> Session:
    fresh = get_session_factory()()
    # An open transaction would make use_serializable_if_available retain weaker
    # isolation; factory sessions must arrive clean (contributors precedent).
    assert not fresh.in_transaction(), "consumption commands require a fresh session"
    return fresh


def _lock_viewer(db: Session, viewer_id: UUID) -> None:
    db.execute(
        text("SELECT 1 FROM users WHERE id = :viewer_id FOR UPDATE"), {"viewer_id": viewer_id}
    )


def _require_readable(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")


def _validate_add_targets(db: Session, viewer_id: UUID, media_ids: list[UUID]) -> None:
    # include_tearing_down keeps a reachable, non-tombstoned target mid-teardown
    # visible here so it hits the specific E_MEDIA_DELETING below rather than a
    # generic not-found; an unreachable or tombstoned target still 404s, so the
    # teardown state never leaks to a non-member.
    for media_id in media_ids:
        if not can_read_media(db, viewer_id, media_id, include_tearing_down=True):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if _lectern_store.teardown_intent_media(db, media_ids=media_ids):
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "A target media is being deleted")
    kinds = _media_kinds(db, media_ids)
    for media_id in media_ids:
        if kinds.get(media_id) not in SUPPORTED_MEDIA_KINDS:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, "Media cannot be added to the Lectern"
            )


def _media_kinds(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    if not media_ids:
        return {}
    rows = db.execute(
        text("SELECT id, kind FROM media WHERE id = ANY(:ids)"),
        {"ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): str(row[1]) for row in rows}


def _dedupe(media_ids: list[UUID]) -> list[UUID]:
    seen: set[UUID] = set()
    result: list[UUID] = []
    for media_id in media_ids:
        if media_id in seen:
            continue
        seen.add(media_id)
        result.append(media_id)
    return result


def _uuid_or_none(value: object) -> UUID | None:
    return UUID(str(value)) if value is not None else None
