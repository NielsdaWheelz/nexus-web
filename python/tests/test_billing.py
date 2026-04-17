"""Tests for Stripe-backed billing core."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import billing as billing_service
from tests.helpers import auth_headers

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def billing_env(monkeypatch):
    monkeypatch.setenv("BILLING_ENABLED", "true")
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
    def test_billing_account_reports_billing_enabled(self, db_session: Session):
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

        account = billing_service.get_billing_account(db_session, user_id)
        assert account.billing_enabled is True
        assert account.plan_tier == "free"

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
    def test_disabled_billing_webhook_is_a_no_op(
        self,
        db_session: Session,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        result = billing_service.process_stripe_webhook(
            db_session,
            raw_body=b"{}",
            signature=None,
        )

        assert result == {"processed": False}

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


class TestCheckoutSessions:
    def test_checkout_fails_when_billing_disabled(
        self,
        db_session: Session,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        with pytest.raises(ApiError) as exc_info:
            billing_service.create_checkout_session(
                db_session,
                uuid4(),
                email="billing@example.com",
                plan_tier="plus",
            )

        assert exc_info.value.code == ApiErrorCode.E_BILLING_DISABLED

    def test_active_subscription_checkout_uses_billing_portal(
        self,
        db_session: Session,
        monkeypatch: pytest.MonkeyPatch,
    ):
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
                    'cus_existing',
                    'sub_existing',
                    'price_plus',
                    'plus',
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

        portal_calls: list[dict] = []
        checkout_calls: list[dict] = []

        monkeypatch.setattr(
            billing_service.stripe.billing_portal.Session,
            "create",
            lambda **kwargs: portal_calls.append(kwargs)
            or {"url": "https://billing.example/portal"},
        )
        monkeypatch.setattr(
            billing_service.stripe.checkout.Session,
            "create",
            lambda **kwargs: checkout_calls.append(kwargs)
            or {"url": "https://billing.example/checkout"},
        )

        url = billing_service.create_checkout_session(
            db_session,
            user_id,
            email="billing@example.com",
            plan_tier="ai_plus",
        )

        assert url == "https://billing.example/portal"
        assert checkout_calls == []
        assert portal_calls == [
            {
                "customer": "cus_existing",
                "return_url": "http://localhost:3000/settings/billing",
            }
        ]

    def test_customer_portal_fails_when_billing_disabled(
        self,
        db_session: Session,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        with pytest.raises(ApiError) as exc_info:
            billing_service.create_customer_portal_session(db_session, uuid4())

        assert exc_info.value.code == ApiErrorCode.E_BILLING_DISABLED


class TestBillingRoutes:
    def test_account_route_includes_billing_enabled(
        self,
        authenticated_client: TestClient,
    ):
        response = authenticated_client.get("/billing/account", headers=auth_headers(uuid4()))

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["billing_enabled"] is True
        assert data["plan_tier"] == "free"

    def test_disabled_checkout_route_returns_503(
        self,
        authenticated_client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        response = authenticated_client.post(
            "/billing/checkout",
            json={"plan_tier": "plus"},
            headers=auth_headers(uuid4()),
        )

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "E_BILLING_DISABLED"

    def test_disabled_portal_route_returns_503(
        self,
        authenticated_client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        response = authenticated_client.post(
            "/billing/portal",
            headers=auth_headers(uuid4()),
        )

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "E_BILLING_DISABLED"

    def test_disabled_webhook_route_returns_processed_false(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv("BILLING_ENABLED", "false")
        clear_settings_cache()

        response = client.post(
            "/billing/stripe/webhook",
            content=b"{}",
            headers={"content-type": "application/json"},
        )

        assert response.status_code == 200
        assert response.json()["data"] == {"processed": False}
