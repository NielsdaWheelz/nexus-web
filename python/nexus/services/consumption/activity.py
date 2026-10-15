"""Observed activity: span ingest and session exclusions, the writes behind personal history.

A span's ``capture_key`` is its identity: a resent key stores nothing, a key reused with other
facts refuses the batch (I11). Spans too old, in the future or overlapping their predecessor
are skipped, never stored; the rest of the batch lands (one bad span no longer loses its batch).
An exclusion names one exact all-time session; at most one is active per session.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import ActivityRecordIn, ExcludeSessionIn
from nexus.services.consumption import stats, viewer_txn

_SESSION = """media_id = :media_id AND modality = :modality AND device_id = :device_id
    AND started_at = :started_at AND ended_at = :ended_at"""
# The stored facts a resent capture key must match; Viewing spans carry no measurements.
_FACTS = """media_id modality device_id device_class occurred_at duration_ms progress_start
    progress_end word_start word_end media_position_start_ms media_position_end_ms""".split()


def record(viewer_id: UUID, device_id: str, body: ActivityRecordIn) -> None:
    """Store a batch's acceptable spans exactly once per capture key."""
    now, previous_end, rows = datetime.now(UTC), None, []
    for span in body.batch.spans:
        if now - timedelta(days=30) <= span.occurred_at <= now + timedelta(minutes=5) and (
            previous_end is None or span.occurred_at >= previous_end
        ):
            previous_end = span.occurred_at + timedelta(milliseconds=span.duration_ms)
            rows.append(
                {"id": new_uuid7(), "user_id": viewer_id, "media_id": body.media_id}
                | {"modality": body.batch.modality, "device_id": device_id}
                | {"device_class": body.device_class}
                | span.model_dump()
            )

    def run(db: Session) -> None:
        if not can_read_media(db, viewer_id, body.media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        facts = ", ".join(_FACTS)
        # One statement reads one snapshot: the join sees only keys stored before this batch.
        if rows and db.scalar(
            text(f"""
                WITH submitted AS (
                    SELECT * FROM jsonb_populate_recordset(
                        NULL::consumption_activity_spans, CAST(:rows AS jsonb))
                ), inserted AS (
                    INSERT INTO consumption_activity_spans (id, capture_key, user_id, {facts})
                    SELECT id, capture_key, user_id, {facts} FROM submitted
                    ON CONFLICT (user_id, capture_key) DO NOTHING
                )
                SELECT count(*) FROM submitted s
                JOIN consumption_activity_spans stored USING (user_id, capture_key)
                WHERE ({", ".join(f"stored.{f}" for f in _FACTS)})
                      IS DISTINCT FROM ({", ".join(f"s.{f}" for f in _FACTS)})
            """),
            {"rows": json.dumps(rows, default=str)},
        ):
            raise ConflictError(
                ApiErrorCode.E_ACTIVITY_CAPTURE_CONFLICT,
                "Activity capture key was reused with different facts",
            )
        db.commit()

    viewer_txn("record_activity", viewer_id, run)


def exclude(viewer_id: UUID, exclusion_id: UUID, body: ExcludeSessionIn) -> None:
    """Stop counting one exact current session. Retry: the same id answers its row; another
    viewer's id is 409; a session already excluded under another id is success."""

    def run(db: Session) -> None:
        if body.started_at >= body.ended_at:
            raise InvalidRequestError(message="Excluded session has an invalid interval")
        owner = db.scalar(
            text("SELECT user_id FROM consumption_activity_exclusions WHERE id = :id"),
            {"id": exclusion_id},
        )
        if owner is not None:
            if owner != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Exclusion id is taken")
            return
        if not can_read_media(db, viewer_id, body.media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        params = {"id": exclusion_id, "viewer_id": viewer_id} | body.model_dump()
        # One active exclusion per session (I16): the viewer lock serializes this check.
        if db.scalar(
            text(f"""SELECT 1 FROM consumption_activity_exclusions
                     WHERE user_id = :viewer_id AND {_SESSION} AND restored_at IS NULL"""),
            params,
        ):
            return
        if not stats.exact_session_exists(db, viewer_id=viewer_id, **body.model_dump()):
            raise InvalidRequestError(message="Exclusion must name one exact current session")
        db.execute(
            text("""
                INSERT INTO consumption_activity_exclusions
                    (id, user_id, media_id, modality, device_id, started_at, ended_at)
                VALUES (:id, :viewer_id, :media_id, :modality, :device_id, :started_at, :ended_at)
            """),
            params,
        )
        db.commit()

    viewer_txn("exclude_session", viewer_id, run)


def restore(viewer_id: UUID, exclusion_id: UUID) -> None:
    """Count an excluded session again, restoring every active exclusion of its session (older
    duplicates included); already restored is success, unknown is 404."""

    def run(db: Session) -> None:
        params = {"id": exclusion_id, "viewer_id": viewer_id}
        session = db.execute(
            text("""SELECT media_id, modality, device_id, started_at, ended_at
                    FROM consumption_activity_exclusions WHERE id = :id AND user_id = :viewer_id"""),
            params,
        ).one_or_none()
        if session is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Exclusion not found")
        db.execute(
            text(f"""UPDATE consumption_activity_exclusions SET restored_at = now()
                     WHERE user_id = :viewer_id AND {_SESSION} AND restored_at IS NULL"""),
            params | session._asdict(),
        )
        db.commit()

    viewer_txn("restore_session", viewer_id, run)
