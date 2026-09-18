"""Rate limiting service backed by Postgres runtime tables."""

from __future__ import annotations

import hashlib
from collections.abc import Generator
from contextlib import contextmanager
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

DEFAULT_RPM_LIMIT = 20

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
    ) -> None:
        self._session_factory = session_factory
        self._rpm_limit = int(rpm_limit)

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
            logger.warning("rate_limit.blocked", limit_type="rpm")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITED,
                f"Rate limit exceeded: {self._rpm_limit} requests per minute",
            )

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

    def _lock_scope(
        self,
        db: Session,
        *,
        scope: str,
        user_id: UUID,
    ) -> None:
        lock_key = _advisory_lock_key(scope=scope, user_id=user_id)
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": lock_key})

    def _session(self) -> Session:
        if self._session_factory is None:
            raise RuntimeError("RateLimiter backend is not configured")
        return self._session_factory()


def _advisory_lock_key(*, scope: str, user_id: UUID) -> int:
    # Preserve the established no-date key material for request-rate identity.
    material = f"{scope}:{user_id}:-".encode()
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
