"""Hard-cut Podcast freshness and refresh-run orchestration.

Revision ID: 0203
Revises: 0202
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0203"
down_revision: str | Sequence[str] | None = "0202"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _assert_zero(bind, sql: str, message: str) -> None:
    count = bind.scalar(sa.text(sql))
    if count:
        raise RuntimeError(f"0203: {message}: {count} row(s)")


def upgrade() -> None:
    bind = op.get_bind()
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM background_jobs
        WHERE kind IN (
            'podcast_active_subscription_poll_job',
            'podcast_sync_subscription_job'
        )
          AND status IN ('pending', 'running', 'failed')
        """,
        "deployment preflight must drain every active legacy Podcast job",
    )

    op.alter_column(
        "podcast_subscriptions",
        "last_synced_at",
        new_column_name="last_checked_at",
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_generation", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("consecutive_sync_failures", sa.Integer(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_job_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_job_attempt_no", sa.Integer(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_checkpoint_status", sa.Text(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_checkpoint_cutoff_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_checkpoint_new_episode_count", sa.Integer(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_checkpoint_completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.drop_constraint(
        "ck_podcast_subscriptions_sync_status",
        "podcast_subscriptions",
        type_="check",
    )
    op.alter_column(
        "podcast_subscriptions",
        "sync_status",
        server_default=None,
    )
    op.execute(
        """
        UPDATE podcast_subscriptions
        SET
            sync_status = CASE sync_status
                WHEN 'pending' THEN 'Pending'
                WHEN 'running' THEN 'Running'
                WHEN 'partial' THEN 'SourceLimited'
                WHEN 'complete' THEN 'Complete'
                WHEN 'source_limited' THEN 'SourceLimited'
                WHEN 'failed' THEN 'Failed'
            END,
            sync_generation = 0,
            consecutive_sync_failures = 0,
            next_sync_at = COALESCE(last_checked_at + interval '23 hours', now())
        """
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_subscriptions
        WHERE sync_status IN ('Pending', 'Running')
        """,
        "deployment preflight must drain every active legacy sync",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_subscriptions
        WHERE sync_status IS NULL
           OR sync_status NOT IN ('Complete', 'SourceLimited', 'Failed')
        """,
        "legacy subscription sync status conversion is incomplete",
    )
    op.alter_column(
        "podcast_subscriptions",
        "sync_status",
        server_default="Pending",
    )
    op.alter_column(
        "podcast_subscriptions",
        "sync_generation",
        nullable=False,
        server_default="0",
    )
    op.alter_column(
        "podcast_subscriptions",
        "next_sync_at",
        nullable=False,
    )
    op.alter_column(
        "podcast_subscriptions",
        "consecutive_sync_failures",
        nullable=False,
        server_default="0",
    )
    op.drop_index(
        "ix_podcast_subscriptions_sync_status",
        table_name="podcast_subscriptions",
    )
    op.create_index(
        "ix_podcast_subscriptions_next_sync_at_id",
        "podcast_subscriptions",
        ["next_sync_at", "id"],
    )

    op.drop_table("podcast_subscription_poll_run_failures")
    op.drop_table("podcast_subscription_poll_runs")

    op.create_table(
        "podcast_refresh_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("request_hash", sa.Text(), nullable=True),
        sa.Column(
            "scope",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("requested_count", sa.Integer(), nullable=False),
        sa.Column("finished_count", sa.Integer(), nullable=False),
        sa.Column("succeeded_count", sa.Integer(), nullable=False),
        sa.Column("source_limited_count", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("skipped_count", sa.Integer(), nullable=False),
        sa.Column("new_episode_count", sa.Integer(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_podcast_refresh_runs"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_podcast_refresh_runs_user",
        ),
    )
    op.create_index(
        "uq_podcast_refresh_runs_user_idempotency_key",
        "podcast_refresh_runs",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )
    op.create_index(
        "ix_podcast_refresh_runs_completed_at_id",
        "podcast_refresh_runs",
        ["completed_at", "id"],
    )

    op.create_table(
        "podcast_refresh_run_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("podcast_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("subscription_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sync_generation", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("new_episode_count", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_podcast_refresh_run_items"),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["podcast_refresh_runs.id"],
            name="fk_podcast_refresh_run_items_run",
        ),
        sa.ForeignKeyConstraint(
            ["podcast_id"],
            ["podcasts.id"],
            name="fk_podcast_refresh_run_items_podcast",
        ),
        sa.UniqueConstraint(
            "run_id",
            "subscription_id",
            name="uq_podcast_refresh_run_items_run_subscription",
        ),
    )

    op.execute(
        """
        CREATE FUNCTION notify_podcast_refresh_run() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            PERFORM pg_notify('podcast_refresh_events', NEW.id::text);
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER podcast_refresh_runs_notify
        AFTER INSERT OR UPDATE ON podcast_refresh_runs
        FOR EACH ROW EXECUTE FUNCTION notify_podcast_refresh_run()
        """
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0203 is not reversible")
