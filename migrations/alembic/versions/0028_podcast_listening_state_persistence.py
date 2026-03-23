"""Add podcast listening-state persistence table.

Revision ID: 0028
Revises: 0027
Create Date: 2026-03-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_listening_states",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("position_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("playback_speed", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "position_ms >= 0",
            name="ck_podcast_listening_states_position_ms_non_negative",
        ),
        sa.CheckConstraint(
            "duration_ms IS NULL OR duration_ms >= 0",
            name="ck_podcast_listening_states_duration_ms_non_negative",
        ),
        sa.CheckConstraint(
            "playback_speed > 0",
            name="ck_podcast_listening_states_playback_speed_positive",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "media_id"),
    )
    op.create_index(
        "ix_podcast_listening_states_media_id",
        "podcast_listening_states",
        ["media_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_podcast_listening_states_media_id", table_name="podcast_listening_states")
    op.drop_table("podcast_listening_states")
