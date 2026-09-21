"""Delete the Podcast refresh-run ledger: refresh now enqueues one sync per
subscription and the panes observe the subscription rows themselves.

Revision ID: 0239
Revises: 0238
Create Date: 2026-09-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0239"
down_revision: str | Sequence[str] | None = "0238"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS podcast_refresh_runs_notify ON podcast_refresh_runs")
    op.drop_table("podcast_refresh_run_items")
    op.drop_table("podcast_refresh_runs")
    op.execute("DROP FUNCTION IF EXISTS notify_podcast_refresh_run()")
    op.drop_column("podcast_subscriptions", "sync_checkpoint_status")
    op.drop_column("podcast_subscriptions", "sync_checkpoint_cutoff_at")
    op.drop_column("podcast_subscriptions", "sync_checkpoint_new_episode_count")
    op.drop_column("podcast_subscriptions", "sync_checkpoint_completed_at")


def downgrade() -> None:
    raise NotImplementedError("0239 is an irreversible feature deletion")
