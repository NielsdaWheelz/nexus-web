"""Hard-cut canonical playback-rate policy and owned absence.

Revision ID: 0204
Revises: 0203
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0204"
down_revision: str | Sequence[str] | None = "0203"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "podcast_listening_states",
        "playback_speed",
        existing_type=sa.Float(),
        nullable=True,
        server_default=None,
    )
    op.execute(
        """
        UPDATE podcast_listening_states
        SET playback_speed = NULL
        WHERE position_ms = 0
          AND duration_ms IS NULL
          AND playback_speed = 1
          AND is_completed IS TRUE
          AND write_revision = 0
          AND reset_epoch = 0
          AND last_engaged_at IS NULL
        """
    )
    op.execute(
        """
        UPDATE podcast_listening_states
        SET playback_speed = LEAST(3.0, GREATEST(0.5, playback_speed))
        WHERE playback_speed IS NOT NULL
          AND (playback_speed < 0.5 OR playback_speed > 3.0)
        """
    )
    op.drop_constraint(
        "ck_podcast_listening_states_playback_speed_positive",
        "podcast_listening_states",
        type_="check",
    )
    op.drop_constraint(
        "ck_podcast_subscriptions_default_playback_speed_range",
        "podcast_subscriptions",
        type_="check",
    )


def downgrade() -> None:
    raise RuntimeError(
        "0204 is a hard cutover migration; nullable episode playback rate has no downgrade path"
    )
