"""Attention ledger — sole writer of ``reading_sessions`` and
``consumption_overrides`` and sole derivation owner of read-state.

Read-state derivation lives here (``consumption_state``) and nowhere else; it
reads only the two ledger tables — the pre-cutover resume/listening stores are
seeded once by the migration and never consulted again (hard-cutover doctrine).
Session continuity is a 30-minute gap rule on ``last_active_at`` serialized by
``FOR UPDATE`` on the open session row.
"""

from typing import cast
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.attention import AttentionBlock, ConsumptionStateOut
from nexus.schemas.media import MediaReadState

# Product constant, not config (D-3): two saves > 30 minutes apart open separate
# reading episodes.
ATTENTION_SESSION_GAP_SECONDS = 1800
# A single session at/above this dwell reads "in progress".
SESSION_DWELL_IN_PROGRESS_MS = 30_000
# Total dwell across sessions at/above this reads "finished" regardless of
# progression (a deliberate floor for long-form skims).
DOC_DWELL_FINISHED_MS = 120_000
# Committed progression at/above this reads "finished".
FINISHED_PROGRESSION = 0.95

_INSERT_SESSION_SQL = text("""
    INSERT INTO reading_sessions (
        user_id, media_id, device_id, started_at, last_active_at,
        dwell_ms, max_progression, spans
    )
    VALUES (
        :user_id, :media_id, :device_id, now(), now(),
        :dwell_ms, :progression, CAST(:spans AS jsonb)
    )
""").bindparams(bindparam("spans", type_=JSONB))
_SELECT_OPEN_SESSION_SQL = text("""
    SELECT id
    FROM reading_sessions
    WHERE user_id = :user_id
      AND media_id = :media_id
      AND last_active_at >= now() - make_interval(secs => :gap_seconds)
    ORDER BY last_active_at DESC
    LIMIT 1
    FOR UPDATE
""")
_UPDATE_SESSION_SQL = text("""
    UPDATE reading_sessions
    SET dwell_ms = dwell_ms + :dwell_ms,
        last_active_at = now(),
        -- GREATEST ignores NULLs, so a null progression keeps the stored max.
        -- The CAST is load-bearing: a bare NULL param in this position has no
        -- type context and Postgres rejects the statement (AmbiguousParameter).
        max_progression = GREATEST(max_progression, CAST(:progression AS real)),
        spans = spans || CAST(:spans AS jsonb)
    WHERE id = :session_id
""").bindparams(bindparam("spans", type_=JSONB))


def record_attention(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    block: AttentionBlock,
) -> None:
    """Continue the open session for (viewer, media) or open a new one.

    Callers (reader-state / listening-state routes) have already validated
    viewer access to ``media_id``; this function only writes the ledger.
    """
    # A Python list bound through the JSONB param (not a pre-serialized string):
    # double-encoding would store a jsonb *string* and trip the array CHECK.
    spans_value = [span.model_dump(mode="json") for span in block.spans_touched]
    with transaction(db):
        open_session_id = db.execute(
            _SELECT_OPEN_SESSION_SQL,
            {
                "user_id": viewer_id,
                "media_id": media_id,
                "gap_seconds": ATTENTION_SESSION_GAP_SECONDS,
            },
        ).scalar_one_or_none()

        if open_session_id is None:
            db.execute(
                _INSERT_SESSION_SQL,
                {
                    "user_id": viewer_id,
                    "media_id": media_id,
                    "device_id": block.device_id,
                    "dwell_ms": block.dwell_ms_delta,
                    "progression": block.progression,
                    "spans": spans_value,
                },
            )
            return

        # R-1: a pure no-op save (no dwell, no progression, no spans) on an
        # existing open session touches nothing.
        if block.dwell_ms_delta == 0 and block.progression is None and not block.spans_touched:
            return

        db.execute(
            _UPDATE_SESSION_SQL,
            {
                "session_id": open_session_id,
                "dwell_ms": block.dwell_ms_delta,
                "progression": block.progression,
                "spans": spans_value,
            },
        )


def set_consumption_override(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    status: str,
) -> None:
    """Upsert the explicit read-state override for (viewer, media)."""
    with transaction(db):
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        db.execute(
            text("""
                INSERT INTO consumption_overrides (user_id, media_id, status)
                VALUES (:user_id, :media_id, :status)
                ON CONFLICT (user_id, media_id)
                DO UPDATE SET status = EXCLUDED.status, created_at = now()
            """),
            {"user_id": viewer_id, "media_id": media_id, "status": status},
        )


def delete_consumption_override(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> None:
    """Remove the override for (viewer, media); idempotent (204 either way)."""
    with transaction(db):
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        db.execute(
            text("""
                DELETE FROM consumption_overrides
                WHERE user_id = :user_id AND media_id = :media_id
            """),
            {"user_id": viewer_id, "media_id": media_id},
        )


def consumption_state(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, ConsumptionStateOut]:
    """Derive read-state for a batch of media. Override wins; else session
    aggregate; else unread. Two queries total, no legacy table reads."""
    if not media_ids:
        return {}

    result: dict[UUID, ConsumptionStateOut] = {
        media_id: ConsumptionStateOut(status="unread", progress_fraction=None)
        for media_id in media_ids
    }

    override_rows = db.execute(
        text("""
            SELECT media_id, status
            FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = ANY(:ids)
        """),
        {"viewer_id": viewer_id, "ids": media_ids},
    ).fetchall()
    overridden: set[UUID] = set()
    for row in override_rows:
        media_id = UUID(str(row[0]))
        overridden.add(media_id)
        # consumption_overrides.status is CHECK-constrained to ('unread', 'finished').
        result[media_id] = ConsumptionStateOut(
            status=cast(MediaReadState, row[1]), progress_fraction=None
        )

    remaining = [media_id for media_id in media_ids if media_id not in overridden]
    if not remaining:
        return result

    agg_rows = db.execute(
        text("""
            SELECT
                media_id,
                MAX(max_progression) AS max_progression,
                COALESCE(SUM(dwell_ms), 0) AS total_dwell_ms,
                COALESCE(MAX(dwell_ms), 0) AS max_session_dwell_ms
            FROM reading_sessions
            WHERE user_id = :viewer_id AND media_id = ANY(:ids)
            GROUP BY media_id
        """),
        {"viewer_id": viewer_id, "ids": remaining},
    ).fetchall()
    for row in agg_rows:
        media_id = UUID(str(row[0]))
        max_progression = float(row[1]) if row[1] is not None else None
        total_dwell_ms = int(row[2])
        max_session_dwell_ms = int(row[3])

        if (
            max_progression is not None and max_progression >= FINISHED_PROGRESSION
        ) or total_dwell_ms >= DOC_DWELL_FINISHED_MS:
            result[media_id] = ConsumptionStateOut(status="finished", progress_fraction=None)
        elif max_session_dwell_ms >= SESSION_DWELL_IN_PROGRESS_MS:
            result[media_id] = ConsumptionStateOut(
                status="in_progress", progress_fraction=max_progression
            )
        # else: leave the default unread.

    return result


def attention_on_day(
    db: Session,
    viewer_id: UUID,
    month: int,
    day: int,
) -> list[tuple[UUID, int]]:
    """Return (media_id, total_dwell_ms) for every media the viewer read on the
    given calendar (month, day) across all years, sorted by dwell desc.

    No ``exclude_year`` parameter (D-7): callers filter by year if needed."""
    rows = db.execute(
        text("""
            SELECT media_id, COALESCE(SUM(dwell_ms), 0) AS total_dwell_ms
            FROM reading_sessions
            WHERE user_id = :viewer_id
              AND EXTRACT(MONTH FROM started_at) = :month
              AND EXTRACT(DAY FROM started_at) = :day
            GROUP BY media_id
            ORDER BY total_dwell_ms DESC, media_id ASC
        """),
        {"viewer_id": viewer_id, "month": month, "day": day},
    ).fetchall()
    return [(UUID(str(row[0])), int(row[1])) for row in rows]
