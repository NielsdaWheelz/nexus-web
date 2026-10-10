"""Podcast sync without epochs: the queue's single claim, one subscription row lock.

Revision ID: 0270
Revises: 0269

1. drop the sync epoch, its job pointer and the attempt fence (``sync_generation``,
   ``sync_job_id``, ``sync_job_attempt_no``): the job queue's single claim and the
   subscription row lock at commit replace them;
2. an enabled auto-queue always has a watermark: rows enabled without one start at
   migration time (their back catalogue is never queued), then a CHECK holds it;
3. a subscription's backfill and an episode's identity aliases die with their parent;
4. delete the podcast command replay ledger (commands are idempotent by construction).

Drain the old worker first: it reads the dropped columns. Queued sync jobs survive (their
payload is a superset of the new one). Irreversible.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0270"
down_revision: str | Sequence[str] | None = "0269"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE podcast_subscriptions
            DROP COLUMN sync_generation,
            DROP COLUMN sync_job_id,
            DROP COLUMN sync_job_attempt_no
    """)
    op.execute("""
        UPDATE podcast_subscriptions SET auto_queue_watermark_at = now()
        WHERE auto_queue AND auto_queue_watermark_at IS NULL
    """)
    op.execute("""
        ALTER TABLE podcast_subscriptions
            ADD CONSTRAINT ck_podcast_subscriptions_auto_queue_watermark
            CHECK (NOT auto_queue OR auto_queue_watermark_at IS NOT NULL)
    """)
    op.execute("""
        ALTER TABLE podcast_subscription_backfills
            DROP CONSTRAINT fk_podcast_subscription_backfills_subscription,
            ADD CONSTRAINT fk_podcast_subscription_backfills_subscription
                FOREIGN KEY (subscription_id) REFERENCES podcast_subscriptions(id)
                ON DELETE CASCADE
    """)
    op.execute("""
        ALTER TABLE podcast_episode_identities
            DROP CONSTRAINT fk_podcast_episode_identities_episode,
            ADD CONSTRAINT fk_podcast_episode_identities_episode
                FOREIGN KEY (podcast_id, episode_media_id)
                REFERENCES podcast_episodes(podcast_id, media_id) ON DELETE CASCADE
    """)
    op.execute("DELETE FROM resource_mutations WHERE mutation_scope = 'podcast:control'")


def downgrade() -> None:
    raise NotImplementedError("0270 is an irreversible schema deletion")
