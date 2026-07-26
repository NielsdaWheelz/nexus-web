"""Public consumption boundary: the only module other code imports.

Command facades (``run_lectern_command`` / ``run_consumption_command``) each open
a fresh session and own one ``retry_serializable`` transaction: viewer lock ->
replay claim -> validation -> domain writes -> semantic memo -> snapshot read
(spec §5). Read facades (``get_lectern`` / ``get_listening_state`` /
``get_reader_cursor``) run on the request-scoped session. The heartbeat facade is the separately specified
unreplayable CAS mutation. Narrow in-transaction helpers exist only for media
lifecycle cleanup and the trusted ensure path.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from time import perf_counter
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
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
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
    ListeningStateOut,
    MediaProgressState,
    NextCapability,
    OrderedOutcome,
    PlacedOutcome,
    PlaceItemsCommand,
    PlayerDescriptor,
    RemovedOutcome,
    RemoveItemCommand,
    ResetProgressCommand,
    SetBatchStateCommand,
    SetUnreadCommand,
    StateOnlyOutcome,
    UndoCompletionCommand,
)
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityMetricsOut,
    ActivitySessionOut,
    ActivitySessionPageOut,
    ActivitySessionsOut,
    ActivityStatsSectionOut,
    ActivityTimelineRowOut,
    ActivityTotalsOut,
    CompletionDateOut,
    CompletionStatsSectionOut,
    CompletionTimelineRowOut,
    ConsumptionStatsOut,
    ContributorActivityBreakdownOut,
    ContributorActivityOut,
    ContributorCompletionOut,
    DeviceActivityOut,
    DeviceSummaryOut,
    LocalDayOut,
    LocalHourOut,
    MediaActivityBreakdownOut,
    MediaActivityOut,
    MediaCompletionOut,
    RetainedArtifactsOut,
)
from nexus.schemas.presence import Absent, Present, absent, nullable_from_presence, present
from nexus.schemas.reader import CursorWrite, ReaderCursorSnapshot
from nexus.services.consumption import (
    _activity_stats,
    _activity_store,
    _lectern_store,
    _listening_store,
    _policy,
    _projection,
    _reader_cursor_store,
    _reader_engagement_store,
    _state_store,
)
from nexus.services.consumption._lectern_store import (
    SUPPORTED_MEDIA_KINDS,
    LecternRow,
    LecternSource,
)
from nexus.services.consumption.handles import (
    CompletionHandle,
    seal_completion,
    seal_device,
    unseal_completion,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

LECTERN_SCOPE = "Lectern.Commands"
CONSUMPTION_SCOPE = "Consumption.Commands"
CONSUMPTION_ACTIVITY_SCOPE = "Consumption.Activity"
CONSUMPTION_STATS_LATENCY_BUDGET_MS = 500
_ACTIVITY_MAX_AGE = timedelta(days=1)
_ACTIVITY_MAX_FUTURE_SKEW = timedelta(minutes=5)
_ACTIVITY_BATCH_MAX_BYTES = 48_000
_VISIBLE_READER_MEDIA_KIND_SQL = text(f"""
WITH visible_media AS (
    {visible_media_ids_cte_sql()}
)
SELECT media.kind
FROM media
WHERE media.id = :media_id
  AND EXISTS (SELECT 1 FROM visible_media WHERE media_id = media.id)
""")

_LECTERN_OUTCOME_ADAPTER: TypeAdapter[LecternOutcome] = TypeAdapter(LecternOutcome)
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Read facades (request-scoped session)
# ---------------------------------------------------------------------------


def get_lectern(db: Session, viewer_id: UUID) -> LecternSnapshot:
    """Canonical Lectern snapshot for a viewer (visible rows only)."""
    rows = _lectern_store.load_rows(db, viewer_id=viewer_id)
    return _projection.build_snapshot(db, viewer_id=viewer_id, rows=rows)


def get_activity_sessions(
    db: Session,
    *,
    viewer_id: UUID,
    query: _activity_stats.ActivityQuery,
    cursor: str | None,
    limit: int,
    current_device_id: str,
) -> ActivitySessionPageOut:
    """One repeatable-read page of derived Consumption sessions."""
    as_of, after = (
        (_activity_stats.as_of_created_at(db), None)
        if cursor is None
        else _activity_stats.decode_session_cursor(cursor, query=query, db=db, viewer_id=viewer_id)
    )
    rows = _activity_stats.session_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=limit, after=after
    )
    page = rows[:limit]
    next_cursor = (
        _activity_stats.encode_session_cursor(as_of=as_of, query=query, row=page[-1])
        if len(rows) > limit and page
        else None
    )
    device_rows = _activity_stats.device_breakdown_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    _devices, device_summaries = _device_projections(
        device_rows,
        current_device_id=current_device_id,
        time_zone=query.time_zone,
    )
    return ActivitySessionPageOut(
        sessions=[_session_out(row, devices=device_summaries) for row in page],
        next_cursor=present(next_cursor) if next_cursor else absent(),
    )


def _active_filter_names(query: _activity_stats.ActivityQuery) -> list[str]:
    return [
        name
        for name, value in (
            ("modality", query.modality),
            ("media", query.media_id),
            ("contributor", query.contributor_handle),
            ("device", query.device_id),
        )
        if value is not None
    ]


def _device_projections(
    rows: list[dict[str, Any]],
    *,
    current_device_id: str,
    time_zone: str,
) -> tuple[list[DeviceActivityOut], dict[str, DeviceSummaryOut]]:
    """Seal private device identities and derive stable, non-identifying labels."""
    from zoneinfo import ZoneInfo

    zone = ZoneInfo(time_zone)
    prepared: list[dict[str, Any]] = []
    for row in rows:
        device_id = str(row["device_id"])
        handle = seal_device(device_id)
        classes = cast(
            list[ActivityDeviceClass],
            sorted(str(value) for value in row["device_classes"]),
        )
        first_seen = row["first_seen_at"]
        if not isinstance(first_seen, datetime):
            raise TypeError("first_seen_at must be a datetime")
        class_label = " + ".join(classes)
        base_label = (
            "This device"
            if device_id == current_device_id
            else f"{class_label} · first seen {first_seen.astimezone(zone).date().isoformat()}"
        )
        prepared.append(
            {
                **row,
                "device_id": device_id,
                "handle": handle,
                "classes": classes,
                "base_label": base_label,
            }
        )
    collisions: dict[str, list[dict[str, Any]]] = {}
    for row in prepared:
        if row["base_label"] != "This device":
            collisions.setdefault(str(row["base_label"]), []).append(row)
    for same_label in collisions.values():
        if len(same_label) <= 1:
            continue
        same_label.sort(key=lambda row: (row["first_seen_at"], str(row["handle"])))
        for ordinal, row in enumerate(same_label, start=1):
            row["base_label"] = f"{row['base_label']} · {ordinal}"

    outputs: list[DeviceActivityOut] = []
    summaries: dict[str, DeviceSummaryOut] = {}
    for row in prepared:
        first_observed = row["first_observed_at"]
        last_observed = row["last_observed_at"]
        if not isinstance(first_observed, datetime) or not isinstance(last_observed, datetime):
            raise TypeError("device observation timestamps must be datetimes")
        summary = DeviceSummaryOut(
            device_handle=row["handle"],
            label=str(row["base_label"]),
        )
        summaries[str(row["device_id"])] = summary
        outputs.append(
            DeviceActivityOut(
                device_handle=row["handle"],
                label=summary.label,
                first_observed_at=first_observed,
                last_observed_at=last_observed,
                device_classes=row["classes"],
                is_current=row["device_id"] == current_device_id,
                active_ms=int(row["active_ms"]),
            )
        )
    return outputs, summaries


def _session_out(
    row: dict[str, Any], *, devices: dict[str, DeviceSummaryOut]
) -> ActivitySessionOut:
    started_at = row["session_start"]
    ended_at = row["session_end"]
    if not isinstance(started_at, datetime) or not isinstance(ended_at, datetime):
        raise TypeError("session timestamps must be datetimes")
    device_id = str(row["device_id"])
    device = devices.get(device_id)
    if device is None:
        raise RuntimeError("session device projection is missing")
    first_progress = row.get("first_progress")
    last_progress = row.get("last_progress")
    return ActivitySessionOut(
        media_ref=f"media:{row['media_id']}",
        title=str(row["title"]),
        modality=cast(Literal["Reading", "Listening", "Viewing"], row["modality"]),
        device=device,
        started_at=started_at,
        ended_at=ended_at,
        active_ms=int(row["active_ms"]),
        forward_word_position=int(row["forward_word_position"]),
        forward_media_position_ms=int(row["forward_media_position_ms"]),
        first_progress=(present(float(first_progress)) if first_progress is not None else absent()),
        last_progress=(present(float(last_progress)) if last_progress is not None else absent()),
        continues_before_range=bool(row["continues_before_range"]),
        continues_after_range=bool(row["continues_after_range"]),
    )


def get_activity_stats(
    db: Session,
    *,
    viewer_id: UUID,
    query: _activity_stats.ActivityQuery,
    bucket: str,
    current_device_id: str,
) -> ConsumptionStatsOut:
    """Materialize one deterministic personal-history snapshot."""
    # Lazy owner imports preserve the existing search/library import graph while
    # keeping these reads behind their canonical capability modules.
    from nexus.services.highlights import count_retained_highlights
    from nexus.services.notes import count_retained_note_blocks
    from nexus.services.resource_graph.user_relations import count_retained_neutral_links

    started = perf_counter()
    as_of = _activity_stats.as_of_created_at(db)
    totals_rows = _activity_stats.activity_totals_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    totals = ActivityMetricsOut(
        active_ms=sum(int(row["active_ms"]) for row in totals_rows),
        forward_word_position=sum(int(row["forward_word_position"]) for row in totals_rows),
        forward_media_position_ms=sum(int(row["forward_media_position_ms"]) for row in totals_rows),
    )
    local_days = _activity_stats.local_day_rows(db, viewer_id=viewer_id, query=query, as_of=as_of)
    streak = _activity_stats.streak_row(db, viewer_id=viewer_id, query=query, as_of=as_of)
    session_total = _activity_stats.session_count(db, viewer_id=viewer_id, query=query, as_of=as_of)
    session_rows = _activity_stats.session_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=50
    )
    session_page = session_rows[:50]
    next_cursor = (
        _activity_stats.encode_session_cursor(as_of=as_of, query=query, row=session_page[-1])
        if len(session_rows) > 50 and session_page
        else None
    )
    device_rows = _activity_stats.device_breakdown_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    devices, device_summaries = _device_projections(
        device_rows,
        current_device_id=current_device_id,
        time_zone=query.time_zone,
    )
    sessions = [_session_out(row, devices=device_summaries) for row in session_page]
    longest_row = _activity_stats.longest_session_row(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    media_rows, media_other = _activity_stats.top_media_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    contributor_rows, contributor_other = _activity_stats.top_contributor_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of
    )
    timeline = _activity_stats.timeline_rows(
        db,
        viewer_id=viewer_id,
        query=query,
        as_of=as_of,
        bucket=bucket,
    )
    completion = _activity_stats.completion_stats_rows(
        db,
        viewer_id=viewer_id,
        query=query,
        as_of=as_of,
        bucket=bucket,
    )
    active_filters = _active_filter_names(query)
    completion_filters = [name for name in active_filters if name != "device"]
    response = ConsumptionStatsOut(
        activity=ActivityStatsSectionOut(
            applied_filters=["time", *active_filters],
            inapplicable_filters=[],
            totals=ActivityTotalsOut(
                **totals.model_dump(),
                active_days=sum(int(row["active_ms"]) >= 300_000 for row in local_days),
                streak=streak["streak"],
                longest_streak=streak["longest_streak"],
                session_count=session_total,
            ),
            timeline=[ActivityTimelineRowOut(**row) for row in timeline],
            local_days=[
                LocalDayOut(date=row["local_date"], active_ms=int(row["active_ms"]))
                for row in local_days
            ],
            local_hours=[
                LocalHourOut(hour=int(row["hour"]), active_ms=int(row["active_ms"]))
                for row in _activity_stats.local_hour_rows(
                    db, viewer_id=viewer_id, query=query, as_of=as_of
                )
            ],
            media=MediaActivityBreakdownOut(
                rows=[
                    MediaActivityOut(
                        media_ref=f"media:{row['media_id']}",
                        title=str(row["title"]),
                        active_ms=int(row["active_ms"]),
                        forward_word_position=int(row["forward_word_position"]),
                        forward_media_position_ms=int(row["forward_media_position_ms"]),
                    )
                    for row in media_rows
                ],
                other_active_ms=media_other,
            ),
            contributors=ContributorActivityBreakdownOut(
                rows=[
                    ContributorActivityOut(
                        contributor_handle=str(row["contributor_handle"]),
                        display_name=str(row["display_name"]),
                        roles=[str(role) for role in row["roles"]],
                        active_ms=int(row["active_ms"]),
                        forward_word_position=int(row["forward_word_position"]),
                        forward_media_position_ms=int(row["forward_media_position_ms"]),
                    )
                    for row in contributor_rows
                ],
                other_active_ms=contributor_other,
            ),
            devices=devices,
            sessions=ActivitySessionsOut(
                rows=sessions,
                next_cursor=present(next_cursor) if next_cursor else absent(),
            ),
            longest_session=(
                present(_session_out(longest_row, devices=device_summaries))
                if longest_row is not None
                else absent()
            ),
        ),
        completion=CompletionStatsSectionOut(
            applied_filters=["time", *completion_filters],
            inapplicable_filters=["device"] if query.device_id is not None else [],
            total=int(completion["total"]),
            dates=[
                CompletionDateOut(date=row["date"], total=int(row["total"]))
                for row in completion["dates"]
            ],
            timeline=[CompletionTimelineRowOut(**row) for row in completion["timeline"]],
            media=[
                MediaCompletionOut(
                    media_ref=f"media:{row['media_id']}",
                    title=str(row["title"]),
                    total=int(row["total"]),
                )
                for row in completion["media"]
            ],
            contributors=[
                ContributorCompletionOut(
                    contributor_handle=str(row["contributor_handle"]),
                    display_name=str(row["display_name"]),
                    roles=[str(role) for role in row["roles"]],
                    total=int(row["total"]),
                )
                for row in completion["contributors"]
            ],
            by_modality=completion["by_modality"],
        ),
        retained_artifacts=RetainedArtifactsOut(
            applied_filters=["time"],
            inapplicable_filters=active_filters,
            highlights=count_retained_highlights(
                db,
                viewer_id=viewer_id,
                start=query.start,
                end=query.end,
            ),
            note_blocks=count_retained_note_blocks(
                db,
                viewer_id=viewer_id,
                start=query.start,
                end=query.end,
            ),
            neutral_links=count_retained_neutral_links(
                db,
                viewer_id=viewer_id,
                start=query.start,
                end=query.end,
            ),
        ),
    )
    duration_ms = max(0, int((perf_counter() - started) * 1000))
    logger.info(
        "consumption_stats_read",
        duration_ms=duration_ms,
        latency_budget_ms=CONSUMPTION_STATS_LATENCY_BUDGET_MS,
        over_budget=duration_ms > CONSUMPTION_STATS_LATENCY_BUDGET_MS,
        bucket=bucket,
        bucket_count=len(response.activity.timeline),
        session_count=response.activity.totals.session_count,
    )
    return response


def engagement_fact_rows_sql() -> str:
    """Canonical consumption-fact relation; binds ``:viewer_id``.

    Columns: ``media_id``, ``read_state``, ``progress_fraction``, and
    ``last_engaged_at``.
    """
    return _projection.engagement_fact_rows_sql()


def lectern_membership_rows_sql() -> str:
    """Complete Lectern membership relation; binds ``:viewer_id``.

    Columns: ``media_id``. Hidden rows are intentionally included.
    """
    return _projection.lectern_membership_rows_sql()


def lectern_item_count(db: Session, *, viewer_id: UUID) -> int:
    """Count every Lectern row, including hidden rows."""
    return _projection.lectern_item_count(db, viewer_id=viewer_id)


def lectern_has_capacity(db: Session, *, viewer_id: UUID) -> bool:
    """Whether the complete Lectern membership is below its owned row cap."""
    return lectern_item_count(db, viewer_id=viewer_id) < _lectern_store.LECTERN_MAX_ITEMS


def recent_engagement_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[_projection.RecentEngagementAnchorFact, ...]:
    """Newest distinct visible media engagement facts, capped by ``limit``."""
    return _projection.recent_engagement_anchor_facts(db, viewer_id=viewer_id, limit=limit)


def get_listening_state(db: Session, viewer_id: UUID, media_id: UUID) -> ListeningStateOut:
    """Per-media listening state; zeros/Absent defaults when no row exists."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = _listening_store.load_state(db, viewer_id=viewer_id, media_id=media_id)
    return _projection.to_listening_state_out(row)


def get_reader_cursor(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    """Canonical reader cursor snapshot for a visible media item."""
    media_kind = _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=media_id)
    return _reader_cursor_store.load_snapshot(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media_kind=media_kind,
    )


def put_reader_cursor(
    viewer_id: UUID,
    media_id: UUID,
    write: CursorWrite,
) -> ReaderCursorSnapshot:
    """Atomically replace a cursor, current engagement, and completion transition."""
    fresh = _fresh_session()
    try:
        try:
            return retry_serializable(
                fresh,
                "reader_cursor_write",
                partial(_put_reader_cursor_op, fresh, viewer_id, media_id, write),
            )
        except IntegrityError as exc:
            if integrity_constraint_name(exc) != _reader_cursor_store.READER_MEDIA_STATE_MEDIA_FK:
                raise
            _visible_reader_media_kind(fresh, viewer_id=viewer_id, media_id=media_id)
            raise
    finally:
        fresh.close()


def _put_reader_cursor_op(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    write: CursorWrite,
) -> ReaderCursorSnapshot:
    _lock_viewer(db, viewer_id)
    media_kind = _visible_reader_media_kind(db, viewer_id=viewer_id, media_id=media_id)
    was_finished = _effective_state_is_finished(db, viewer_id=viewer_id, media_id=media_id)
    snapshot = _reader_cursor_store.put_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media_kind=media_kind,
        write=write,
    )
    _reader_engagement_store.record_engagement_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        locator=write.locator,
    )
    _record_completion_if_transitioned(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        was_finished=was_finished,
        kind=media_kind,
    )
    db.commit()
    return snapshot


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, _projection.MediaReadStateOut]:
    """Batch collection read-state for arbitrary media (MediaOut/episode surfaces).

    The one read boundary adopters use for read-state; the projection owns the
    explicit-override + listening-threshold + reader-engagement derivation."""
    return _projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)


def listening_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media listening-engagement recency (owner-scoped read for MediaOut)."""
    return _projection.listening_recency(db, viewer_id=viewer_id, media_ids=media_ids)


def reader_engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media reader-engagement recency (owner-scoped read for MediaOut)."""
    return _projection.reader_engagement_recency(db, viewer_id=viewer_id, media_ids=media_ids)


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


def reader_engagement_recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> the viewer's reader-engagement recency for one media."""
    return _projection.reader_engagement_recency_subquery_sql(
        user_param=user_param, media_expr=media_expr
    )


def listening_recency_max_subquery_sql(*, podcast_expr: str) -> str:
    """Scalar subquery -> MAX listening recency across visible podcast episodes."""
    return _projection.listening_recency_max_subquery_sql(podcast_expr=podcast_expr)


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
    progress_media_id: UUID | None = None
    completion_handle: CompletionHandle | None = None


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
            progress_media_id=_uuid_or_none(stored["progressMediaId"]),
            completion_handle=(
                CompletionHandle(str(stored["completionHandle"]))
                if stored.get("completionHandle") is not None
                else None
            ),
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
        progress_media_id=effect.progress_media_id,
        completion_handle=effect.completion_handle,
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
            "progressMediaId": str(effect.progress_media_id)
            if effect.progress_media_id is not None
            else None,
            "completionHandle": str(effect.completion_handle)
            if effect.completion_handle is not None
            else None,
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
        completion_id = _write_finished_state(db, viewer_id, command.media_id)
        return _ConsumptionEffect(
            kind="StateOnly",
            completion_handle=seal_completion(completion_id) if completion_id is not None else None,
        )
    if isinstance(command, FinishLecternItemCommand):
        return _apply_finish_lectern_item(db, viewer_id, command)
    if isinstance(command, SetUnreadCommand):
        _require_readable(db, viewer_id, command.media_id)
        _write_unread_state(db, viewer_id, command.media_id)
        return _ConsumptionEffect(kind="StateOnly")
    if isinstance(command, ResetProgressCommand):
        return _apply_reset_progress(db, viewer_id, command)
    if isinstance(command, UndoCompletionCommand):
        completion_id = unseal_completion(command.completion_handle)
        media_id = _activity_store.delete_completion_fact_in_txn(
            db, viewer_id=viewer_id, completion_id=completion_id
        )
        if media_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Completion is no longer undoable"
            )
        _write_unread_state(db, viewer_id, media_id)
        return _ConsumptionEffect(kind="StateOnly")
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
    completion_id = _write_finished_state(db, viewer_id, command.media_id)
    _lectern_store.remove_item_in_txn(db, viewer_id=viewer_id, item_id=command.item_id)
    return _ConsumptionEffect(
        kind="Removed",
        removed_item_id=command.item_id,
        next_item_id=next_item_id,
        completion_handle=seal_completion(completion_id) if completion_id is not None else None,
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
    for media_id in media_ids:
        if command.state == "Finished":
            _write_finished_state(db, viewer_id, media_id, kind=kinds.get(media_id))
        else:
            _write_unread_state(db, viewer_id, media_id)
    return _ConsumptionEffect(kind="StateOnly")


def _apply_reset_progress(
    db: Session,
    viewer_id: UUID,
    command: ResetProgressCommand,
) -> _ConsumptionEffect:
    media_kind = _visible_reader_media_kind(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
    )
    _reader_cursor_store.reset_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
        media_kind=media_kind,
    )
    _reader_engagement_store.delete_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
    )
    _state_store.clear_override_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=command.media_id,
    )
    if media_kind == MediaKind.podcast_episode.value:
        _listening_store.reset_progress_in_txn(
            db,
            viewer_id=viewer_id,
            media_id=command.media_id,
        )
    return _ConsumptionEffect(kind="StateOnly", progress_media_id=command.media_id)


def _write_finished_state(
    db: Session, viewer_id: UUID, media_id: UUID, *, kind: str | None = None
) -> UUID | None:
    """``kind`` lets an already-batch-known media kind (SetBatchState) skip the
    single-media kind lookup below; single-media callers omit it and pay one
    query, unchanged from before."""
    resolved_kind = kind if kind is not None else _media_kinds(db, [media_id]).get(media_id)
    if resolved_kind is None:
        raise AssertionError(f"missing media kind for Consumption transition: {media_id}")
    was_finished = _effective_state_is_finished(db, viewer_id=viewer_id, media_id=media_id)
    _state_store.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Finished")
    if resolved_kind == MediaKind.podcast_episode.value:
        _listening_store.mark_completed_in_txn(db, viewer_id=viewer_id, media_id=media_id)
    if was_finished:
        return None
    if not _effective_state_is_finished(db, viewer_id=viewer_id, media_id=media_id):
        raise AssertionError("Finished write did not establish canonical Finished state")
    return _activity_store.insert_completion_fact_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        modality=_policy.completion_modality_for_kind(resolved_kind),
    )


def _write_unread_state(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Set the explicit Unread status without changing current progress."""
    _state_store.set_override_in_txn(db, viewer_id=viewer_id, media_id=media_id, state="Unread")


def _build_consumption_result(
    db: Session,
    viewer_id: UUID,
    command: ConsumptionCommand,
    *,
    outcome_memo: dict[str, object],
    next_item_id: UUID | None,
    progress_media_id: UUID | None,
    completion_handle: CompletionHandle | None,
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
    progress_state: Absent | Present[MediaProgressState] = absent()
    if progress_media_id is not None:
        media_kind = _visible_reader_media_kind(
            db,
            viewer_id=viewer_id,
            media_id=progress_media_id,
        )
        reader_cursor = _reader_cursor_store.load_snapshot(
            db,
            viewer_id=viewer_id,
            media_id=progress_media_id,
            media_kind=media_kind,
        )
        listening_state = (
            present(
                _projection.to_listening_state_out(
                    _listening_store.load_state(
                        db,
                        viewer_id=viewer_id,
                        media_id=progress_media_id,
                    )
                )
            )
            if media_kind == MediaKind.podcast_episode.value
            else absent()
        )
        progress_state = present(
            MediaProgressState(
                media_id=progress_media_id,
                reader_cursor=reader_cursor,
                listening_state=listening_state,
            )
        )
    return ConsumptionResult(
        outcome=outcome,
        lectern=snapshot,
        next_item=next_item,
        progress_state=progress_state,
        completion_handle=present(completion_handle) if completion_handle is not None else absent(),
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
# Activity capture (replayable browser batches)
# ---------------------------------------------------------------------------


def record_activity_batch(
    viewer_id: UUID,
    *,
    client_mutation_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Persist one replayable, server-validated observation batch."""
    fresh = _fresh_session()
    try:
        retry_serializable(
            fresh,
            "record_activity_batch",
            partial(
                _record_activity_batch_op,
                fresh,
                viewer_id,
                client_mutation_id,
                media_id,
                device_id,
                device_class,
                batch,
            ),
        )
    finally:
        fresh.close()


def _record_activity_batch_op(
    db: Session,
    viewer_id: UUID,
    client_mutation_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    _lock_viewer(db, viewer_id)
    request = {
        "clientMutationId": str(client_mutation_id),
        "mediaId": str(media_id),
        "deviceId": device_id,
        "deviceClass": device_class,
        "batch": batch.model_dump(mode="json", by_alias=True),
    }
    request_bytes = canonical_json_bytes(request)
    try:
        stored = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=CONSUMPTION_ACTIVITY_SCOPE,
            client_mutation_id=str(client_mutation_id),
            request_bytes=request_bytes,
        )
    except ConflictError:
        logger.info(
            "consumption_activity_write",
            outcome="conflict",
            span_count=len(batch.spans),
        )
        raise
    if stored is not None:
        logger.info(
            "consumption_activity_write",
            outcome="replay",
            span_count=len(batch.spans),
        )
        db.rollback()
        return
    _validate_activity_batch(batch)
    _require_readable(db, viewer_id, media_id)
    _activity_store.insert_activity_batch_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        device_id=device_id,
        device_class=device_class,
        batch=batch,
    )
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=CONSUMPTION_ACTIVITY_SCOPE,
        client_mutation_id=str(client_mutation_id),
        request_bytes=request_bytes,
        response_json={},
        changed_lanes={},
    )
    db.commit()
    logger.info(
        "consumption_activity_write",
        outcome="accepted",
        span_count=len(batch.spans),
    )


def _validate_activity_batch(batch: ActivityBatchIn) -> None:
    encoded = canonical_json_bytes(batch.model_dump(mode="json", by_alias=True))
    if len(encoded) > _ACTIVITY_BATCH_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "Activity batch is too large")
    now = datetime.now(UTC)
    previous_end: datetime | None = None
    for span in batch.spans:
        if span.occurred_at.tzinfo is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "occurredAt must include a timezone"
            )
        if span.occurred_at < now - _ACTIVITY_MAX_AGE:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Activity span is too old")
        if span.occurred_at > now + _ACTIVITY_MAX_FUTURE_SKEW:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Activity span is in the future"
            )
        if previous_end is not None and span.occurred_at < previous_end:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Activity spans must be ordered and non-overlapping"
            )
        previous_end = span.occurred_at + timedelta(milliseconds=span.duration_ms)


# ---------------------------------------------------------------------------
# Listening heartbeat (unreplayable CAS)
# ---------------------------------------------------------------------------


def record_listening_heartbeat(
    viewer_id: UUID, media_id: UUID, heartbeat: ListeningHeartbeatIn
) -> ListeningHeartbeatResult:
    """Fence and write position/duration/speed in one txn."""
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
    was_finished = _effective_state_is_finished(db, viewer_id=viewer_id, media_id=media_id)
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
    _record_completion_if_transitioned(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        was_finished=was_finished,
        kind=MediaKind.podcast_episode.value,
    )
    db.commit()
    return ListeningHeartbeatResult(
        listening_state=_projection.to_listening_state_out(row),
        heartbeat_generation=heartbeat.heartbeat_generation,
        heartbeat_sequence=heartbeat.heartbeat_sequence,
    )


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
    """Delete all users' Lectern/override/current-progress/history rows for a media
    (teardown).

    Composed by media teardown inside its owning deletion transaction; the
    owning stores stay the sole DML owners of their tables."""
    _lectern_store.delete_all_users_in_txn(db, media_id=media_id)
    _state_store.delete_all_users_in_txn(db, media_id=media_id)
    _listening_store.delete_all_users_in_txn(db, media_id=media_id)
    _reader_cursor_store.delete_all_users_in_txn(db, media_id=media_id)
    _reader_engagement_store.delete_all_users_in_txn(db, media_id=media_id)
    _activity_store.delete_all_for_media_in_txn(db, media_id=media_id)


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


def _visible_reader_media_kind(db: Session, *, viewer_id: UUID, media_id: UUID) -> str:
    media_kind = db.execute(
        _VISIBLE_READER_MEDIA_KIND_SQL,
        {"viewer_id": viewer_id, "media_id": media_id},
    ).scalar_one_or_none()
    if media_kind is None:
        db.rollback()
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    resolved = str(media_kind)
    if not _reader_cursor_store.supports_media_kind(resolved):
        db.rollback()
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{resolved}'",
        )
    return resolved


def _effective_state_is_finished(db: Session, *, viewer_id: UUID, media_id: UUID) -> bool:
    state = _projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id]).get(
        media_id
    )
    return state is not None and state.state == "finished"


def _record_completion_if_transitioned(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    was_finished: bool,
    kind: str,
) -> None:
    if was_finished or not _effective_state_is_finished(db, viewer_id=viewer_id, media_id=media_id):
        return
    _activity_store.insert_completion_fact_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        modality=_policy.completion_modality_for_kind(kind),
    )


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
