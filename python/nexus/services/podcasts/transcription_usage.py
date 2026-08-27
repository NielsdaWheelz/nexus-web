"""Podcast transcription budget and reservation lifecycle owner."""

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

from .transcription_reservation_settlement import ensure_transcription_usage_day

logger = get_logger(__name__)


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

    required_minutes = max(1, (duration_seconds + 59) // 60) if duration_seconds else 1
    usage_start_date = entitlements.usage_period_start.date()
    usage_end_date = entitlements.usage_period_end.date()
    usage_snapshot = get_transcription_usage(
        db,
        user_id,
        usage_start_date,
        usage_end_date,
    )
    consumed_minutes = int(usage_snapshot["used"]) + int(usage_snapshot["reserved"])
    monthly_limit_minutes = entitlements.transcription_minutes_limit_monthly
    remaining_minutes = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - consumed_minutes)
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
    """Reserve an admitted request and return its post-reservation remainder."""
    assert budget.fits  # justify-service-invariant-check: only admitted work reserves usage.
    usage_snapshot = _reserve_usage_minutes_or_raise(
        db,
        user_id=user_id,
        usage_date=budget.usage_date,
        usage_start_date=budget.usage_start_date,
        usage_end_date=budget.usage_end_date,
        required_minutes=budget.required_minutes,
        monthly_limit_minutes=budget.monthly_limit_minutes,
        now=now,
    )
    if budget.monthly_limit_minutes is None:
        return None
    return max(0, budget.monthly_limit_minutes - int(usage_snapshot["total"]))


def _reserve_usage_minutes_or_raise(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    usage_start_date: date,
    usage_end_date: date,
    required_minutes: int,
    monthly_limit_minutes: int | None,
    now: datetime,
) -> dict[str, int]:
    if required_minutes <= 0:
        usage_snapshot = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
        return {
            "used": usage_snapshot["used"],
            "reserved": usage_snapshot["reserved"],
            "total": usage_snapshot["used"] + usage_snapshot["reserved"],
        }

    user_lock = db.execute(
        text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"),
        {"user_id": user_id},
    ).fetchone()
    assert (
        user_lock is not None
    )  # justify-service-invariant-check: caller already resolved the user.
    ensure_transcription_usage_day(
        db,
        user_id=user_id,
        usage_date=usage_date,
        now=now,
    )

    if monthly_limit_minutes is None:
        admitted_row = db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily
                SET
                    minutes_reserved = minutes_reserved + :required_minutes,
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                RETURNING minutes_used, minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "required_minutes": required_minutes,
                "updated_at": now,
            },
        ).fetchone()
    else:
        admitted_row = db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily AS usage
                SET
                    minutes_reserved = usage.minutes_reserved + :required_minutes,
                    updated_at = :updated_at
                WHERE usage.user_id = :user_id
                  AND usage.usage_date = :usage_date
                  AND (
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
                RETURNING usage.minutes_used, usage.minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "usage_start_date": usage_start_date,
                "usage_end_date": usage_end_date,
                "required_minutes": required_minutes,
                "monthly_limit_minutes": monthly_limit_minutes,
                "updated_at": now,
            },
        ).fetchone()
    if admitted_row is None:
        usage_before = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=usage_date.isoformat(),
            used_minutes=usage_before["used"],
            reserved_minutes=usage_before["reserved"],
            required_minutes=required_minutes,
            monthly_limit_minutes=monthly_limit_minutes,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Monthly transcription quota exceeded",
        )

    usage_after = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
    used_after = int(usage_after["used"] or 0)
    reserved_after = int(usage_after["reserved"] or 0)
    return {
        "used": used_after,
        "reserved": reserved_after,
        "total": used_after + reserved_after,
    }
