"""Add per-subscription default playback speed.

Revision ID: 0034
Revises: 0033
Create Date: 2026-03-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("default_playback_speed", sa.Float(), nullable=True),
    )
    op.create_check_constraint(
        "ck_podcast_subscriptions_default_playback_speed_range",
        "podcast_subscriptions",
        "default_playback_speed IS NULL OR (default_playback_speed >= 0.5 AND default_playback_speed <= 3.0)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_podcast_subscriptions_default_playback_speed_range",
        "podcast_subscriptions",
        type_="check",
    )
    op.drop_column("podcast_subscriptions", "default_playback_speed")
