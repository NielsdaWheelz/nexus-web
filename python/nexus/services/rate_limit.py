"""Rate limiting service backed by Postgres runtime tables."""

from __future__ import annotations

import hashlib
from collections.abc import Generator
from contextlib import contextmanager
from datetime import date
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.billing import get_platform_token_usage
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

DEFAULT_RPM_LIMIT = 20
DEFAULT_CONCURRENT_LIMIT = 3

RPM_WINDOW_SECONDS = 60
REQUEST_LOG_RETENTION_SECONDS = 3600
RATE_LIMITER_UNAVAILABLE_MESSAGE = "Rate limiting service unavailable"


class RateLimiter:
    """Rate limiter backed by durable Postgres state."""

    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session] | None = None,
        rpm_limit: int = DEFAULT_RPM_LIMIT,
        concurrent_limit: int = DEFAULT_CONCURRENT_LIMIT,
    ) -> None:
        self._session_factory = session_factory
        self._rpm_limit = int(rpm_limit)
        self._concurrent_limit = int(concurrent_limit)

    @property
    def backend_available(self) -> bool:
        return self._session_factory is not None

    def check_rpm_limit(self, user_id: UUID) -> None:
        """Check-and-record one request against per-minute quota."""
        if not self.backend_available:
            logger.warning("rate_limit_backend_unavailable", check="rpm")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                RATE_LIMITER_UNAVAILABLE_MESSAGE,
            )

        with self._db_strict(
            "rate_limit_check_failed",
            raise_code=ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
            raise_msg=RATE_LIMITER_UNAVAILABLE_MESSAGE,
            check="rpm",
        ) as db:
            self._lock_scope(db, scope="rpm", user_id=user_id)
            db.execute(
                text(
                    """
                    DELETE FROM rate_limit_request_log
                    WHERE requested_at < (
                        now() - (CAST(:retention_seconds AS integer) * interval '1 second')
                    )
                    """
                ),
                {"retention_seconds": REQUEST_LOG_RETENTION_SECONDS},
            )
            db.execute(
                text(
                    """
                    INSERT INTO rate_limit_request_log (user_id)
                    VALUES (:user_id)
                    """
                ),
                {"user_id": user_id},
            )
            count = int(
                db.execute(
                    text(
                        """
                        SELECT COUNT(*)
                        FROM rate_limit_request_log
                        WHERE user_id = :user_id
                          AND requested_at >= (
                              now() - (CAST(:window_seconds AS integer) * interval '1 second')
                          )
                        """
                    ),
                    {"user_id": user_id, "window_seconds": RPM_WINDOW_SECONDS},
                ).scalar_one()
            )
            db.commit()

        if count > self._rpm_limit:
            logger.warning("rate_limit.blocked", **safe_kv(limit_type="rpm"))
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITED,
                f"Rate limit exceeded: {self._rpm_limit} requests per minute",
            )

    def check_concurrent_limit(self, user_id: UUID) -> None:
        """Check the current in-flight count without mutating it."""
        if not self.backend_available:
            logger.warning("rate_limit_backend_unavailable", check="concurrent")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                RATE_LIMITER_UNAVAILABLE_MESSAGE,
            )

        with self._db_strict(
            "rate_limit_check_failed",
            raise_code=ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
            raise_msg=RATE_LIMITER_UNAVAILABLE_MESSAGE,
            check="concurrent",
        ) as db:
            self._lock_scope(db, scope="inflight", user_id=user_id)
            row = db.execute(
                text(
                    """
                    SELECT inflight_count
                    FROM rate_limit_inflight
                    WHERE user_id = :user_id
                    """
                ),
                {"user_id": user_id},
            ).first()
            db.commit()

        current = int(row[0]) if row is not None else 0
        if current >= self._concurrent_limit:
            logger.warning("rate_limit.blocked", **safe_kv(limit_type="concurrent"))
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITED,
                f"Too many concurrent requests: {self._concurrent_limit} maximum",
            )

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        """Atomically check and increment one in-flight slot."""
        if not self.backend_available:
            logger.warning("rate_limit_backend_unavailable", check="inflight_acquire")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                RATE_LIMITER_UNAVAILABLE_MESSAGE,
            )

        with self._db_strict(
            "inflight_acquire_failed",
            raise_code=ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
            raise_msg=RATE_LIMITER_UNAVAILABLE_MESSAGE,
            user_id=str(user_id),
        ) as db:
            self._lock_scope(db, scope="inflight", user_id=user_id)
            current = self._ensure_inflight_row(db=db, user_id=user_id)
            if current >= self._concurrent_limit:
                db.rollback()
                logger.warning("rate_limit.blocked", **safe_kv(limit_type="concurrent"))
                raise ApiError(
                    ApiErrorCode.E_RATE_LIMITED,
                    f"Too many concurrent requests: {self._concurrent_limit} maximum",
                )
            db.execute(
                text(
                    """
                    UPDATE rate_limit_inflight
                    SET inflight_count = :next_count, updated_at = now()
                    WHERE user_id = :user_id
                    """
                ),
                {
                    "user_id": user_id,
                    "next_count": current + 1,
                },
            )
            db.commit()

    def release_inflight_slot(self, user_id: UUID) -> None:
        """Decrement one in-flight slot (clamped at zero)."""
        if not self.backend_available:
            return

        with self._db_swallow("inflight_release_failed", user_id=str(user_id)) as db:
            self._lock_scope(db, scope="inflight", user_id=user_id)
            db.execute(
                text(
                    """
                    UPDATE rate_limit_inflight
                    SET inflight_count = GREATEST(inflight_count - 1, 0),
                        updated_at = now()
                    WHERE user_id = :user_id
                    """
                ),
                {"user_id": user_id},
            )
            db.commit()

    def check_token_budget(self, user_id: UUID) -> None:
        """Check monthly platform-token quota against spent+reserved totals."""
        if not self.backend_available:
            logger.warning("token_budget_backend_unavailable")
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                RATE_LIMITER_UNAVAILABLE_MESSAGE,
            )

        with self._db_strict(
            "token_budget_check_failed",
            raise_code=ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
            raise_msg=RATE_LIMITER_UNAVAILABLE_MESSAGE,
        ) as db:
            usage_date = self._db_utc_date(db)
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
            )
            entitlements = get_effective_entitlements(db, user_id)
            period_start = entitlements.usage_period_start.date()
            period_end = entitlements.usage_period_end.date()
            monthly_usage = get_platform_token_usage(db, user_id, period_start, period_end)
            db.commit()

        if not entitlements.can_use_platform_llm:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED, "Platform LLM access requires an AI tier."
            )

        monthly_limit = entitlements.platform_token_limit_monthly
        if monthly_limit is None:
            return

        if monthly_limit <= 0:
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                "Monthly AI token quota exceeded",
            )

        if monthly_usage["used"] + monthly_usage["reserved"] >= monthly_limit:
            logger.warning("token_budget.exceeded", **safe_kv(key_mode="platform"))
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                "Monthly AI token quota exceeded",
            )

    def reserve_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
        est_tokens: int,
        ttl: int = 300,
    ) -> None:
        """Reserve budget before streaming provider execution."""
        if not self.backend_available:
            logger.warning("token_budget_reserve_backend_unavailable")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                RATE_LIMITER_UNAVAILABLE_MESSAGE,
            )
        if est_tokens <= 0:
            return

        ttl_seconds = max(int(ttl), 1)

        with self._db_strict(
            "token_budget_reserve_failed",
            raise_code=ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
            raise_msg=RATE_LIMITER_UNAVAILABLE_MESSAGE,
        ) as db:
            usage_date = self._db_utc_date(db)
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
            )
            existing = db.execute(
                text(
                    """
                    SELECT reservation_id
                    FROM token_budget_reservations
                    WHERE reservation_id = :reservation_id
                      AND user_id = :user_id
                    FOR UPDATE
                    """
                ),
                {"reservation_id": reservation_id, "user_id": user_id},
            ).first()
            if existing is not None:
                db.commit()
                return

            entitlements = get_effective_entitlements(db, user_id)
            period_start = entitlements.usage_period_start.date()
            period_end = entitlements.usage_period_end.date()
            monthly_usage = get_platform_token_usage(db, user_id, period_start, period_end)
            monthly_limit = entitlements.platform_token_limit_monthly
            if not entitlements.can_use_platform_llm:
                db.rollback()
                raise ApiError(
                    ApiErrorCode.E_BILLING_REQUIRED,
                    "Platform LLM access requires an AI tier.",
                )

            next_total = monthly_usage["used"] + monthly_usage["reserved"] + int(est_tokens)
            if monthly_limit is not None and next_total > monthly_limit:
                db.rollback()
                raise ApiError(
                    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                    (
                        "Monthly AI token quota would be exceeded "
                        f"(used={monthly_usage['used']}, "
                        f"reserved={monthly_usage['reserved']}, "
                        f"requested={int(est_tokens)}, limit={monthly_limit})"
                    ),
                )

            db.execute(
                text(
                    """
                    INSERT INTO token_budget_reservations (
                        reservation_id,
                        user_id,
                        usage_date,
                        reserved_tokens,
                        expires_at
                    )
                    VALUES (
                        :reservation_id,
                        :user_id,
                        :usage_date,
                        :reserved_tokens,
                        now() + (CAST(:ttl_seconds AS integer) * interval '1 second')
                    )
                    """
                ),
                {
                    "reservation_id": reservation_id,
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "reserved_tokens": int(est_tokens),
                    "ttl_seconds": ttl_seconds,
                },
            )
            db.execute(
                text(
                    """
                    UPDATE token_budget_daily_usage
                    SET reserved_tokens = reserved_tokens + :reserved_tokens,
                        updated_at = now()
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "reserved_tokens": int(est_tokens),
                    "user_id": user_id,
                    "usage_date": usage_date,
                },
            )
            db.commit()

    def commit_token_budget(self, user_id: UUID, reservation_id: UUID, actual_tokens: int) -> None:
        """Commit a reservation and charge actual usage once."""
        if not self.backend_available:
            return

        normalized_tokens = max(int(actual_tokens), 0)

        with self._db_swallow(
            "token_budget_commit_failed",
            user_id=str(user_id),
            reservation_id=str(reservation_id),
        ) as db:
            reservation = (
                db.execute(
                    text(
                        """
                        SELECT usage_date, reserved_tokens
                        FROM token_budget_reservations
                        WHERE reservation_id = :reservation_id
                          AND user_id = :user_id
                        FOR UPDATE
                        """
                    ),
                    {"reservation_id": reservation_id, "user_id": user_id},
                )
                .mappings()
                .first()
            )
            usage_date = (
                reservation["usage_date"] if reservation is not None else self._db_utc_date(db)
            )
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
            )

            if reservation is not None:
                db.execute(
                    text(
                        """
                        DELETE FROM token_budget_reservations
                        WHERE reservation_id = :reservation_id
                          AND user_id = :user_id
                        """
                    ),
                    {"reservation_id": reservation_id, "user_id": user_id},
                )
                db.execute(
                    text(
                        """
                        UPDATE token_budget_daily_usage
                        SET reserved_tokens = GREATEST(
                                reserved_tokens - :reserved_tokens,
                                0
                            ),
                            updated_at = now()
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {
                        "reserved_tokens": int(reservation["reserved_tokens"]),
                        "user_id": user_id,
                        "usage_date": usage_date,
                    },
                )

            existing_charge = self._token_budget_charge_exists(db=db, message_id=reservation_id)
            if not existing_charge:
                self._insert_token_budget_charge(
                    db=db,
                    message_id=reservation_id,
                    user_id=user_id,
                    usage_date=usage_date,
                    charged_tokens=normalized_tokens,
                )
            if not existing_charge and normalized_tokens > 0:
                db.execute(
                    text(
                        """
                        UPDATE token_budget_daily_usage
                        SET spent_tokens = spent_tokens + :charged_tokens,
                            updated_at = now()
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {
                        "charged_tokens": normalized_tokens,
                        "user_id": user_id,
                        "usage_date": usage_date,
                    },
                )
            db.commit()

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        """Release an outstanding reservation without spending."""
        if not self.backend_available:
            return

        with self._db_swallow(
            "token_budget_release_failed",
            user_id=str(user_id),
            reservation_id=str(reservation_id),
        ) as db:
            reservation = (
                db.execute(
                    text(
                        """
                        SELECT usage_date, reserved_tokens
                        FROM token_budget_reservations
                        WHERE reservation_id = :reservation_id
                          AND user_id = :user_id
                        FOR UPDATE
                        """
                    ),
                    {"reservation_id": reservation_id, "user_id": user_id},
                )
                .mappings()
                .first()
            )
            if reservation is None:
                db.commit()
                return

            usage_date = reservation["usage_date"]
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
            )
            db.execute(
                text(
                    """
                    DELETE FROM token_budget_reservations
                    WHERE reservation_id = :reservation_id
                      AND user_id = :user_id
                    """
                ),
                {"reservation_id": reservation_id, "user_id": user_id},
            )
            db.execute(
                text(
                    """
                    UPDATE token_budget_daily_usage
                    SET reserved_tokens = GREATEST(
                            reserved_tokens - :reserved_tokens,
                            0
                        ),
                        updated_at = now()
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "reserved_tokens": int(reservation["reserved_tokens"]),
                    "user_id": user_id,
                    "usage_date": usage_date,
                },
            )
            db.commit()

    @contextmanager
    def _db_swallow(self, warn_msg: str, **warn_kw: object) -> Generator[Session, None, None]:
        """Open a session; on non-ApiError exceptions log a warning and swallow."""
        try:
            with self._session() as db:
                yield db
        except (
            Exception
        ) as exc:  # justify-ignore-error: rate limiter must fail closed on any DB-session failure
            logger.warning(warn_msg, error=str(exc), **warn_kw)

    @contextmanager
    def _db_strict(
        self, warn_msg: str, raise_code: ApiErrorCode, raise_msg: str, **warn_kw: object
    ) -> Generator[Session, None, None]:
        """Open a session; re-raise ApiError, wrap other exceptions into a new ApiError."""
        try:
            with self._session() as db:
                yield db
        except ApiError:
            raise
        except (
            Exception
        ) as exc:  # justify-ignore-error: rate limiter must fail closed on any DB-session failure
            logger.warning(warn_msg, error=str(exc), **warn_kw)
            raise ApiError(raise_code, raise_msg) from exc

    def _load_budget_totals_for_update(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
    ) -> tuple[int, int]:
        self._lock_scope(db, scope="budget", user_id=user_id, usage_date=usage_date)
        self._ensure_daily_usage_row(db=db, user_id=user_id, usage_date=usage_date)
        row = self._select_daily_usage_for_update(db=db, user_id=user_id, usage_date=usage_date)
        expired_total = self._expire_reservations(
            db=db,
            user_id=user_id,
            usage_date=usage_date,
        )
        if expired_total > 0:
            db.execute(
                text(
                    """
                    UPDATE token_budget_daily_usage
                    SET reserved_tokens = GREATEST(reserved_tokens - :expired_total, 0),
                        updated_at = now()
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "expired_total": expired_total,
                    "user_id": user_id,
                    "usage_date": usage_date,
                },
            )
            row = self._select_daily_usage_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
            )
        return int(row["spent_tokens"]), int(row["reserved_tokens"])

    def _ensure_inflight_row(self, *, db: Session, user_id: UUID) -> int:
        row = db.execute(
            text(
                """
                SELECT inflight_count
                FROM rate_limit_inflight
                WHERE user_id = :user_id
                FOR UPDATE
                """
            ),
            {"user_id": user_id},
        ).first()
        if row is not None:
            return int(row[0])
        db.execute(
            text(
                """
                INSERT INTO rate_limit_inflight (user_id, inflight_count, updated_at)
                VALUES (:user_id, 0, now())
                """
            ),
            {"user_id": user_id},
        )
        return 0

    def _ensure_daily_usage_row(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
    ) -> None:
        existing = db.execute(
            text(
                """
                SELECT 1
                FROM token_budget_daily_usage
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                """
            ),
            {"user_id": user_id, "usage_date": usage_date},
        ).first()
        if existing is not None:
            return
        db.execute(
            text(
                """
                INSERT INTO token_budget_daily_usage (
                    user_id,
                    usage_date,
                    spent_tokens,
                    reserved_tokens
                )
                VALUES (:user_id, :usage_date, 0, 0)
                """
            ),
            {"user_id": user_id, "usage_date": usage_date},
        )

    def _select_daily_usage_for_update(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
    ) -> dict[str, int]:
        row = (
            db.execute(
                text(
                    """
                    SELECT spent_tokens, reserved_tokens
                    FROM token_budget_daily_usage
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    FOR UPDATE
                    """
                ),
                {"user_id": user_id, "usage_date": usage_date},
            )
            .mappings()
            .one()
        )
        return {
            "spent_tokens": int(row["spent_tokens"]),
            "reserved_tokens": int(row["reserved_tokens"]),
        }

    def _expire_reservations(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
    ) -> int:
        expired_total = db.execute(
            text(
                """
                WITH expired AS (
                    DELETE FROM token_budget_reservations
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                      AND expires_at <= now()
                    RETURNING reserved_tokens
                )
                SELECT COALESCE(SUM(reserved_tokens), 0) FROM expired
                """
            ),
            {"user_id": user_id, "usage_date": usage_date},
        ).scalar_one()
        return int(expired_total)

    def _token_budget_charge_exists(self, *, db: Session, message_id: UUID) -> bool:
        row = db.execute(
            text(
                """
                SELECT 1
                FROM token_budget_charges
                WHERE message_id = :message_id
                FOR UPDATE
                """
            ),
            {"message_id": message_id},
        ).first()
        return row is not None

    def _insert_token_budget_charge(
        self,
        *,
        db: Session,
        message_id: UUID,
        user_id: UUID,
        usage_date: date,
        charged_tokens: int,
    ) -> None:
        db.execute(
            text(
                """
                INSERT INTO token_budget_charges (
                    message_id,
                    user_id,
                    usage_date,
                    charged_tokens
                )
                VALUES (
                    :message_id,
                    :user_id,
                    :usage_date,
                    :charged_tokens
                )
                """
            ),
            {
                "message_id": message_id,
                "user_id": user_id,
                "usage_date": usage_date,
                "charged_tokens": charged_tokens,
            },
        )

    def _lock_scope(
        self,
        db: Session,
        *,
        scope: str,
        user_id: UUID,
        usage_date: date | None = None,
    ) -> None:
        lock_key = _advisory_lock_key(scope=scope, user_id=user_id, usage_date=usage_date)
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": lock_key})

    def _session(self) -> Session:
        if self._session_factory is None:
            raise RuntimeError("RateLimiter backend is not configured")
        return self._session_factory()

    @staticmethod
    def _db_utc_date(db: Session) -> date:
        return db.execute(text("SELECT (now() AT TIME ZONE 'UTC')::date")).scalar_one()


def _advisory_lock_key(*, scope: str, user_id: UUID, usage_date: date | None = None) -> int:
    date_token = usage_date.isoformat() if usage_date is not None else "-"
    material = f"{scope}:{user_id}:{date_token}".encode()
    digest = hashlib.sha256(material).digest()
    unsigned_value = int.from_bytes(digest[:8], byteorder="big", signed=False)
    return int(unsigned_value - (1 << 63))


_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    """Get the process-global limiter instance."""
    global _rate_limiter
    if _rate_limiter is None:
        _rate_limiter = RateLimiter(session_factory=None)
    return _rate_limiter


def set_rate_limiter(limiter: RateLimiter) -> None:
    """Set the process-global limiter instance."""
    global _rate_limiter
    _rate_limiter = limiter
