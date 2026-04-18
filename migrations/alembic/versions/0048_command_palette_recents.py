"""Add command palette recents table.

Revision ID: 0048
Revises: 0047
Create Date: 2026-04-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "command_palette_recents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("href", sa.Text(), nullable=False),
        sa.Column("title_snapshot", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_used_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "href", name="uq_command_palette_recents_user_href"),
    )
    op.execute(
        """
        CREATE INDEX ix_command_palette_recents_user_last_used_at_id
        ON command_palette_recents (user_id, last_used_at DESC, id DESC)
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_command_palette_recents_user_last_used_at_id",
        table_name="command_palette_recents",
    )
    op.drop_table("command_palette_recents")
