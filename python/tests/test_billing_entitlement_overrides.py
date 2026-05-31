"""Integration tests for internal billing entitlement grants."""

from uuid import uuid4

import pytest
from sqlalchemy import text

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
        reason="test unlimited",
        actor_label="test",
    )


def _insert_message(session, *, user_id, message_id):
    conversation_id = uuid4()
    session.execute(
        text("INSERT INTO conversations (id, owner_user_id) VALUES (:id, :user_id)"),
        {"id": conversation_id, "user_id": user_id},
    )
    session.execute(
        text(
            """
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :conversation_id, 1, 'user', 'ok', 'complete')
            """
        ),
        {"id": message_id, "conversation_id": conversation_id},
    )
    return conversation_id


def test_unlimited_token_grant_skips_monthly_cap_but_records_reservation(
    engine,
    direct_db: DirectSessionManager,
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

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.check_token_budget(user_id)
    limiter.reserve_token_budget(user_id, reservation_id, 10_000_000)

    with direct_db.session() as session:
        reserved = session.execute(
            text(
                """
                SELECT reserved_tokens
                FROM token_budget_reservations
                WHERE reservation_id = :reservation_id
                """
            ),
            {"reservation_id": reservation_id},
        ).scalar_one()
    assert reserved == 10_000_000


def test_token_budget_charge_is_idempotent(engine, direct_db: DirectSessionManager):
    user_id = uuid4()
    message_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    conversation_id = None

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        conversation_id = _insert_message(session, user_id=user_id, message_id=message_id)
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("token_budget_charges", "user_id", user_id)
    direct_db.register_cleanup("token_budget_daily_usage", "user_id", user_id)

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.charge_token_budget(user_id, message_id, 100)
    limiter.charge_token_budget(user_id, message_id, 100)

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT usage.spent_tokens, COUNT(charges.message_id)
                FROM token_budget_daily_usage usage
                LEFT JOIN token_budget_charges charges ON charges.user_id = usage.user_id
                WHERE usage.user_id = :user_id
                GROUP BY usage.spent_tokens
                """
            ),
            {"user_id": user_id},
        ).one()
    assert row == (100, 1)


def test_token_budget_commit_is_idempotent(engine, direct_db: DirectSessionManager):
    user_id = uuid4()
    reservation_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    conversation_id = None
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)

    with direct_db.session() as session:
        _grant_unlimited_ai(session, user_id)
        conversation_id = _insert_message(session, user_id=user_id, message_id=reservation_id)
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("token_budget_charges", "user_id", user_id)
    direct_db.register_cleanup("token_budget_daily_usage", "user_id", user_id)
    direct_db.register_cleanup("token_budget_reservations", "user_id", user_id)

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.reserve_token_budget(user_id, reservation_id, 1_000)
    limiter.commit_token_budget(user_id, reservation_id, 400)
    limiter.commit_token_budget(user_id, reservation_id, 400)

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT usage.spent_tokens,
                       usage.reserved_tokens,
                       COUNT(charges.message_id)
                FROM token_budget_daily_usage usage
                LEFT JOIN token_budget_charges charges ON charges.user_id = usage.user_id
                WHERE usage.user_id = :user_id
                GROUP BY usage.spent_tokens, usage.reserved_tokens
                """
            ),
            {"user_id": user_id},
        ).one()
    assert row == (400, 0, 1)


def test_zero_custom_token_grant_blocks_as_quota_exceeded(engine, direct_db: DirectSessionManager):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    direct_db.register_cleanup("token_budget_daily_usage", "user_id", user_id)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="custom",
            platform_token_limit_monthly=0,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="test zero",
            actor_label="test",
        )

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    with pytest.raises(ApiError) as exc_info:
        limiter.check_token_budget(user_id)
    assert exc_info.value.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED
