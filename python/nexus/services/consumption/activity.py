"""Activity ingest and exclusions: the writes behind personal history.

A span's ``capture_key`` is its identity: a replayed key stores nothing, and a key reused with
different facts rolls the whole batch back.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityExclusionResultOut,
    ExcludeActivityIn,
    RestoreActivityExclusionIn,
)
from nexus.schemas.presence import Absent, Present, nullable_from_presence
from nexus.services.consumption import replayed_command, stats, viewer_txn
from nexus.services.consumption.handles import EXCLUSION, seal, unseal

# The stored facts a replayed capture key must match; Viewing spans carry no measurements.
_FACTS = """media_id modality device_id device_class occurred_at duration_ms progress_start
    progress_end word_start word_end media_position_start_ms media_position_end_ms""".split()


def record_batch(
    viewer_id: UUID,
    *,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Store recent, ordered, non-overlapping spans exactly once per capture key."""
    shared = {"user_id": viewer_id, "media_id": media_id, "modality": batch.modality}
    shared |= {"device_id": device_id, "device_class": device_class}
    rows = [
        shared
        | {"id": new_uuid7()}
        | {
            name: nullable_from_presence(value) if isinstance(value, Absent | Present) else value
            for name, value in span
        }
        for span in batch.spans
    ]

    def run(db: Session) -> None:
        now, previous_end = datetime.now(UTC), None
        for span in batch.spans:
            if span.occurred_at < now - timedelta(days=30):
                raise InvalidRequestError(
                    ApiErrorCode.E_ACTIVITY_EXPIRED, "Activity span is too old"
                )
            if span.occurred_at > now + timedelta(minutes=5):
                raise InvalidRequestError(message="Activity span is in the future")
            if previous_end is not None and span.occurred_at < previous_end:
                raise InvalidRequestError(
                    message="Activity spans must be ordered and non-overlapping"
                )
            previous_end = span.occurred_at + timedelta(milliseconds=span.duration_ms)
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        facts = ", ".join(_FACTS)
        # One statement reads one snapshot: the join sees only keys stored before this batch.
        if db.scalar(
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

    viewer_txn("record_activity_batch", viewer_id, run)


def exclude(
    viewer_id: UUID, *, command: ExcludeActivityIn, media_id: UUID
) -> ActivityExclusionResultOut:
    """Drop exactly one current observed session from every statistic."""

    def apply(db: Session) -> dict[str, str]:
        if command.started_at >= command.ended_at:
            raise InvalidRequestError(message="Excluded activity session has an invalid interval")
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        device_id = stats.resolve_device(db, viewer_id=viewer_id, handle=command.device_handle)
        interval = command.model_dump(include={"modality", "started_at", "ended_at"})
        if not stats.exact_session_exists(
            db, viewer_id=viewer_id, media_id=media_id, device_id=device_id, **interval
        ):
            raise InvalidRequestError(
                message="Excluded activity must name one exact current observed session"
            )
        exclusion_id = new_uuid7()
        db.execute(
            text("""
                INSERT INTO consumption_activity_exclusions
                    (id, user_id, media_id, modality, device_id, started_at, ended_at)
                VALUES (:id, :viewer_id, :media_id, :modality, :device_id, :started_at, :ended_at)
            """),
            {"id": exclusion_id, "viewer_id": viewer_id, "media_id": media_id}
            | {"device_id": device_id, **interval},
        )
        return _result("Excluded", exclusion_id)

    return _replayed(viewer_id, command, apply)


def restore(viewer_id: UUID, *, command: RestoreActivityExclusionIn) -> ActivityExclusionResultOut:
    """Count one excluded session again."""

    def apply(db: Session) -> dict[str, str]:
        params = {"id": unseal(EXCLUSION, command.exclusion_handle), "viewer_id": viewer_id}
        restored = db.scalar(
            text("""SELECT restored_at IS NOT NULL FROM consumption_activity_exclusions
                    WHERE id = :id AND user_id = :viewer_id"""),
            params,
        )
        if restored is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Activity exclusion not found")
        if restored:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Activity exclusion is already restored"
            )
        db.execute(
            text("UPDATE consumption_activity_exclusions SET restored_at = now() WHERE id = :id"),
            params,
        )
        return _result("Restored", params["id"])

    return _replayed(viewer_id, command, apply)


def _result(outcome: str, exclusion_id: UUID) -> dict[str, str]:
    return {"outcome": outcome, "exclusionHandle": seal(EXCLUSION, exclusion_id)}


def _replayed(
    viewer_id: UUID,
    command: ExcludeActivityIn | RestoreActivityExclusionIn,
    apply: Callable[[Session], dict[str, str]],
) -> ActivityExclusionResultOut:
    """One exclusion write, replayed by ``clientMutationId``; its memo is the result itself."""
    return replayed_command(
        "apply_activity_exclusion",
        "Consumption.ActivityExclusions",
        viewer_id,
        command,
        apply,
        lambda _, memo: ActivityExclusionResultOut.model_validate(memo),
    )
