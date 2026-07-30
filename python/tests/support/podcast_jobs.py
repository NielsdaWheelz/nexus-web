"""Test driver for the exact Podcast subscription-sync queue boundary."""

from dataclasses import asdict
from uuid import UUID, uuid4

from sqlalchemy import text

from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.jobs.queue import JobExecutionContext, claim_job, complete_job
from nexus.services.podcasts.refresh import (
    PODCAST_SYNC_INTERACTIVE_PRIORITY,
    admit_subscription_generation_in_txn,
)
from nexus.services.podcasts.sync import (
    SubscriptionSyncResult,
    run_podcast_subscription_sync_now,
)
from tests.utils.db import DirectSessionManager


def run_queued_podcast_subscription_sync(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    podcast_id: UUID,
) -> SubscriptionSyncResult:
    """Admit if terminal, claim the exact child job, run it, then complete it."""

    worker_id = f"podcast-sync-test:{uuid4()}"
    with direct_db.session() as db:
        row = (
            db.execute(
                text(
                    """
                    SELECT id, sync_job_id
                    FROM podcast_subscriptions
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            .mappings()
            .one()
        )
        subscription_id = UUID(str(row["id"]))
        job_id = UUID(str(row["sync_job_id"])) if row["sync_job_id"] is not None else None
        db.rollback()

        if job_id is None:

            def admit():
                with transaction(db):
                    return admit_subscription_generation_in_txn(
                        db,
                        subscription_id=subscription_id,
                        user_id=user_id,
                        podcast_id=podcast_id,
                        priority=PODCAST_SYNC_INTERACTIVE_PRIORITY,
                    )

            job_id = retry_serializable(
                db,
                "test_admit_podcast_subscription_sync",
                admit,
            ).job_id

        claimed = claim_job(
            db,
            job_id=job_id,
            worker_id=worker_id,
            lease_seconds=900,
            allowed_kinds=("podcast_sync_subscription_job",),
        )
        if claimed is None:
            raise AssertionError("test did not claim the expected Podcast sync operation")
        db.commit()
        direct_db.register_cleanup("background_jobs", "id", claimed.id)

        result = run_podcast_subscription_sync_now(
            db,
            payload=claimed.payload,
            context=JobExecutionContext(
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
            ),
        )
        if not complete_job(
            db,
            job_id=claimed.id,
            worker_id=worker_id,
            result_payload=asdict(result),
        ):
            raise AssertionError("test Podcast sync operation lost its queue claim")
        db.commit()
        return result
