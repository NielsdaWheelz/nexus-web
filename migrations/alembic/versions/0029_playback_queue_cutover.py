"""Add playback queue table and subscription auto-queue flag.

Revision ID: 0029
Revises: 0028
Create Date: 2026-03-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "playback_queue_items",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "added_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("source", sa.Text(), nullable=False, server_default="manual"),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_playback_queue_items_position_non_negative",
        ),
        sa.CheckConstraint(
            "source IN ('manual', 'auto_subscription', 'auto_playlist')",
            name="ck_playback_queue_items_source",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "media_id", name="uq_playback_queue_items_user_media"),
    )
    op.create_index(
        "ix_playback_queue_items_user_position",
        "playback_queue_items",
        ["user_id", "position"],
    )

    op.add_column(
        "podcast_subscriptions",
        sa.Column("auto_queue", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("podcast_subscriptions", "auto_queue")
    op.drop_index("ix_playback_queue_items_user_position", table_name="playback_queue_items")
    op.drop_table("playback_queue_items")
