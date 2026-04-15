"""Stripe billing state and entitlement checks."""

from datetime import UTC, date, datetime
from uuid import UUID

import stripe
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import BillingAccount, StripeWebhookEvent
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.billing import BillingAccountOut, BillingEntitlementsOut, BillingUsageBucketOut

ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}


def get_entitlements(db: Session, user_id: UUID) -> BillingEntitlementsOut:
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    if account is None:
        return _free_entitlements()

    now = _db_now(db)
    if account.subscription_status not in ACTIVE_SUBSCRIPTION_STATUSES:
        return _free_entitlements()
    if account.current_period_end is not None and now >= account.current_period_end:
        return _free_entitlements()

    settings = get_settings()
    if account.plan_tier == "plus":
        return BillingEntitlementsOut(
            plan_tier="plus",
            can_share=True,
            can_use_platform_llm=False,
            platform_token_limit_monthly=0,
            transcription_minutes_limit_monthly=0,
            current_period_start=account.current_period_start,
            current_period_end=account.current_period_end,
        )
    if account.plan_tier == "ai_plus":
        return BillingEntitlementsOut(
            plan_tier="ai_plus",
            can_share=True,
            can_use_platform_llm=True,
            platform_token_limit_monthly=settings.billing_ai_plus_platform_token_limit_monthly,
            transcription_minutes_limit_monthly=settings.billing_ai_plus_transcription_minutes_monthly,
            current_period_start=account.current_period_start,
            current_period_end=account.current_period_end,
        )
    if account.plan_tier == "ai_pro":
        return BillingEntitlementsOut(
            plan_tier="ai_pro",
            can_share=True,
            can_use_platform_llm=True,
            platform_token_limit_monthly=settings.billing_ai_pro_platform_token_limit_monthly,
            transcription_minutes_limit_monthly=settings.billing_ai_pro_transcription_minutes_monthly,
            current_period_start=account.current_period_start,
            current_period_end=account.current_period_end,
        )
    return _free_entitlements()


def get_billing_account(db: Session, user_id: UUID) -> BillingAccountOut:
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    entitlements = get_entitlements(db, user_id)
    period_start, period_end = _usage_period(db, entitlements)
    token_usage = get_platform_token_usage(db, user_id, period_start.date(), period_end.date())
    transcription_usage = get_transcription_usage(
        db, user_id, period_start.date(), period_end.date()
    )

    return BillingAccountOut(
        plan_tier=entitlements.plan_tier,
        subscription_status=account.subscription_status if account is not None else "free",
        current_period_start=entitlements.current_period_start,
        current_period_end=entitlements.current_period_end,
        cancel_at_period_end=bool(account.cancel_at_period_end) if account is not None else False,
        can_share=entitlements.can_share,
        can_use_platform_llm=entitlements.can_use_platform_llm,
        ai_token_usage=BillingUsageBucketOut(
            used=token_usage["used"],
            reserved=token_usage["reserved"],
            limit=entitlements.platform_token_limit_monthly,
            remaining=max(
                0,
                entitlements.platform_token_limit_monthly
                - token_usage["used"]
                - token_usage["reserved"],
            ),
            period_start=period_start,
            period_end=period_end,
        ),
        transcription_usage=BillingUsageBucketOut(
            used=transcription_usage["used"],
            reserved=transcription_usage["reserved"],
            limit=entitlements.transcription_minutes_limit_monthly,
            remaining=max(
                0,
                entitlements.transcription_minutes_limit_monthly
                - transcription_usage["used"]
                - transcription_usage["reserved"],
            ),
            period_start=period_start,
            period_end=period_end,
        ),
    )


def create_checkout_session(db: Session, user_id: UUID, email: str | None, plan_tier: str) -> str:
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise ApiError(ApiErrorCode.E_BILLING_NOT_CONFIGURED, "Stripe is not configured")

    price_id = _price_id_for_plan(plan_tier)
    if not price_id:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Billing price is not configured")

    stripe.api_key = settings.stripe_secret_key
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    if account is None or not account.stripe_customer_id:
        customer = stripe.Customer.create(
            email=email,
            metadata={"nexus_user_id": str(user_id)},
        )
        now = _db_now(db)
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

    session = stripe.checkout.Session.create(
        customer=account.stripe_customer_id,
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


def _free_entitlements() -> BillingEntitlementsOut:
    return BillingEntitlementsOut(
        plan_tier="free",
        can_share=False,
        can_use_platform_llm=False,
        platform_token_limit_monthly=0,
        transcription_minutes_limit_monthly=0,
    )


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


def _usage_period(
    db: Session,
    entitlements: BillingEntitlementsOut,
) -> tuple[datetime, datetime]:
    if entitlements.current_period_start and entitlements.current_period_end:
        return entitlements.current_period_start, entitlements.current_period_end

    now = _db_now(db)
    start = datetime(now.year, now.month, 1, tzinfo=UTC)
    if now.month == 12:
        end = datetime(now.year + 1, 1, 1, tzinfo=UTC)
    else:
        end = datetime(now.year, now.month + 1, 1, tzinfo=UTC)
    return start, end


def _db_now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _stripe_timestamp(value: object) -> datetime | None:
    if value is None:
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
