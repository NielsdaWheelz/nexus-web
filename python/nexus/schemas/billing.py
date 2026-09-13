"""Billing API schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BillingPlanTier = Literal["free", "plus", "ai_plus", "ai_pro"]
PaidBillingPlanTier = Literal["plus", "ai_plus", "ai_pro"]
EntitlementSource = Literal["free", "subscription", "internal_grant"]
QuotaMode = Literal["plan", "custom", "unlimited"]


class BillingCheckoutRequest(BaseModel):
    plan_tier: PaidBillingPlanTier


class BillingSessionOut(BaseModel):
    url: str


class BillingEntitlementsOut(BaseModel):
    billing_plan_tier: BillingPlanTier
    billing_status: str
    entitlement_plan_tier: BillingPlanTier
    entitlement_source: EntitlementSource
    can_share: bool
    can_use_platform_llm: bool
    can_transcribe: bool
    platform_token_limit_monthly: int | None = Field(default=None, ge=0)
    transcription_minutes_limit_monthly: int | None = Field(default=None, ge=0)
    usage_period_start: datetime
    usage_period_end: datetime
    subscription_current_period_start: datetime | None = None
    subscription_current_period_end: datetime | None = None
    entitlement_expires_at: datetime | None = None
    grant_id: str | None = None
    can_manage_billing: bool = False


class BillingUsageBucketOut(BaseModel):
    used: int = Field(ge=0)
    reserved: int = Field(ge=0)
    limit: int | None = Field(default=None, ge=0)
    remaining: int | None = Field(default=None, ge=0)
    period_start: datetime
    period_end: datetime


class BillingAccountOut(BaseModel):
    billing_enabled: bool
    billing_plan_tier: BillingPlanTier
    billing_status: str
    subscription_current_period_start: datetime | None
    subscription_current_period_end: datetime | None
    cancel_at_period_end: bool
    can_manage_billing: bool
    entitlement_plan_tier: BillingPlanTier
    entitlement_source: EntitlementSource
    entitlement_expires_at: datetime | None
    can_share: bool
    can_use_platform_llm: bool
    can_transcribe: bool
    ai_token_usage: BillingUsageBucketOut
    transcription_usage: BillingUsageBucketOut
