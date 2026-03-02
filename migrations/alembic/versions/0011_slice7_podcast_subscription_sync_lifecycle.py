"""Slice 7 PR-01 — podcast subscription sync lifecycle state

Revision ID: 0011
Revises: 0010
Create Date: 2026-03-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_status", sa.Text(), server_default="pending", nullable=False),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_error_code", sa.Text(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_error_message", sa.Text(), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_attempts", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_started_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("sync_completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("last_synced_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )

    op.create_check_constraint(
        "ck_podcast_subscriptions_sync_status",
        "podcast_subscriptions",
        "sync_status IN ('pending', 'running', 'partial', 'complete', 'source_limited', 'failed')",
    )
    op.create_check_constraint(
        "ck_podcast_subscriptions_sync_attempts_non_negative",
        "podcast_subscriptions",
        "sync_attempts >= 0",
    )
    op.create_index(
        "ix_podcast_subscriptions_sync_status",
        "podcast_subscriptions",
        ["sync_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_podcast_subscriptions_sync_status", table_name="podcast_subscriptions")
    op.drop_constraint(
        "ck_podcast_subscriptions_sync_attempts_non_negative",
        "podcast_subscriptions",
        type_="check",
    )
    op.drop_constraint(
        "ck_podcast_subscriptions_sync_status",
        "podcast_subscriptions",
        type_="check",
    )

    op.drop_column("podcast_subscriptions", "last_synced_at")
    op.drop_column("podcast_subscriptions", "sync_completed_at")
    op.drop_column("podcast_subscriptions", "sync_started_at")
    op.drop_column("podcast_subscriptions", "sync_attempts")
    op.drop_column("podcast_subscriptions", "sync_error_message")
    op.drop_column("podcast_subscriptions", "sync_error_code")
    op.drop_column("podcast_subscriptions", "sync_status")
