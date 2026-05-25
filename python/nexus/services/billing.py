"""Stripe billing state and account reads."""

from datetime import UTC, date, datetime
from uuid import UUID

import stripe
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import BillingAccount, StripeWebhookEvent
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.billing import BillingAccountOut, BillingUsageBucketOut
from nexus.services.billing_entitlements import (
    ACTIVE_SUBSCRIPTION_STATUSES,
    get_effective_entitlements,
)


def get_billing_account(db: Session, user_id: UUID) -> BillingAccountOut:
    settings = get_settings()
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    entitlements = get_effective_entitlements(db, user_id)
    period_start = entitlements.usage_period_start
    period_end = entitlements.usage_period_end
    token_usage = get_platform_token_usage(db, user_id, period_start.date(), period_end.date())
    transcription_usage = get_transcription_usage(
        db, user_id, period_start.date(), period_end.date()
    )
    token_remaining = (
        None
        if entitlements.platform_token_limit_monthly is None
        else max(
            0,
            entitlements.platform_token_limit_monthly
            - token_usage["used"]
            - token_usage["reserved"],
        )
    )
    transcription_remaining = (
        None
        if entitlements.transcription_minutes_limit_monthly is None
        else max(
            0,
            entitlements.transcription_minutes_limit_monthly
            - transcription_usage["used"]
            - transcription_usage["reserved"],
        )
    )

    return BillingAccountOut(
        billing_enabled=settings.billing_enabled,
        billing_plan_tier=entitlements.billing_plan_tier,
        billing_status=entitlements.billing_status,
        subscription_current_period_start=entitlements.subscription_current_period_start,
        subscription_current_period_end=entitlements.subscription_current_period_end,
        cancel_at_period_end=bool(account.cancel_at_period_end) if account is not None else False,
        can_manage_billing=entitlements.can_manage_billing,
        entitlement_plan_tier=entitlements.entitlement_plan_tier,
        entitlement_source=entitlements.entitlement_source,
        entitlement_expires_at=entitlements.entitlement_expires_at,
        can_share=entitlements.can_share,
        can_use_platform_llm=entitlements.can_use_platform_llm,
        can_transcribe=entitlements.can_transcribe,
        ai_token_usage=BillingUsageBucketOut(
            used=token_usage["used"],
            reserved=token_usage["reserved"],
            limit=entitlements.platform_token_limit_monthly,
            remaining=token_remaining,
            period_start=period_start,
            period_end=period_end,
        ),
        transcription_usage=BillingUsageBucketOut(
            used=transcription_usage["used"],
            reserved=transcription_usage["reserved"],
            limit=entitlements.transcription_minutes_limit_monthly,
            remaining=transcription_remaining,
            period_start=period_start,
            period_end=period_end,
        ),
    )


def create_checkout_session(db: Session, user_id: UUID, email: str | None, plan_tier: str) -> str:
    settings = get_settings()
    if not settings.billing_enabled:
        raise ApiError(ApiErrorCode.E_BILLING_DISABLED, "Billing is currently disabled")
    if not settings.stripe_secret_key:
        raise ApiError(ApiErrorCode.E_BILLING_NOT_CONFIGURED, "Stripe is not configured")

    price_id = _price_id_for_plan(plan_tier)
    if not price_id:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Billing price is not configured")

    stripe.api_key = settings.stripe_secret_key
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    now = _db_now(db)
    if account is None or not account.stripe_customer_id:
        if email:
            customer = stripe.Customer.create(
                email=email,
                metadata={"nexus_user_id": str(user_id)},
            )
        else:
            customer = stripe.Customer.create(metadata={"nexus_user_id": str(user_id)})
        if account is None:
            account = BillingAccount(
                user_id=user_id,
                stripe_customer_id=str(customer["id"]),
                plan_tier="free",
                updated_at=now,
            )
            db.add(account)
        else:
            account.stripe_customer_id = str(customer["id"])
            account.updated_at = now
        db.commit()

    if (
        account.stripe_customer_id
        and account.stripe_subscription_id
        and account.subscription_status in ACTIVE_SUBSCRIPTION_STATUSES
        and (account.current_period_end is None or now < account.current_period_end)
    ):
        session = stripe.billing_portal.Session.create(
            customer=account.stripe_customer_id,
            return_url=f"{settings.app_public_url.rstrip('/')}/settings/billing",
        )
        return str(session["url"])

    stripe_customer_id = account.stripe_customer_id
    if not stripe_customer_id:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "No billing customer exists")

    session = stripe.checkout.Session.create(
        customer=stripe_customer_id,
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.app_public_url.rstrip('/')}/settings/billing?checkout=success",
        cancel_url=f"{settings.app_public_url.rstrip('/')}/settings/billing?checkout=cancel",
        metadata={"nexus_user_id": str(user_id), "plan_tier": plan_tier},
        subscription_data={"metadata": {"nexus_user_id": str(user_id), "plan_tier": plan_tier}},
    )
    return str(session["url"])


def create_customer_portal_session(db: Session, user_id: UUID) -> str:
    settings = get_settings()
    if not settings.billing_enabled:
        raise ApiError(ApiErrorCode.E_BILLING_DISABLED, "Billing is currently disabled")
    if not settings.stripe_secret_key:
        raise ApiError(ApiErrorCode.E_BILLING_NOT_CONFIGURED, "Stripe is not configured")

    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    if account is None or not account.stripe_customer_id:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "No billing account exists")

    stripe.api_key = settings.stripe_secret_key
    session = stripe.billing_portal.Session.create(
        customer=account.stripe_customer_id,
        return_url=f"{settings.app_public_url.rstrip('/')}/settings/billing",
    )
    return str(session["url"])


def process_stripe_webhook(db: Session, raw_body: bytes, signature: str | None) -> dict[str, bool]:
    settings = get_settings()
    if not settings.billing_enabled:
        return {"processed": False}
    if not settings.stripe_webhook_secret:
        raise ApiError(ApiErrorCode.E_BILLING_NOT_CONFIGURED, "Stripe webhooks are not configured")
    if not signature:
        raise ApiError(ApiErrorCode.E_STRIPE_WEBHOOK_INVALID, "Missing Stripe signature")

    try:
        event = stripe.Webhook.construct_event(raw_body, signature, settings.stripe_webhook_secret)
    except Exception as exc:
        raise ApiError(ApiErrorCode.E_STRIPE_WEBHOOK_INVALID, "Invalid Stripe webhook") from exc

    event_id = str(event["id"])
    event_type = str(event["type"])
    existing = db.scalar(
        select(StripeWebhookEvent).where(StripeWebhookEvent.stripe_event_id == event_id)
    )
    if existing is not None:
        return {"processed": False}

    obj = event["data"]["object"]
    if hasattr(obj, "to_dict_recursive"):
        obj = obj.to_dict_recursive()
    elif hasattr(obj, "to_dict"):
        obj = obj.to_dict()
    if event_type == "checkout.session.completed":
        _sync_checkout_session(db, obj)
    elif event_type in {
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }:
        _sync_subscription(db, obj)

    db.add(StripeWebhookEvent(stripe_event_id=event_id, event_type=event_type))
    db.commit()
    return {"processed": True}


def get_platform_token_usage(
    db: Session,
    user_id: UUID,
    start_date: date,
    end_date: date,
) -> dict[str, int]:
    row = db.execute(
        text(
            """
            SELECT
                COALESCE(SUM(spent_tokens), 0),
                COALESCE(SUM(reserved_tokens), 0)
            FROM token_budget_daily_usage
            WHERE user_id = :user_id
              AND usage_date >= :start_date
              AND usage_date < :end_date
            """
        ),
        {"user_id": user_id, "start_date": start_date, "end_date": end_date},
    ).one()
    return {"used": int(row[0] or 0), "reserved": int(row[1] or 0)}


def get_transcription_usage(
    db: Session,
    user_id: UUID,
    start_date: date,
    end_date: date,
) -> dict[str, int]:
    row = db.execute(
        text(
            """
            SELECT
                COALESCE(SUM(minutes_used), 0),
                COALESCE(SUM(minutes_reserved), 0)
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id
              AND usage_date >= :start_date
              AND usage_date < :end_date
            """
        ),
        {"user_id": user_id, "start_date": start_date, "end_date": end_date},
    ).one()
    return {"used": int(row[0] or 0), "reserved": int(row[1] or 0)}


def _price_id_for_plan(plan_tier: str) -> str | None:
    settings = get_settings()
    if plan_tier == "plus":
        return settings.stripe_plus_price_id
    if plan_tier == "ai_plus":
        return settings.stripe_ai_plus_price_id
    if plan_tier == "ai_pro":
        return settings.stripe_ai_pro_price_id
    return None


def _plan_for_price_id(price_id: str | None) -> str:
    settings = get_settings()
    if price_id and price_id == settings.stripe_plus_price_id:
        return "plus"
    if price_id and price_id == settings.stripe_ai_plus_price_id:
        return "ai_plus"
    if price_id and price_id == settings.stripe_ai_pro_price_id:
        return "ai_pro"
    return "free"


def _db_now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _stripe_timestamp(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, int | float | str):
        return None
    return datetime.fromtimestamp(int(value), UTC)


def _sync_checkout_session(db: Session, session: dict) -> None:
    metadata = session.get("metadata") or {}
    raw_user_id = metadata.get("nexus_user_id")
    customer_id = session.get("customer")
    subscription_id = session.get("subscription")
    account = None
    if customer_id:
        account = db.scalar(
            select(BillingAccount).where(BillingAccount.stripe_customer_id == str(customer_id))
        )
    if account is None and raw_user_id:
        account = db.scalar(
            select(BillingAccount).where(BillingAccount.user_id == UUID(raw_user_id))
        )
    if account is None and raw_user_id:
        account = BillingAccount(user_id=UUID(raw_user_id), plan_tier="free")
        db.add(account)
    if account is not None:
        account.stripe_customer_id = str(customer_id) if customer_id else account.stripe_customer_id
        account.stripe_subscription_id = (
            str(subscription_id) if subscription_id else account.stripe_subscription_id
        )
        account.updated_at = _db_now(db)


def _sync_subscription(db: Session, subscription: dict) -> None:
    customer_id = subscription.get("customer")
    subscription_id = subscription.get("id")
    metadata = subscription.get("metadata") or {}
    raw_user_id = metadata.get("nexus_user_id")
    price_id = None
    items = subscription.get("items") or {}
    item_rows = items.get("data") or []
    if item_rows:
        price = item_rows[0].get("price") or {}
        price_id = price.get("id")

    account = None
    if subscription_id:
        account = db.scalar(
            select(BillingAccount).where(
                BillingAccount.stripe_subscription_id == str(subscription_id)
            )
        )
    if account is None and customer_id:
        account = db.scalar(
            select(BillingAccount).where(BillingAccount.stripe_customer_id == str(customer_id))
        )
    if account is None and raw_user_id:
        account = db.scalar(
            select(BillingAccount).where(BillingAccount.user_id == UUID(raw_user_id))
        )
    if account is None and raw_user_id:
        account = BillingAccount(user_id=UUID(raw_user_id), plan_tier="free")
        db.add(account)
    if account is None:
        return

    account.stripe_customer_id = str(customer_id) if customer_id else account.stripe_customer_id
    account.stripe_subscription_id = (
        str(subscription_id) if subscription_id else account.stripe_subscription_id
    )
    account.stripe_price_id = str(price_id) if price_id else None
    account.plan_tier = _plan_for_price_id(str(price_id) if price_id else None)
    account.subscription_status = subscription.get("status")
    account.current_period_start = _stripe_timestamp(subscription.get("current_period_start"))
    account.current_period_end = _stripe_timestamp(subscription.get("current_period_end"))
    account.cancel_at_period_end = bool(subscription.get("cancel_at_period_end"))
    account.updated_at = _db_now(db)
