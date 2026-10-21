"""Version podcast subscription settings.

Revision ID: 0305
Revises: 0304

Data effects: every existing subscription starts at settings_version 1. Retain
subscription identities, nullable playback defaults, auto-queue watermarks and
all listening data unchanged. New subscriptions also start at 1; only settings
writes advance the version. No device-only preferences are imported.
"""

import sqlalchemy as sa
from alembic import op

revision = "0305"
down_revision = "0304"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("settings_version", sa.Integer(), server_default=sa.text("1"), nullable=False),
    )


def downgrade() -> None:
    raise NotImplementedError("0305 is irreversible; restore the pre-release backup")
