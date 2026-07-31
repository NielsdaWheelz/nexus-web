"""Priority proof: token-budget reservation and settlement charge once."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import User
from nexus.db.session import create_session_factory
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.rate_limit import RateLimiter


def test_token_budget_reservation_and_settlement_are_exactly_once(engine: Engine) -> None:
    user_id = uuid4()
    reservation_id = uuid4()
    with Session(engine) as db:
        db.add(User(id=user_id, email=f"cost-proof-{user_id}@example.invalid"))
        db.flush()
        grant_entitlement_override(
            db,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="costly-effect exactly-once proof",
            actor_label="nexus-test",
        )
        db.commit()

    limiter = RateLimiter(session_factory=create_session_factory(engine))
    limiter.reserve_token_budget(user_id, reservation_id, 120)
    limiter.reserve_token_budget(user_id, reservation_id, 120)

    with Session(engine) as oracle:
        reserved = oracle.execute(
            text(
                """
                SELECT usage.reserved_tokens, COUNT(reservation.reservation_id)
                FROM token_budget_daily_usage usage
                LEFT JOIN token_budget_reservations reservation
                  ON reservation.user_id = usage.user_id
                 AND reservation.usage_date = usage.usage_date
                WHERE usage.user_id = :user_id
                GROUP BY usage.reserved_tokens
                """
            ),
            {"user_id": user_id},
        ).one()
    assert reserved == (120, 1), (
        f"replayed reservation must preserve one 120-token hold: {reserved!r}"
    )

    limiter.commit_token_budget(user_id, reservation_id, 73)
    limiter.commit_token_budget(user_id, reservation_id, 999)

    with Session(engine) as oracle:
        settled = oracle.execute(
            text(
                """
                SELECT
                    usage.spent_tokens,
                    usage.reserved_tokens,
                    COUNT(charge.reservation_id),
                    COALESCE(SUM(charge.charged_tokens), 0),
                    COUNT(reservation.reservation_id)
                FROM token_budget_daily_usage usage
                LEFT JOIN token_budget_charges charge
                  ON charge.user_id = usage.user_id
                 AND charge.usage_date = usage.usage_date
                LEFT JOIN token_budget_reservations reservation
                  ON reservation.user_id = usage.user_id
                 AND reservation.usage_date = usage.usage_date
                WHERE usage.user_id = :user_id
                GROUP BY usage.spent_tokens, usage.reserved_tokens
                """
            ),
            {"user_id": user_id},
        ).one()
    assert settled == (73, 0, 1, 73, 0), (
        f"replayed settlement changed the first durable charge or leaked a reservation: {settled!r}"
    )
