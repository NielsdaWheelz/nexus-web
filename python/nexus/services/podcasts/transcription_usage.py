"""The transcription minute budget, its reservations and their settlement."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.billing import get_transcription_usage
from nexus.services.billing_entitlements import get_effective_entitlements

logger = get_logger(__name__)

_ENSURE_USAGE_DAY = """
    INSERT INTO podcast_transcription_usage_daily (
        user_id, usage_date, minutes_used, minutes_reserved, updated_at
    )
    VALUES (:user_id, :usage_date, 0, 0, :now)
    ON CONFLICT (user_id, usage_date) DO NOTHING
"""


@dataclass(frozen=True)
class TranscriptionBudget:
    required_minutes: int
    usage_date: date
    usage_start_date: date
    usage_end_date: date
    monthly_limit_minutes: int | None
    remaining_minutes: int | None
    fits: bool


def read_transcription_budget(
    db: Session,
    *,
    user_id: UUID,
    duration_seconds: int | None,
    now: datetime,
) -> TranscriptionBudget:
    """Read the exact entitlement-period budget for one transcript request."""
    entitlements = get_effective_entitlements(db, user_id)
    if not entitlements.can_transcribe:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Transcription requires an AI tier.")
    usage_start_date = entitlements.usage_period_start.date()
    usage_end_date = entitlements.usage_period_end.date()
    usage = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
    monthly_limit_minutes = entitlements.transcription_minutes_limit_monthly
    required_minutes = max(1, (duration_seconds + 59) // 60) if duration_seconds else 1
    remaining_minutes = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - int(usage["used"]) - int(usage["reserved"]))
    )
    return TranscriptionBudget(
        required_minutes=required_minutes,
        usage_date=now.date(),
        usage_start_date=usage_start_date,
        usage_end_date=usage_end_date,
        monthly_limit_minutes=monthly_limit_minutes,
        remaining_minutes=remaining_minutes,
        fits=remaining_minutes is None or required_minutes <= remaining_minutes,
    )


def reserve_transcription_usage(
    db: Session,
    *,
    user_id: UUID,
    budget: TranscriptionBudget,
    now: datetime,
) -> int | None:
    """Hold the admitted minutes and answer the post-reservation remainder.

    The cap predicate sums the period's *other* days in a subquery, which
    EvalPlanQual re-checks against the original snapshot, so the user row is
    locked first: without it two concurrent admissions could both pass.
    """
    db.execute(text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"), {"user_id": user_id})
    params = {
        "user_id": user_id,
        "usage_date": budget.usage_date,
        "usage_start_date": budget.usage_start_date,
        "usage_end_date": budget.usage_end_date,
        "required_minutes": budget.required_minutes,
        "monthly_limit_minutes": budget.monthly_limit_minutes,
        "now": now,
    }
    db.execute(text(_ENSURE_USAGE_DAY), params)
    admitted = db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily AS usage
            SET minutes_reserved = usage.minutes_reserved + :required_minutes,
                updated_at = :now
            WHERE usage.user_id = :user_id
              AND usage.usage_date = :usage_date
              AND (
                    CAST(:monthly_limit_minutes AS integer) IS NULL
                    OR (
                        COALESCE(
                            (
                                SELECT SUM(other.minutes_used + other.minutes_reserved)
                                FROM podcast_transcription_usage_daily other
                                WHERE other.user_id = :user_id
                                  AND other.usage_date >= :usage_start_date
                                  AND other.usage_date < :usage_end_date
                                  AND other.usage_date <> :usage_date
                            ),
                            0
                        )
                        + usage.minutes_used
                        + usage.minutes_reserved
                        + :required_minutes
                    ) <= :monthly_limit_minutes
              )
            RETURNING 1
            """
        ),
        params,
    ).fetchone()
    if admitted is None:
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=budget.usage_date.isoformat(),
            required_minutes=budget.required_minutes,
            monthly_limit_minutes=budget.monthly_limit_minutes,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED, "Monthly transcription quota exceeded"
        )
    if budget.monthly_limit_minutes is None:
        return None
    usage = get_transcription_usage(db, user_id, budget.usage_start_date, budget.usage_end_date)
    return max(0, budget.monthly_limit_minutes - int(usage["used"]) - int(usage["reserved"]))


def release_transcription_reservation(db: Session, *, media_id: UUID, now: datetime) -> None:
    """Give back any unconsumed reservation this job still holds."""
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return
    user_id, usage_date, reserved_minutes = reservation
    db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily
            SET minutes_reserved = GREATEST(minutes_reserved - :reserved_minutes, 0),
                updated_at = :now
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "reserved_minutes": reserved_minutes,
            "now": now,
        },
    )


def commit_transcription_reservation(db: Session, *, media_id: UUID, now: datetime) -> None:
    """Convert this job's reservation into used minutes."""
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return
    user_id, usage_date, reserved_minutes = reservation
    params = {
        "user_id": user_id,
        "usage_date": usage_date,
        "minutes_used": reserved_minutes,
        "now": now,
    }
    db.execute(text(_ENSURE_USAGE_DAY), params)
    db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily
            SET minutes_used = minutes_used + :minutes_used,
                minutes_reserved = GREATEST(minutes_reserved - :minutes_used, 0),
                updated_at = :now
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        params,
    )


def _claim_job_reservation(
    db: Session, *, media_id: UUID, now: datetime
) -> tuple[UUID, date, int] | None:
    """Atomically take the job's reservation, returning its pre-update values."""
    row = db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs AS job
            SET reserved_minutes = 0, reservation_usage_date = NULL, updated_at = :now
            FROM podcast_transcription_jobs AS held
            WHERE held.media_id = job.media_id
              AND job.media_id = :media_id
              AND job.reserved_minutes > 0
              AND job.reservation_usage_date IS NOT NULL
              AND job.requested_by_user_id IS NOT NULL
            RETURNING
                held.requested_by_user_id,
                held.reservation_usage_date,
                held.reserved_minutes
            """
        ),
        {"media_id": media_id, "now": now},
    ).fetchone()
    if row is None:
        return None
    return UUID(str(row[0])), row[1], int(row[2])
