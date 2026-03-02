"""Slice 7 PR-04 — active subscription polling orchestration + ops hardening

Revision ID: 0014
Revises: 0013
Create Date: 2026-03-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_subscription_poll_runs",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("orchestration_source", sa.Text(), server_default="scheduled", nullable=False),
        sa.Column("scheduler_identity", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column("run_limit", sa.Integer(), nullable=False),
        sa.Column(
            "started_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("processed_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("failed_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("scanned_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('running', 'completed', 'failed', 'expired')",
            name="ck_podcast_subscription_poll_runs_status",
        ),
        sa.CheckConstraint(
            "run_limit >= 1",
            name="ck_podcast_subscription_poll_runs_run_limit_positive",
        ),
        sa.CheckConstraint(
            "processed_count >= 0 AND failed_count >= 0 AND skipped_count >= 0 AND scanned_count >= 0",
            name="ck_podcast_subscription_poll_runs_counters_non_negative",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index(
        "ix_podcast_subscription_poll_runs_started_at",
        "podcast_subscription_poll_runs",
        ["started_at"],
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_podcast_subscription_poll_runs_singleton_running
        ON podcast_subscription_poll_runs ((1))
        WHERE status = 'running'
        """
    )

    op.create_table(
        "podcast_subscription_poll_run_failures",
        sa.Column("run_id", sa.UUID(), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=False),
        sa.Column("failure_count", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "failure_count >= 1",
            name="ck_podcast_subscription_poll_run_failures_count_positive",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["podcast_subscription_poll_runs.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("run_id", "error_code"),
    )


def downgrade() -> None:
    op.drop_table("podcast_subscription_poll_run_failures")
    op.execute("DROP INDEX uq_podcast_subscription_poll_runs_singleton_running")
    op.drop_index("ix_podcast_subscription_poll_runs_started_at", table_name="podcast_subscription_poll_runs")
    op.drop_table("podcast_subscription_poll_runs")

