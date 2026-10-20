"""Start page/note inactivity grace at this cutover.

Revision ID: 0298
Revises: 0297

Data effects: every existing page and note starts a fresh seven-day grace period.
Historical relationship activity cannot be reconstructed. Body, title and ordering
are unchanged. Future creations use the database wall clock.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0298"
down_revision: str | Sequence[str] | None = "0297"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table in ("pages", "note_blocks"):
        op.add_column(
            table,
            sa.Column("last_activity_at", sa.TIMESTAMP(timezone=True), nullable=True),
        )
    op.execute("UPDATE pages SET last_activity_at = transaction_timestamp()")
    op.execute("UPDATE note_blocks SET last_activity_at = transaction_timestamp()")
    for table in ("pages", "note_blocks"):
        op.alter_column(
            table,
            "last_activity_at",
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        )


def downgrade() -> None:
    raise NotImplementedError("0298 is irreversible; restore the pre-release backup")
