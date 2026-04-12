"""Rate limiting service backed by Postgres runtime tables."""

from __future__ import annotations

import hashlib
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

DEFAULT_RPM_LIMIT = 20
DEFAULT_CONCURRENT_LIMIT = 3
DEFAULT_TOKEN_BUDGET = 100_000

RPM_WINDOW_SECONDS = 60
REQUEST_LOG_RETENTION_SECONDS = 3600


class RateLimiter:
    """Rate limiter backed by durable Postgres state."""

    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session] | None = None,
        rpm_limit: int = DEFAULT_RPM_LIMIT,
        concurrent_limit: int = DEFAULT_CONCURRENT_LIMIT,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
    ) -> None:
        self._session_factory = session_factory
        self._rpm_limit = int(rpm_limit)
        self._concurrent_limit = int(concurrent_limit)
        self._token_budget = int(token_budget)

    @property
    def backend_available(self) -> bool:
        return self._session_factory is not None

    def check_rpm_limit(self, user_id: UUID) -> None:
        """Check-and-record one request against per-minute quota."""
        if not self.backend_available:
            logger.warning("rate_limit_backend_unavailable", check="rpm")
            return

        now = datetime.now(UTC)
        window_start = now - timedelta(seconds=RPM_WINDOW_SECONDS)
        retention_start = now - timedelta(seconds=REQUEST_LOG_RETENTION_SECONDS)

        try:
            with self._session() as db:
                self._lock_scope(db, scope="rpm", user_id=user_id)
                db.execute(
                    text(
                        """
                        DELETE FROM rate_limit_request_log
                        WHERE requested_at < :retention_start
                        """
                    ),
                    {"retention_start": retention_start},
                )
                db.execute(
                    text(
                        """
                        INSERT INTO rate_limit_request_log (user_id, requested_at)
                        VALUES (:user_id, :now)
                        """
                    ),
                    {"user_id": user_id, "now": now},
                )
                count = int(
                    db.execute(
                        text(
                            """
                            SELECT COUNT(*)
                            FROM rate_limit_request_log
                            WHERE user_id = :user_id
                              AND requested_at >= :window_start
                            """
                        ),
                        {"user_id": user_id, "window_start": window_start},
                    ).scalar_one()
                )
                db.commit()
        except Exception as exc:
            logger.warning("rate_limit_check_failed", check="rpm", error=str(exc))
            return

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
            return

        try:
            with self._session() as db:
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
        except Exception as exc:
            logger.warning("rate_limit_check_failed", check="concurrent", error=str(exc))
            return

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
            return

        now = datetime.now(UTC)
        try:
            with self._session() as db:
                self._lock_scope(db, scope="inflight", user_id=user_id)
                db.execute(
                    text(
                        """
                        INSERT INTO rate_limit_inflight (user_id, inflight_count, updated_at)
                        VALUES (:user_id, 0, :now)
                        ON CONFLICT (user_id) DO NOTHING
                        """
                    ),
                    {"user_id": user_id, "now": now},
                )
                current = int(
                    db.execute(
                        text(
                            """
                            SELECT inflight_count
                            FROM rate_limit_inflight
                            WHERE user_id = :user_id
                            FOR UPDATE
                            """
                        ),
                        {"user_id": user_id},
                    ).scalar_one()
                )
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
                        SET inflight_count = :next_count, updated_at = :now
                        WHERE user_id = :user_id
                        """
                    ),
                    {
                        "user_id": user_id,
                        "next_count": current + 1,
                        "now": now,
                    },
                )
                db.commit()
        except ApiError:
            raise
        except Exception as exc:
            logger.warning("inflight_acquire_failed", user_id=str(user_id), error=str(exc))

    def release_inflight_slot(self, user_id: UUID) -> None:
        """Decrement one in-flight slot (clamped at zero)."""
        if not self.backend_available:
            return

        now = datetime.now(UTC)
        with self._db_swallow("inflight_release_failed", user_id=str(user_id)) as db:
            self._lock_scope(db, scope="inflight", user_id=user_id)
            db.execute(
                text(
                    """
                    UPDATE rate_limit_inflight
                    SET inflight_count = GREATEST(inflight_count - 1, 0),
                        updated_at = :now
                    WHERE user_id = :user_id
                    """
                ),
                {"user_id": user_id, "now": now},
            )
            db.commit()

    def check_token_budget(self, user_id: UUID) -> None:
        """Check daily token budget against spent+reserved totals."""
        if not self.backend_available:
            logger.warning("token_budget_backend_unavailable")
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                "Rate limiting service unavailable",
            )

        usage_date = self._today_utc()
        with self._db_strict(
            "token_budget_check_failed",
            raise_code=ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
            raise_msg="Rate limiting service unavailable",
        ) as db:
            spent, reserved = self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
                now=datetime.now(UTC),
            )
            db.commit()

        if spent + reserved >= self._token_budget:
            logger.warning("token_budget.exceeded", **safe_kv(key_mode="platform"))
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                f"Daily token budget exceeded: {self._token_budget} tokens",
            )

    def charge_token_budget(self, user_id: UUID, message_id: UUID, tokens: int) -> None:
        """Charge non-stream requests idempotently."""
        if not self.backend_available:
            logger.warning("token_budget_charge_backend_unavailable")
            return
        if tokens <= 0:
            return

        usage_date = self._today_utc()
        now = datetime.now(UTC)
        with self._db_swallow(
            "token_budget_charge_failed",
            user_id=str(user_id),
            message_id=str(message_id),
            tokens=tokens,
        ) as db:
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
                now=now,
            )
            inserted = db.execute(
                text(
                    """
                    INSERT INTO token_budget_charges (
                        message_id,
                        user_id,
                        usage_date,
                        charged_tokens,
                        created_at
                    )
                    VALUES (:message_id, :user_id, :usage_date, :tokens, :now)
                    ON CONFLICT (message_id) DO NOTHING
                    """
                ),
                {
                    "message_id": message_id,
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "tokens": int(tokens),
                    "now": now,
                },
            )
            if inserted.rowcount > 0:
                db.execute(
                    text(
                        """
                        UPDATE token_budget_daily_usage
                        SET spent_tokens = spent_tokens + :tokens,
                            updated_at = :now
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {
                        "tokens": int(tokens),
                        "now": now,
                        "user_id": user_id,
                        "usage_date": usage_date,
                    },
                )
            db.commit()

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
                "Rate limiting service unavailable",
            )
        if est_tokens <= 0:
            return

        now = datetime.now(UTC)
        usage_date = self._today_utc()
        expires_at = now + timedelta(seconds=max(int(ttl), 1))

        with self._db_strict(
            "token_budget_reserve_failed",
            raise_code=ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
            raise_msg="Rate limiting service unavailable",
        ) as db:
            spent, reserved = self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
                now=now,
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

            next_total = spent + reserved + int(est_tokens)
            if next_total > self._token_budget:
                db.rollback()
                raise ApiError(
                    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                    (
                        "Daily token budget would be exceeded "
                        f"(spent={spent}, reserved={reserved}, "
                        f"requested={int(est_tokens)}, budget={self._token_budget})"
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
                        expires_at,
                        created_at
                    )
                    VALUES (
                        :reservation_id,
                        :user_id,
                        :usage_date,
                        :reserved_tokens,
                        :expires_at,
                        :now
                    )
                    """
                ),
                {
                    "reservation_id": reservation_id,
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "reserved_tokens": int(est_tokens),
                    "expires_at": expires_at,
                    "now": now,
                },
            )
            db.execute(
                text(
                    """
                    UPDATE token_budget_daily_usage
                    SET reserved_tokens = reserved_tokens + :reserved_tokens,
                        updated_at = :now
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "reserved_tokens": int(est_tokens),
                    "now": now,
                    "user_id": user_id,
                    "usage_date": usage_date,
                },
            )
            db.commit()

    def commit_token_budget(self, user_id: UUID, reservation_id: UUID, actual_tokens: int) -> None:
        """Commit a reservation and charge actual usage once."""
        if not self.backend_available:
            return

        now = datetime.now(UTC)
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
            usage_date = reservation["usage_date"] if reservation is not None else self._today_utc()
            self._load_budget_totals_for_update(
                db=db,
                user_id=user_id,
                usage_date=usage_date,
                now=now,
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
                            updated_at = :now
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {
                        "reserved_tokens": int(reservation["reserved_tokens"]),
                        "now": now,
                        "user_id": user_id,
                        "usage_date": usage_date,
                    },
                )

            inserted = db.execute(
                text(
                    """
                    INSERT INTO token_budget_charges (
                        message_id,
                        user_id,
                        usage_date,
                        charged_tokens,
                        created_at
                    )
                    VALUES (
                        :message_id,
                        :user_id,
                        :usage_date,
                        :charged_tokens,
                        :now
                    )
                    ON CONFLICT (message_id) DO NOTHING
                    """
                ),
                {
                    "message_id": reservation_id,
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "charged_tokens": normalized_tokens,
                    "now": now,
                },
            )
            if inserted.rowcount > 0 and normalized_tokens > 0:
                db.execute(
                    text(
                        """
                        UPDATE token_budget_daily_usage
                        SET spent_tokens = spent_tokens + :charged_tokens,
                            updated_at = :now
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {
                        "charged_tokens": normalized_tokens,
                        "now": now,
                        "user_id": user_id,
                        "usage_date": usage_date,
                    },
                )
            db.commit()

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        """Release an outstanding reservation without spending."""
        if not self.backend_available:
            return

        now = datetime.now(UTC)
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
                now=now,
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
                        updated_at = :now
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "reserved_tokens": int(reservation["reserved_tokens"]),
                    "now": now,
                    "user_id": user_id,
                    "usage_date": usage_date,
                },
            )
            db.commit()

    def get_budget_remaining(self, user_id: UUID) -> int | None:
        """Return remaining daily spend budget, or None when backend is unavailable."""
        if not self.backend_available:
            return None

        usage_date = self._today_utc()
        try:
            with self._session() as db:
                spent = db.execute(
                    text(
                        """
                        SELECT spent_tokens
                        FROM token_budget_daily_usage
                        WHERE user_id = :user_id
                          AND usage_date = :usage_date
                        """
                    ),
                    {"user_id": user_id, "usage_date": usage_date},
                ).scalar_one_or_none()
                db.commit()
        except Exception:
            return None

        consumed = int(spent) if spent is not None else 0
        return max(0, self._token_budget - consumed)

    @contextmanager
    def _db_swallow(self, warn_msg: str, **warn_kw: object) -> Generator[Session, None, None]:
        """Open a session; on non-ApiError exceptions log a warning and swallow."""
        try:
            with self._session() as db:
                yield db
        except Exception as exc:
            logger.warning(warn_msg, error=str(exc), **warn_kw)

    @contextmanager
    def _db_strict(
        self, warn_msg: str, raise_code: str, raise_msg: str, **warn_kw: object
    ) -> Generator[Session, None, None]:
        """Open a session; re-raise ApiError, wrap other exceptions into a new ApiError."""
        try:
            with self._session() as db:
                yield db
        except ApiError:
            raise
        except Exception as exc:
            logger.warning(warn_msg, error=str(exc), **warn_kw)
            raise ApiError(raise_code, raise_msg) from exc

    def _load_budget_totals_for_update(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
        now: datetime,
    ) -> tuple[int, int]:
        self._lock_scope(db, scope="budget", user_id=user_id, usage_date=usage_date)
        self._ensure_daily_usage_row(db=db, user_id=user_id, usage_date=usage_date, now=now)
        row = self._select_daily_usage_for_update(db=db, user_id=user_id, usage_date=usage_date)
        expired_total = self._expire_reservations(
            db=db,
            user_id=user_id,
            usage_date=usage_date,
            now=now,
        )
        if expired_total > 0:
            db.execute(
                text(
                    """
                    UPDATE token_budget_daily_usage
                    SET reserved_tokens = GREATEST(reserved_tokens - :expired_total, 0),
                        updated_at = :now
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                    """
                ),
                {
                    "expired_total": expired_total,
                    "now": now,
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

    def _ensure_daily_usage_row(
        self,
        *,
        db: Session,
        user_id: UUID,
        usage_date: date,
        now: datetime,
    ) -> None:
        db.execute(
            text(
                """
                INSERT INTO token_budget_daily_usage (
                    user_id,
                    usage_date,
                    spent_tokens,
                    reserved_tokens,
                    updated_at
                )
                VALUES (:user_id, :usage_date, 0, 0, :now)
                ON CONFLICT (user_id, usage_date) DO NOTHING
                """
            ),
            {"user_id": user_id, "usage_date": usage_date, "now": now},
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
        now: datetime,
    ) -> int:
        expired_total = db.execute(
            text(
                """
                WITH expired AS (
                    DELETE FROM token_budget_reservations
                    WHERE user_id = :user_id
                      AND usage_date = :usage_date
                      AND expires_at <= :now
                    RETURNING reserved_tokens
                )
                SELECT COALESCE(SUM(reserved_tokens), 0) FROM expired
                """
            ),
            {"user_id": user_id, "usage_date": usage_date, "now": now},
        ).scalar_one()
        return int(expired_total)

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
    def _today_utc() -> date:
        return datetime.now(UTC).date()


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
