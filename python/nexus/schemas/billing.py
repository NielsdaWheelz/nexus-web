"""Billing API schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BillingPlanTier = Literal["free", "plus", "ai_plus", "ai_pro"]
PaidBillingPlanTier = Literal["plus", "ai_plus", "ai_pro"]


class BillingCheckoutRequest(BaseModel):
    plan_tier: PaidBillingPlanTier


class BillingSessionOut(BaseModel):
    url: str


class BillingEntitlementsOut(BaseModel):
    plan_tier: BillingPlanTier
    can_share: bool
    can_use_platform_llm: bool
    platform_token_limit_monthly: int = Field(ge=0)
    transcription_minutes_limit_monthly: int = Field(ge=0)
    current_period_start: datetime | None = None
    current_period_end: datetime | None = None


class BillingUsageBucketOut(BaseModel):
    used: int = Field(ge=0)
    reserved: int = Field(ge=0)
    limit: int = Field(ge=0)
    remaining: int = Field(ge=0)
    period_start: datetime
    period_end: datetime


class BillingAccountOut(BaseModel):
    plan_tier: BillingPlanTier
    subscription_status: str
    current_period_start: datetime | None
    current_period_end: datetime | None
    cancel_at_period_end: bool
    can_share: bool
    can_use_platform_llm: bool
    ai_token_usage: BillingUsageBucketOut
    transcription_usage: BillingUsageBucketOut
