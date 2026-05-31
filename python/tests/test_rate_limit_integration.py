"""Integration tests for Postgres-backed rate limiter state."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text

import nexus.services.rate_limit as rate_limit_module
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.rate_limit import RateLimiter
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _grant_unlimited_ai(session, user_id):
    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    grant_entitlement_override(
        session,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="rate limiter DB clock test",
        actor_label="test",
    )


def test_inflight_slot_initializes_and_reuses_counter(engine, direct_db: DirectSessionManager):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("rate_limit_inflight", "user_id", user_id)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.commit()

    limiter = RateLimiter(session_factory=create_session_factory(engine), concurrent_limit=3)
    limiter.acquire_inflight_slot(user_id)
    limiter.acquire_inflight_slot(user_id)
    limiter.release_inflight_slot(user_id)

    with direct_db.session() as session:
        count = session.execute(
            text(
                """
                SELECT inflight_count
                FROM rate_limit_inflight
                WHERE user_id = :user_id
                """
            ),
            {"user_id": user_id},
        ).scalar_one()
    assert count == 1


def test_inflight_slot_timestamp_uses_database_clock(
    engine,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("rate_limit_inflight", "user_id", user_id)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.commit()

    class FutureDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2099, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(rate_limit_module, "datetime", FutureDateTime, raising=False)

    limiter = RateLimiter(session_factory=create_session_factory(engine), concurrent_limit=3)
    limiter.acquire_inflight_slot(user_id)

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT updated_at, now()
                FROM rate_limit_inflight
                WHERE user_id = :user_id
                """
            ),
            {"user_id": user_id},
        ).one()

    assert abs((row[0] - row[1]).total_seconds()) < 10


def test_rpm_window_uses_database_clock(
    engine,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("rate_limit_request_log", "user_id", user_id)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text("INSERT INTO rate_limit_request_log (user_id) VALUES (:user_id)"),
            {"user_id": user_id},
        )
        session.commit()

    class FutureDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2099, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(rate_limit_module, "datetime", FutureDateTime, raising=False)

    limiter = RateLimiter(session_factory=create_session_factory(engine), rpm_limit=1)
    with pytest.raises(ApiError) as exc_info:
        limiter.check_rpm_limit(user_id)

    assert exc_info.value.code == ApiErrorCode.E_RATE_LIMITED


def test_token_budget_reservation_uses_database_clock(
    engine,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = uuid4()
    reservation_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    direct_db.register_cleanup("token_budget_daily_usage", "user_id", user_id)
    direct_db.register_cleanup("token_budget_reservations", "user_id", user_id)

    with direct_db.session() as session:
        _grant_unlimited_ai(session, user_id)
        session.commit()

    class FutureDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2099, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(rate_limit_module, "datetime", FutureDateTime, raising=False)

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.reserve_token_budget(user_id, reservation_id, 100, ttl=60)

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT
                    reservation.usage_date,
                    EXTRACT(EPOCH FROM reservation.expires_at - now()),
                    (now() AT TIME ZONE 'UTC')::date
                FROM token_budget_reservations reservation
                WHERE reservation.reservation_id = :reservation_id
                """
            ),
            {"reservation_id": reservation_id},
        ).one()

    assert row[0] == row[2]
    assert 0 < float(row[1]) <= 60


def test_expired_token_budget_reservation_uses_database_clock(
    engine,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = uuid4()
    reservation_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    direct_db.register_cleanup("token_budget_daily_usage", "user_id", user_id)
    direct_db.register_cleanup("token_budget_reservations", "user_id", user_id)

    with direct_db.session() as session:
        _grant_unlimited_ai(session, user_id)
        session.execute(
            text(
                """
                INSERT INTO token_budget_daily_usage (
                    user_id,
                    usage_date,
                    spent_tokens,
                    reserved_tokens
                )
                VALUES (:user_id, (now() AT TIME ZONE 'UTC')::date, 0, 100)
                """
            ),
            {"user_id": user_id},
        )
        session.execute(
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
                    (now() AT TIME ZONE 'UTC')::date,
                    100,
                    now() - interval '1 second'
                )
                """
            ),
            {"reservation_id": reservation_id, "user_id": user_id},
        )
        session.commit()

    class PastDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(1900, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(rate_limit_module, "datetime", PastDateTime, raising=False)

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.check_token_budget(user_id)

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT usage.reserved_tokens, COUNT(reservation.reservation_id)
                FROM token_budget_daily_usage usage
                LEFT JOIN token_budget_reservations reservation
                  ON reservation.user_id = usage.user_id
                WHERE usage.user_id = :user_id
                GROUP BY usage.reserved_tokens
                """
            ),
            {"user_id": user_id},
        ).one()

    assert row == (0, 0)
