"""Attention ledger — sole writer of ``reading_sessions`` and sole owner of the
document-session dwell aggregate the consumption projection consumes.

Attention no longer owns explicit read-state overrides: the consumption package
(``services/consumption/_state_store.py``) is the sole writer and reader of the
explicit read-state override table (spec lectern-player-lifecycle-hard-cutover.md
§3). Attention exposes only its narrowed session aggregates + recency to that
projection. Session continuity is a 30-minute gap rule on ``last_active_at``
serialized by ``FOR UPDATE`` on the open session row.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.attention import AttentionBlock

# Product constant, not config (D-3): two saves > 30 minutes apart open separate
# reading episodes.
ATTENTION_SESSION_GAP_SECONDS = 1800
# The read-state thresholds (session/total dwell, progression) moved to the
# consumption projection (services/consumption/_projection.py), which now owns the
# combined explicit + listening + session derivation. Attention exposes only the
# raw session aggregates below.

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

    Public single-operation boundary for the reader route: owns its own
    transaction. The consumption listening-heartbeat facade instead composes the
    dwell write inside its own transaction via :func:`record_attention_in_txn`.
    """
    with transaction(db):
        record_attention_in_txn(db, viewer_id, media_id, block)


def record_attention_in_txn(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    block: AttentionBlock,
) -> None:
    """In-transaction dwell write, composable inside a caller-owned mutation.

    Validates media visibility itself: attention-only reader-state writes never
    touch the cursor service, so no other owner has vouched for access.
    """
    # A Python list bound through the JSONB param (not a pre-serialized string):
    # double-encoding would store a jsonb *string* and trip the array CHECK.
    spans_value = [span.model_dump(mode="json") for span in block.spans_touched]
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
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


@dataclass(frozen=True)
class SessionAggregate:
    """Narrowed reading-session aggregate the consumption projection consumes."""

    max_progression: float | None
    total_dwell_ms: int
    max_session_dwell_ms: int


def session_aggregates(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, SessionAggregate]:
    """Per-media reading-session aggregates (max progression, total dwell, and
    max single-session dwell). Keeps ``reading_sessions`` reads inside attention;
    the consumption projection combines these with explicit/listening state."""
    if not media_ids:
        return {}
    rows = db.execute(
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
        {"viewer_id": viewer_id, "ids": media_ids},
    ).fetchall()
    return {
        UUID(str(row[0])): SessionAggregate(
            max_progression=float(row[1]) if row[1] is not None else None,
            total_dwell_ms=int(row[2]),
            max_session_dwell_ms=int(row[3]),
        )
        for row in rows
    }


def reading_recency(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, datetime]:
    """Per-media document-reading recency (MAX ``last_active_at``). Keeps
    ``reading_sessions`` reads inside attention; the media projection uses this for
    a document's ``last_engaged_at``."""
    if not media_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT media_id, MAX(last_active_at)
            FROM reading_sessions
            WHERE user_id = :viewer_id AND media_id = ANY(:ids)
            GROUP BY media_id
        """),
        {"viewer_id": viewer_id, "ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): row[1] for row in rows}


def reading_recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> MAX ``last_active_at`` of the viewer's reading sessions for
    ``media_expr``. Composed by adopters (e.g. library recency) so ``reading_sessions``
    reads stay inside attention."""
    return f"""(
        SELECT MAX(rs_recency.last_active_at)
        FROM reading_sessions rs_recency
        WHERE rs_recency.user_id = {user_param}
          AND rs_recency.media_id = {media_expr}
    )"""


def delete_media_state(db: Session, media_id: UUID) -> None:
    """Delete every reading-session row for a media (media teardown only).

    In-transaction helper composed by media teardown inside its owning
    deletion transaction (spec §3): attention stays the sole writer of
    ``reading_sessions``.
    """
    db.execute(
        text("DELETE FROM reading_sessions WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


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
