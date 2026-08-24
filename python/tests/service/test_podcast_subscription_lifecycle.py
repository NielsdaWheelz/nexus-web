"""Subscription lifecycle snapshots are viewer-owned and terminal only when settled."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import PodcastSubscription, PodcastSubscriptionBackfill
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.podcasts import subscriptions
from tests.testkit.auth import UserRecord
from tests.testkit.podcast_subscription_lifecycle import seed_subscription_lifecycle


@pytest.mark.parametrize(
    ("sync_status", "backfill_state", "terminal"),
    [
        ("Pending", "Pending", False),
        ("Running", "Complete", False),
        ("Complete", "Running", False),
        ("Complete", "Complete", True),
        ("SourceLimited", "Failed", True),
    ],
)
def test_subscription_lifecycle_snapshot_owns_current_state_and_dual_terminality(
    db_session: Session,
    test_user: UserRecord,
    sync_status: str,
    backfill_state: str,
    terminal: bool,
) -> None:
    podcast_id, _, backfill_id = seed_subscription_lifecycle(
        db_session,
        user_id=test_user.id,
        sync_status=sync_status,
        backfill_state=backfill_state,
    )

    lifecycle = subscriptions.read_subscription_lifecycle(
        db_session,
        viewer_id=test_user.id,
        podcast_id=podcast_id,
    )

    assert lifecycle.snapshot.model_dump(mode="json", by_alias=True) == {
        "podcastId": str(podcast_id),
        "syncStatus": sync_status,
        "backfill": {
            "id": str(backfill_id),
            "state": backfill_state,
            "processedCount": 7,
            "addedCount": 2,
        },
    }
    assert lifecycle.terminal is terminal, (
        "subscription lifecycle became terminal before both sync owners settled"
    )


def test_subscription_lifecycle_masks_foreign_subscription(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    foreign_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        foreign_user_id,
        f"foreign-lifecycle-{foreign_user_id}@example.invalid",
    )
    podcast_id, _, _ = seed_subscription_lifecycle(
        db_session,
        user_id=foreign_user_id,
        sync_status="Complete",
        backfill_state="Complete",
    )

    with pytest.raises(ApiError) as raised:
        subscriptions.read_subscription_lifecycle(
            db_session,
            viewer_id=test_user.id,
            podcast_id=podcast_id,
        )

    assert raised.value.code is ApiErrorCode.E_NOT_FOUND


def test_subscription_lifecycle_rejects_a_replaced_listener_epoch(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    podcast_id, prior_subscription_id, prior_backfill_id = seed_subscription_lifecycle(
        db_session,
        user_id=test_user.id,
        sync_status="Pending",
        backfill_state="Pending",
    )
    prior_backfill = db_session.get(PodcastSubscriptionBackfill, prior_backfill_id)
    prior_subscription = db_session.get(PodcastSubscription, prior_subscription_id)
    assert prior_backfill is not None
    assert prior_subscription is not None
    db_session.delete(prior_backfill)
    db_session.flush()
    db_session.delete(prior_subscription)
    db_session.flush()
    _, replacement_subscription_id, _ = seed_subscription_lifecycle(
        db_session,
        user_id=test_user.id,
        podcast_id=podcast_id,
        sync_status="Pending",
        backfill_state="Pending",
    )
    assert replacement_subscription_id != prior_subscription_id

    with pytest.raises(ApiError) as raised:
        subscriptions.read_subscription_lifecycle(
            db_session,
            viewer_id=test_user.id,
            podcast_id=podcast_id,
            expected_subscription_id=prior_subscription_id,
        )

    assert raised.value.code is ApiErrorCode.E_NOT_FOUND
