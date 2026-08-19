"""Stable database setup for Podcast subscription lifecycle proofs."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from nexus.db.models import Podcast, PodcastSubscription, PodcastSubscriptionBackfill
from nexus.services.podcasts.provider import PODCAST_PROVIDER


def seed_subscription_lifecycle(
    db: Session,
    *,
    user_id: UUID,
    sync_status: str,
    backfill_state: str,
    podcast_id: UUID | None = None,
) -> tuple[UUID, UUID, UUID]:
    """Create one exact Podcast subscription/backfill lifecycle epoch."""

    podcast_id = podcast_id or uuid4()
    subscription_id = uuid4()
    backfill_id = uuid4()
    now = datetime.now(UTC)
    if db.get(Podcast, podcast_id) is None:
        db.add(
            Podcast(
                id=podcast_id,
                provider=PODCAST_PROVIDER,
                provider_podcast_id=f"lifecycle-{podcast_id}",
                title="Lifecycle proof podcast",
                feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
            )
        )
    db.add(
        PodcastSubscription(
            id=subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
            sync_status=sync_status,
            sync_attempts=1,
            sync_generation=1,
            next_sync_at=now,
        )
    )
    db.flush()
    db.add(
        PodcastSubscriptionBackfill(
            id=backfill_id,
            subscription_id=subscription_id,
            cutoff_at=now,
            step_no=3,
            cursor=None,
            processed_count=7,
            added_count=2,
            started_at=now if backfill_state != "Pending" else None,
            completed_at=now if backfill_state == "Complete" else None,
            source_limited_at=now if backfill_state == "SourceLimited" else None,
            failed_at=now if backfill_state == "Failed" else None,
        )
    )
    db.flush()
    return podcast_id, subscription_id, backfill_id
