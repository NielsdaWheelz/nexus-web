"""Rate limiting service using Redis.

Implements per-user rate limits and token budgets for LLM calls.

Per PR-05 spec:
- Requests per minute per user: 20/min (E_RATE_LIMITED)
- Concurrent in-flight sends per user: 3 (E_RATE_LIMITED)
- Platform key daily token budget: 100k tokens/day (E_TOKEN_BUDGET_EXCEEDED)

Redis keys:
- rate:rpm:{user_id} - Sliding window counter for requests per minute
- rate:inflight:{user_id} - In-flight request counter (decrement on complete)
- budget:{user_id}:{date} - Daily token usage for platform keys
- budget_charged:{message_id} - Prevents double-charging on retries

Fail modes:
- Redis unavailable: Fail closed for token budget, fail open for RPM/concurrency
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

# Rate limit constants
DEFAULT_RPM_LIMIT = 20  # Requests per minute
DEFAULT_CONCURRENT_LIMIT = 3  # In-flight sends per user
DEFAULT_TOKEN_BUDGET = 100_000  # Daily platform token budget

# TTLs
RPM_WINDOW_SECONDS = 60
INFLIGHT_TTL_SECONDS = 300  # 5 minutes max for a request
BUDGET_TTL_SECONDS = 86400  # 24 hours


class RateLimiter:
    """Rate limiter using Redis.

    Thread-safe for use in FastAPI endpoints.
    """

    def __init__(
        self,
        redis_client=None,
        rpm_limit: int = DEFAULT_RPM_LIMIT,
        concurrent_limit: int = DEFAULT_CONCURRENT_LIMIT,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
    ):
        """Initialize rate limiter.

        Args:
            redis_client: Redis client instance (sync). If None, limits are not enforced.
            rpm_limit: Maximum requests per minute per user.
            concurrent_limit: Maximum concurrent in-flight requests per user.
            token_budget: Daily platform token budget per user.
        """
        self._redis = redis_client
        self._rpm_limit = rpm_limit
        self._concurrent_limit = concurrent_limit
        self._token_budget = token_budget

    @property
    def redis_available(self) -> bool:
        """Check if Redis is available."""
        if self._redis is None:
            return False
        try:
            self._redis.ping()
            return True
        except Exception:
            return False

    def check_rpm_limit(self, user_id: UUID) -> None:
        """Check and increment request-per-minute counter.

        Fails open if Redis unavailable.

        Raises:
            ApiError(E_RATE_LIMITED): If RPM limit exceeded.
        """
        if not self.redis_available:
            logger.warning("rate_limit_redis_unavailable", check="rpm")
            return  # Fail open

        try:
            key = f"rate:rpm:{user_id}"
            now = datetime.now(UTC)
            window_start = now - timedelta(seconds=RPM_WINDOW_SECONDS)
            window_start_ts = window_start.timestamp()
            now_ts = now.timestamp()

            # Use sorted set for sliding window
            pipe = self._redis.pipeline()

            # Remove old entries
            pipe.zremrangebyscore(key, 0, window_start_ts)
            # Add current request
            pipe.zadd(key, {f"{now_ts}:{id(now)}": now_ts})
            # Count entries in window
            pipe.zcount(key, window_start_ts, now_ts)
            # Set TTL
            pipe.expire(key, RPM_WINDOW_SECONDS * 2)

            results = pipe.execute()
            count = results[2]

            if count > self._rpm_limit:
                # PR-09: Emit rate_limit.blocked event
                logger.warning(
                    "rate_limit.blocked",
                    **safe_kv(
                        limit_type="rpm",
                    ),
                )
                raise ApiError(
                    ApiErrorCode.E_RATE_LIMITED,
                    f"Rate limit exceeded: {self._rpm_limit} requests per minute",
                )

        except ApiError:
            raise
        except Exception as e:
            logger.warning("rate_limit_check_failed", check="rpm", error=str(e))
            # Fail open

    def check_concurrent_limit(self, user_id: UUID) -> None:
        """Check concurrent in-flight requests.

        Fails open if Redis unavailable.

        Raises:
            ApiError(E_RATE_LIMITED): If concurrent limit exceeded.
        """
        if not self.redis_available:
            logger.warning("rate_limit_redis_unavailable", check="concurrent")
            return  # Fail open

        try:
            key = f"rate:inflight:{user_id}"
            count = self._redis.get(key)
            count = int(count) if count else 0

            if count >= self._concurrent_limit:
                # PR-09: Emit rate_limit.blocked event
                logger.warning(
                    "rate_limit.blocked",
                    **safe_kv(
                        limit_type="concurrent",
                    ),
                )
                raise ApiError(
                    ApiErrorCode.E_RATE_LIMITED,
                    f"Too many concurrent requests: {self._concurrent_limit} maximum",
                )

        except ApiError:
            raise
        except Exception as e:
            logger.warning("rate_limit_check_failed", check="concurrent", error=str(e))
            # Fail open

    def increment_inflight(self, user_id: UUID) -> None:
        """Increment in-flight counter for a user."""
        if not self.redis_available:
            return

        try:
            key = f"rate:inflight:{user_id}"
            self._redis.incr(key)
            self._redis.expire(key, INFLIGHT_TTL_SECONDS)
        except Exception as e:
            logger.warning("inflight_increment_failed", user_id=str(user_id), error=str(e))

    def decrement_inflight(self, user_id: UUID) -> None:
        """Decrement in-flight counter for a user."""
        if not self.redis_available:
            return

        try:
            key = f"rate:inflight:{user_id}"
            result = self._redis.decr(key)
            # Don't let it go negative
            if result is not None and int(result) < 0:
                self._redis.set(key, 0, ex=INFLIGHT_TTL_SECONDS)
        except Exception as e:
            logger.warning("inflight_decrement_failed", user_id=str(user_id), error=str(e))

    def check_token_budget(self, user_id: UUID) -> None:
        """Check if user has remaining token budget for platform keys.

        Fails closed if Redis unavailable.

        Raises:
            ApiError(E_TOKEN_BUDGET_EXCEEDED): If budget exceeded.
        """
        if not self.redis_available:
            logger.warning("token_budget_redis_unavailable")
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                "Rate limiting service unavailable",
            )

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            key = f"budget:{user_id}:{date}"

            current = self._redis.get(key)
            current = int(current) if current else 0

            if current >= self._token_budget:
                # PR-09: Emit token_budget.exceeded event
                logger.warning(
                    "token_budget.exceeded",
                    **safe_kv(
                        key_mode="platform",
                    ),
                )
                raise ApiError(
                    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                    f"Daily token budget exceeded: {self._token_budget} tokens",
                )

        except ApiError:
            raise
        except Exception as e:
            logger.warning("token_budget_check_failed", error=str(e))
            # Fail closed for budget
            raise ApiError(
                ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                "Rate limiting service unavailable",
            ) from e

    def charge_token_budget(
        self,
        user_id: UUID,
        message_id: UUID,
        tokens: int,
    ) -> None:
        """Charge tokens to user's daily budget (idempotent).

        Uses a marker key to prevent double-charging on retries.

        Args:
            user_id: User to charge.
            message_id: Message ID (for idempotency).
            tokens: Number of tokens to charge.
        """
        if not self.redis_available:
            logger.warning("token_budget_charge_redis_unavailable")
            return

        if tokens <= 0:
            return

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            budget_key = f"budget:{user_id}:{date}"
            charge_key = f"budget_charged:{message_id}"

            # Check if already charged (idempotent)
            if self._redis.exists(charge_key):
                logger.debug(
                    "token_budget_already_charged",
                    user_id=str(user_id),
                    message_id=str(message_id),
                )
                return

            # Charge and mark
            pipe = self._redis.pipeline()
            pipe.incrby(budget_key, tokens)
            pipe.expire(budget_key, BUDGET_TTL_SECONDS)
            pipe.set(charge_key, "1", ex=BUDGET_TTL_SECONDS)
            pipe.execute()

            logger.debug(
                "token_budget_charged",
                user_id=str(user_id),
                message_id=str(message_id),
                tokens=tokens,
            )

        except Exception as e:
            logger.warning(
                "token_budget_charge_failed",
                user_id=str(user_id),
                message_id=str(message_id),
                tokens=tokens,
                error=str(e),
            )

    # =========================================================================
    # PR-08: Token budget reservation for streaming (platform key)
    # =========================================================================

    def reserve_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
        est_tokens: int,
        ttl: int = 300,
    ) -> None:
        """Reserve tokens from the daily budget before a streaming LLM call.

        Check: spent + reserved >= budget → reject.
        Reservation keyed by assistant_message_id.

        Args:
            user_id: User whose budget to reserve against.
            reservation_id: The assistant_message_id (unique per stream).
            est_tokens: Estimated tokens to reserve.
            ttl: Reservation TTL in seconds (auto-released if not committed).

        Raises:
            ApiError(E_TOKEN_BUDGET_EXCEEDED): If budget would be exceeded.
            ApiError(E_RATE_LIMITER_UNAVAILABLE): If Redis is unavailable.
        """
        if not self.redis_available:
            logger.warning("token_budget_reserve_redis_unavailable")
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                "Rate limiting service unavailable",
            )

        if est_tokens <= 0:
            return

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            spent_key = f"budget:{user_id}:{date}"
            reserved_key = f"reserved:{user_id}:{date}"
            res_detail_key = f"reservation:{reservation_id}"

            pipe = self._redis.pipeline()
            pipe.get(spent_key)
            pipe.get(reserved_key)
            results = pipe.execute()

            spent = int(results[0]) if results[0] else 0
            reserved = int(results[1]) if results[1] else 0

            if spent + reserved + est_tokens > self._token_budget:
                raise ApiError(
                    ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
                    f"Daily token budget would be exceeded (spent={spent}, reserved={reserved}, "
                    f"requested={est_tokens}, budget={self._token_budget})",
                )

            # Reserve
            pipe2 = self._redis.pipeline()
            pipe2.incrby(reserved_key, est_tokens)
            pipe2.expire(reserved_key, BUDGET_TTL_SECONDS)
            pipe2.set(res_detail_key, str(est_tokens), ex=ttl)
            pipe2.execute()

            logger.debug(
                "token_budget_reserved",
                user_id=str(user_id),
                reservation_id=str(reservation_id),
                est_tokens=est_tokens,
            )

        except ApiError:
            raise
        except Exception as e:
            logger.warning("token_budget_reserve_failed", error=str(e))
            raise ApiError(
                ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
                "Rate limiting service unavailable",
            ) from e

    def commit_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
        actual_tokens: int,
    ) -> None:
        """Commit a reservation: decrement reserved, increment spent.

        Called at stream finalize with actual token count.
        """
        if not self.redis_available:
            return

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            spent_key = f"budget:{user_id}:{date}"
            reserved_key = f"reserved:{user_id}:{date}"
            res_detail_key = f"reservation:{reservation_id}"

            # Get the original reservation amount
            est_raw = self._redis.get(res_detail_key)
            est_tokens = int(est_raw) if est_raw else 0

            pipe = self._redis.pipeline()
            # Decrement reserved by the original estimate
            if est_tokens > 0:
                pipe.decrby(reserved_key, est_tokens)
            # Increment spent by actual
            if actual_tokens > 0:
                pipe.incrby(spent_key, actual_tokens)
                pipe.expire(spent_key, BUDGET_TTL_SECONDS)
            # Clean up reservation detail
            pipe.delete(res_detail_key)
            pipe.execute()

            # Ensure reserved doesn't go negative
            current_reserved = self._redis.get(reserved_key)
            if current_reserved and int(current_reserved) < 0:
                self._redis.set(reserved_key, 0, ex=BUDGET_TTL_SECONDS)

            logger.debug(
                "token_budget_committed",
                user_id=str(user_id),
                reservation_id=str(reservation_id),
                est_tokens=est_tokens,
                actual_tokens=actual_tokens,
            )

        except Exception as e:
            logger.warning(
                "token_budget_commit_failed",
                user_id=str(user_id),
                reservation_id=str(reservation_id),
                error=str(e),
            )

    def release_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
    ) -> None:
        """Release a reservation without spending (early failure before provider call)."""
        if not self.redis_available:
            return

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            reserved_key = f"reserved:{user_id}:{date}"
            res_detail_key = f"reservation:{reservation_id}"

            est_raw = self._redis.get(res_detail_key)
            est_tokens = int(est_raw) if est_raw else 0

            if est_tokens > 0:
                pipe = self._redis.pipeline()
                pipe.decrby(reserved_key, est_tokens)
                pipe.delete(res_detail_key)
                pipe.execute()

                # Ensure reserved doesn't go negative
                current_reserved = self._redis.get(reserved_key)
                if current_reserved and int(current_reserved) < 0:
                    self._redis.set(reserved_key, 0, ex=BUDGET_TTL_SECONDS)
            else:
                self._redis.delete(res_detail_key)

            logger.debug(
                "token_budget_released",
                user_id=str(user_id),
                reservation_id=str(reservation_id),
                est_tokens=est_tokens,
            )

        except Exception as e:
            logger.warning(
                "token_budget_release_failed",
                user_id=str(user_id),
                reservation_id=str(reservation_id),
                error=str(e),
            )

    def get_budget_remaining(self, user_id: UUID) -> int | None:
        """Get remaining token budget for today.

        Returns:
            Remaining tokens, or None if Redis unavailable.
        """
        if not self.redis_available:
            return None

        try:
            date = datetime.now(UTC).strftime("%Y-%m-%d")
            key = f"budget:{user_id}:{date}"

            current = self._redis.get(key)
            current = int(current) if current else 0

            return max(0, self._token_budget - current)

        except Exception:
            return None


# Global rate limiter instance (initialized by app startup)
_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    """Get the global rate limiter instance.

    Returns a no-op limiter if not initialized (for testing without Redis).
    """
    global _rate_limiter
    if _rate_limiter is None:
        # Return a limiter with no Redis (limits not enforced)
        _rate_limiter = RateLimiter(redis_client=None)
    return _rate_limiter


def set_rate_limiter(limiter: RateLimiter) -> None:
    """Set the global rate limiter instance.

    Called by app startup to configure Redis.
    """
    global _rate_limiter
    _rate_limiter = limiter
