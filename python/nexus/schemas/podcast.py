"""Pydantic schemas for podcast discovery, subscription, and plan policy."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class PodcastDiscoveryOut(BaseModel):
    provider_podcast_id: str
    title: str
    author: str | None = None
    feed_url: str
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None


class PodcastSubscribeRequest(BaseModel):
    provider_podcast_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    author: str | None = None
    feed_url: str = Field(min_length=1)
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None


class PodcastSubscribeOut(BaseModel):
    podcast_id: UUID
    subscription_created: bool
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_enqueued: bool
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    last_synced_at: datetime | None = None
    window_size: int


class PodcastPlanUpdateRequest(BaseModel):
    plan_tier: Literal["free", "paid"]
    daily_transcription_minutes: int | None = Field(default=None, ge=0)
    initial_episode_window: int = Field(ge=1)


class PodcastPlanOut(BaseModel):
    user_id: UUID
    plan_tier: str
    daily_transcription_minutes: int | None
    initial_episode_window: int
    updated_at: datetime


class PodcastSubscriptionStatusOut(BaseModel):
    user_id: UUID
    podcast_id: UUID
    status: Literal["active", "unsubscribed"]
    unsubscribe_mode: Literal[1, 2, 3] = 1
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime
