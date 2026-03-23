"""Pydantic schemas for podcast discovery, subscription, and plan policy."""

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    auto_queue: bool = False


class PodcastSubscribeOut(BaseModel):
    podcast_id: UUID
    subscription_created: bool
    auto_queue: bool
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_enqueued: bool
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    last_synced_at: datetime | None = None
    window_size: int


class PodcastSubscriptionSettingsPatchRequest(BaseModel):
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool | None = None
    category_id: UUID | None = None

    @model_validator(mode="after")
    def validate_patch_semantics(self) -> "PodcastSubscriptionSettingsPatchRequest":
        if (
            "default_playback_speed" not in self.model_fields_set
            and "auto_queue" not in self.model_fields_set
            and "category_id" not in self.model_fields_set
        ):
            raise ValueError("At least one settings field is required")
        if "auto_queue" in self.model_fields_set and self.auto_queue is None:
            raise ValueError("auto_queue must be a boolean")
        return self

    model_config = ConfigDict(extra="forbid")


class PodcastOpmlImportErrorOut(BaseModel):
    feed_url: str | None = None
    error: str


class PodcastSubscriptionCategoryRefOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None


class PodcastSubscriptionCategoryOut(BaseModel):
    id: UUID
    name: str
    position: int = Field(ge=0)
    color: str | None = None
    created_at: datetime
    subscription_count: int = Field(ge=0)
    unplayed_count: int = Field(ge=0)


class PodcastSubscriptionCategoryCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    model_config = ConfigDict(extra="forbid")


class PodcastSubscriptionCategoryPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    position: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_patch_semantics(self) -> "PodcastSubscriptionCategoryPatchRequest":
        if (
            "name" not in self.model_fields_set
            and "color" not in self.model_fields_set
            and "position" not in self.model_fields_set
        ):
            raise ValueError("At least one category field is required")
        return self

    model_config = ConfigDict(extra="forbid")


class PodcastSubscriptionCategoryOrderRequest(BaseModel):
    category_ids: list[UUID] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_order_ids(self) -> "PodcastSubscriptionCategoryOrderRequest":
        if len(set(self.category_ids)) != len(self.category_ids):
            raise ValueError("category_ids must not contain duplicates")
        return self

    model_config = ConfigDict(extra="forbid")


class PodcastOpmlImportOut(BaseModel):
    total: int = Field(ge=0)
    imported: int = Field(ge=0)
    skipped_already_subscribed: int = Field(ge=0)
    skipped_invalid: int = Field(ge=0)
    errors: list[PodcastOpmlImportErrorOut] = Field(default_factory=list)


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
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool = False
    category: PodcastSubscriptionCategoryRefOut | None = None
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime


class PodcastListItemOut(BaseModel):
    id: UUID
    provider: str
    provider_podcast_id: str
    title: str
    author: str | None = None
    feed_url: str
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class PodcastSubscriptionListItemOut(BaseModel):
    podcast_id: UUID
    status: Literal["active", "unsubscribed"]
    unsubscribe_mode: Literal[1, 2, 3] = 1
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool = False
    category: PodcastSubscriptionCategoryRefOut | None = None
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime
    unplayed_count: int = Field(ge=0, default=0)
    podcast: PodcastListItemOut


class PodcastDetailOut(BaseModel):
    podcast: PodcastListItemOut
    subscription: PodcastSubscriptionStatusOut


class PodcastSubscriptionSyncRefreshOut(BaseModel):
    podcast_id: UUID
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_enqueued: bool


class PodcastEffectivePlanOut(BaseModel):
    plan_tier: str
    daily_transcription_minutes: int | None
    initial_episode_window: int


class PodcastPlanUsageOut(BaseModel):
    usage_date: date
    used_minutes: int
    reserved_minutes: int
    total_minutes: int
    remaining_minutes: int | None


class PodcastPlanSnapshotOut(BaseModel):
    plan: PodcastEffectivePlanOut
    usage: PodcastPlanUsageOut
