"""Effective billing entitlement policy."""

from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import BillingAccount, BillingEntitlementOverride
from nexus.schemas.billing import (
    BillingEntitlementsOut,
    BillingPlanTier,
    EntitlementSource,
    PaidBillingPlanTier,
    QuotaMode,
)

ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}
PLAN_RANK = {"free": 0, "plus": 1, "ai_plus": 2, "ai_pro": 3}


def get_effective_entitlements(db: Session, user_id: UUID) -> BillingEntitlementsOut:
    now = _db_now(db)
    settings = get_settings()
    account = db.scalar(select(BillingAccount).where(BillingAccount.user_id == user_id))
    override = db.scalar(
        select(BillingEntitlementOverride).where(BillingEntitlementOverride.user_id == user_id)
    )

    billing_plan = _billing_plan(account)
    billing_status = (
        account.subscription_status if account and account.subscription_status else "free"
    )
    subscription_active = (
        account is not None
        and billing_plan != "free"
        and account.subscription_status in ACTIVE_SUBSCRIPTION_STATUSES
        and (account.current_period_end is None or now < account.current_period_end)
    )
    effective_plan: BillingPlanTier = billing_plan if subscription_active else "free"
    source: EntitlementSource = "subscription" if subscription_active else "free"

    active_grant = None
    if (
        override is not None
        and override.revoked_at is None
        and (override.expires_at is None or now < override.expires_at)
    ):
        active_grant = override
    if active_grant is not None:
        grant_changes_quota = active_grant.transcription_quota_mode != "plan"
        grant_plan = cast(BillingPlanTier, active_grant.plan_tier)
        if PLAN_RANK[grant_plan] > PLAN_RANK[effective_plan]:
            effective_plan = grant_plan
            source = "internal_grant"
        elif grant_changes_quota:
            source = "internal_grant"

    can_share = PLAN_RANK[effective_plan] >= PLAN_RANK["plus"]
    can_transcribe = PLAN_RANK[effective_plan] >= PLAN_RANK["ai_plus"]

    transcription_limit = _plan_transcription_limit(effective_plan) if can_transcribe else 0
    if active_grant is not None and can_transcribe:
        transcription_limit = _grant_limit(
            active_grant.transcription_quota_mode,
            active_grant.transcription_minutes_limit_monthly,
            transcription_limit,
        )

    usage_start, usage_end = _usage_period(now, account if subscription_active else None)
    return BillingEntitlementsOut(
        billing_plan_tier=billing_plan,
        billing_status=billing_status,
        entitlement_plan_tier=effective_plan,
        entitlement_source=source,
        can_share=can_share,
        can_transcribe=can_transcribe,
        transcription_minutes_limit_monthly=transcription_limit,
        usage_period_start=usage_start,
        usage_period_end=usage_end,
        subscription_current_period_start=account.current_period_start if account else None,
        subscription_current_period_end=account.current_period_end if account else None,
        entitlement_expires_at=active_grant.expires_at if active_grant is not None else None,
        grant_id=str(active_grant.id) if active_grant is not None else None,
        can_manage_billing=bool(
            settings.billing_enabled
            and settings.stripe_secret_key
            and account is not None
            and account.stripe_customer_id
        ),
    )


def grant_entitlement_override(
    db: Session,
    *,
    user_id: UUID,
    plan_tier: PaidBillingPlanTier,
    transcription_quota_mode: QuotaMode,
    transcription_minutes_limit_monthly: int | None,
    expires_at: datetime | None,
    reason: str,
    actor_user_id: UUID | None = None,
    actor_label: str | None = None,
) -> BillingEntitlementOverride:
    now = _db_now(db)
    grant = db.scalar(
        select(BillingEntitlementOverride).where(BillingEntitlementOverride.user_id == user_id)
    )
    if grant is None:
        grant = BillingEntitlementOverride(
            user_id=user_id,
            plan_tier=plan_tier,
            reason=reason,
            created_by_user_id=actor_user_id,
            created_by_label=actor_label,
            updated_at=now,
        )
        db.add(grant)

    grant.plan_tier = plan_tier
    grant.transcription_quota_mode = transcription_quota_mode
    grant.transcription_minutes_limit_monthly = transcription_minutes_limit_monthly
    grant.expires_at = expires_at
    grant.revoked_at = None
    grant.reason = reason
    grant.updated_by_user_id = actor_user_id
    grant.updated_by_label = actor_label
    grant.updated_at = now
    db.commit()
    return grant


def revoke_entitlement_override(
    db: Session,
    *,
    user_id: UUID,
    reason: str,
    actor_user_id: UUID | None = None,
    actor_label: str | None = None,
) -> BillingEntitlementOverride:
    grant = db.scalar(
        select(BillingEntitlementOverride).where(BillingEntitlementOverride.user_id == user_id)
    )
    if grant is None:
        raise ValueError("No billing entitlement override exists for user")

    now = _db_now(db)
    grant.revoked_at = now
    grant.reason = reason
    grant.updated_by_user_id = actor_user_id
    grant.updated_by_label = actor_label
    grant.updated_at = now
    db.commit()
    return grant


def _billing_plan(account: BillingAccount | None) -> BillingPlanTier:
    if account is None or account.plan_tier not in PLAN_RANK:
        return "free"
    return cast(BillingPlanTier, account.plan_tier)


def _plan_transcription_limit(plan_tier: str) -> int:
    settings = get_settings()
    if plan_tier == "ai_plus":
        return settings.billing_ai_plus_transcription_minutes_monthly
    if plan_tier == "ai_pro":
        return settings.billing_ai_pro_transcription_minutes_monthly
    return 0


def _grant_limit(mode: str, custom_limit: int | None, plan_limit: int) -> int | None:
    if mode == "unlimited":
        return None
    if mode == "custom":
        return int(custom_limit or 0)
    return plan_limit


def _usage_period(now: datetime, account: BillingAccount | None) -> tuple[datetime, datetime]:
    if account and account.current_period_start and account.current_period_end:
        return account.current_period_start, account.current_period_end
    start = datetime(now.year, now.month, 1, tzinfo=UTC)
    if now.month == 12:
        return start, datetime(now.year + 1, 1, 1, tzinfo=UTC)
    return start, datetime(now.year, now.month + 1, 1, tzinfo=UTC)


def _db_now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()
