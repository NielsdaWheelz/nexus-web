"""Add device-owned browser queues, initially empty; no lectern data is copied.

revision: 0312; parent: 0311. Existing data is unchanged. Deleting an account
cascades its device rows. Queue state is validated by its application owner; it intentionally has no media foreign keys. Downgrade
irreversibly removes saved browser queues.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0312"
down_revision: str | Sequence[str] | None = "0311"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "playback_sessions",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("device_id", sa.Text(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("state", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("user_id", "device_id", name="uq_playback_sessions_user_device"),
        sa.CheckConstraint("revision > 0", name="ck_playback_sessions_revision"),
        sa.CheckConstraint("jsonb_typeof(state) = 'object'", name="ck_playback_sessions_state"),
    )


def downgrade() -> None:
    op.drop_table("playback_sessions")
