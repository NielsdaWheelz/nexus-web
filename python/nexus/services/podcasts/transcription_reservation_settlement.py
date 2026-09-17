"""Settlement owner for Podcast transcription minute reservations."""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name


def ensure_transcription_usage_day(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    now: datetime,
) -> None:
    """Materialize one zeroed daily ledger row under its identity constraint."""
    existing_row = db.execute(
        text(
            """
            SELECT 1
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id
              AND usage_date = :usage_date
            """
        ),
        {"user_id": user_id, "usage_date": usage_date},
    ).fetchone()
    if existing_row is not None:
        return

    try:
        with db.begin_nested():
            db.execute(
                text(
                    """
                    INSERT INTO podcast_transcription_usage_daily (
                        user_id,
                        usage_date,
                        minutes_used,
                        minutes_reserved,
                        updated_at
                    )
                    VALUES (
                        :user_id,
                        :usage_date,
                        0,
                        0,
                        :updated_at
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "updated_at": now,
                },
            )
    except IntegrityError as exc:
        if not _is_usage_daily_identity_conflict(exc):
            raise


def release_transcription_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    """Atomically release any unconsumed reservation owned by a Podcast job."""
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return

    user_id, usage_date, reserved_minutes = reservation
    if user_id is not None and usage_date is not None and reserved_minutes > 0:
        db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily
                SET
                    minutes_reserved = GREATEST(minutes_reserved - :reserved_minutes, 0),
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "reserved_minutes": reserved_minutes,
                "updated_at": now,
            },
        )


def commit_transcription_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    """Atomically convert one Podcast job reservation into used minutes."""
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return

    user_id, usage_date, reserved_minutes = reservation
    if user_id is None or usage_date is None or reserved_minutes <= 0:
        return

    ensure_transcription_usage_day(
        db,
        user_id=user_id,
        usage_date=usage_date,
        now=now,
    )
    result = db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily
            SET
                minutes_used = minutes_used + :minutes_used,
                minutes_reserved = GREATEST(minutes_reserved - :minutes_used, 0),
                updated_at = :updated_at
            WHERE user_id = :user_id
              AND usage_date = :usage_date
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_used": reserved_minutes,
            "updated_at": now,
        },
    )
    assert (
        getattr(result, "rowcount", 0) == 1
    )  # justify-service-invariant-check: ensured usage row exists.


def _is_usage_daily_identity_conflict(exc: IntegrityError) -> bool:
    return integrity_constraint_name(exc) == "podcast_transcription_usage_daily_pkey"


def _claim_job_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> tuple[UUID | None, date | None, int] | None:
    row = db.execute(
        text(
            """
            WITH claimed AS MATERIALIZED (
                SELECT
                    media_id,
                    requested_by_user_id,
                    reservation_usage_date,
                    reserved_minutes
                FROM podcast_transcription_jobs
                WHERE media_id = :media_id
                  AND reserved_minutes > 0
                  AND reservation_usage_date IS NOT NULL
            ),
            cleared AS (
                UPDATE podcast_transcription_jobs job
                SET
                    reserved_minutes = 0,
                    reservation_usage_date = NULL,
                    updated_at = :now
                FROM claimed
                WHERE job.media_id = claimed.media_id
                  AND job.reserved_minutes = claimed.reserved_minutes
                  AND job.reservation_usage_date = claimed.reservation_usage_date
                  AND job.reserved_minutes > 0
                  AND job.reservation_usage_date IS NOT NULL
                RETURNING
                    claimed.requested_by_user_id,
                    claimed.reservation_usage_date,
                    claimed.reserved_minutes
            )
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM cleared
            """
        ),
        {"media_id": media_id, "now": now},
    ).fetchone()
    if row is None:
        return None
    return row[0], row[1], int(row[2] or 0)
