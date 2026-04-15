"""Tests for Stripe-backed billing core."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.services import billing as billing_service

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def billing_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_billing")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_billing")
    monkeypatch.setenv("STRIPE_PLUS_PRICE_ID", "price_plus")
    monkeypatch.setenv("STRIPE_AI_PLUS_PRICE_ID", "price_ai_plus")
    monkeypatch.setenv("STRIPE_AI_PRO_PRICE_ID", "price_ai_pro")
    clear_settings_cache()
    yield
    clear_settings_cache()


def _stripe_signature(payload: bytes, secret: str, timestamp: int | None = None) -> str:
    ts = timestamp or int(time.time())
    signed = f"{ts}.".encode() + payload
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


class TestBillingEntitlements:
    def test_ai_plus_entitlements_are_active_and_bounded(self, db_session: Session):
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text(
                """
                INSERT INTO billing_accounts (
                    id,
                    user_id,
                    stripe_customer_id,
                    stripe_subscription_id,
                    stripe_price_id,
                    plan_tier,
                    subscription_status,
                    current_period_start,
                    current_period_end,
                    cancel_at_period_end,
                    created_at,
                    updated_at
                )
                VALUES (
                    :id,
                    :user_id,
                    'cus_123',
                    'sub_123',
                    'price_ai_plus',
                    'ai_plus',
                    'active',
                    :current_period_start,
                    :current_period_end,
                    false,
                    :created_at,
                    :updated_at
                )
                """
            ),
            {
                "id": uuid4(),
                "user_id": user_id,
                "current_period_start": datetime.now(UTC),
                "current_period_end": datetime.now(UTC) + timedelta(days=30),
                "created_at": datetime.now(UTC),
                "updated_at": datetime.now(UTC),
            },
        )

        entitlements = billing_service.get_entitlements(db_session, user_id)
        assert entitlements.plan_tier == "ai_plus"
        assert entitlements.can_share is True
        assert entitlements.can_use_platform_llm is True
        assert entitlements.platform_token_limit_monthly == 1_000_000
        assert entitlements.transcription_minutes_limit_monthly == 300

    def test_expired_subscription_falls_back_to_free(self, db_session: Session):
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text(
                """
                INSERT INTO billing_accounts (
                    id,
                    user_id,
                    stripe_customer_id,
                    stripe_subscription_id,
                    stripe_price_id,
                    plan_tier,
                    subscription_status,
                    current_period_end,
                    cancel_at_period_end,
                    created_at,
                    updated_at
                )
                VALUES (
                    :id,
                    :user_id,
                    'cus_123',
                    'sub_123',
                    'price_ai_pro',
                    'ai_pro',
                    'active',
                    :current_period_end,
                    false,
                    :created_at,
                    :updated_at
                )
                """
            ),
            {
                "id": uuid4(),
                "user_id": user_id,
                "current_period_end": datetime.now(UTC) - timedelta(seconds=1),
                "created_at": datetime.now(UTC),
                "updated_at": datetime.now(UTC),
            },
        )

        entitlements = billing_service.get_entitlements(db_session, user_id)
        assert entitlements.plan_tier == "free"
        assert entitlements.can_share is False
        assert entitlements.can_use_platform_llm is False


class TestStripeWebhookProcessing:
    def test_duplicate_event_is_idempotent(self, db_session: Session):
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        payload = json.dumps(
            {
                "id": "evt_checkout_1",
                "object": "event",
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "id": "cs_test_1",
                        "customer": "cus_test_1",
                        "client_reference_id": str(user_id),
                        "mode": "subscription",
                        "subscription": "sub_test_1",
                        "metadata": {"nexus_user_id": str(user_id)},
                    }
                },
            }
        ).encode("utf-8")
        signature = _stripe_signature(payload, "whsec_billing")

        first = billing_service.process_stripe_webhook(
            db_session,
            raw_body=payload,
            signature=signature,
        )
        second = billing_service.process_stripe_webhook(
            db_session,
            raw_body=payload,
            signature=signature,
        )

        assert first["processed"] is True
        assert second["processed"] is False

        event_count = db_session.execute(
            text("SELECT COUNT(*) FROM stripe_webhook_events WHERE stripe_event_id = :id"),
            {"id": "evt_checkout_1"},
        ).scalar_one()
        assert event_count == 1

        customer_id = db_session.execute(
            text("SELECT stripe_customer_id FROM billing_accounts WHERE user_id = :user_id"),
            {"user_id": user_id},
        ).scalar_one()
        assert customer_id == "cus_test_1"
