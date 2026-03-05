"""Add first-class conversation titles.

Revision ID: 0020
Revises: 0019
Create Date: 2026-03-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("title", sa.Text(), nullable=False, server_default="Chat"),
    )
    op.execute(
        sa.text("""
        UPDATE conversations
        SET title = 'Chat'
        WHERE title IS NULL OR length(btrim(title)) = 0
        """)
    )
    op.create_check_constraint(
        "ck_conversations_title_not_blank",
        "conversations",
        "length(btrim(title)) > 0",
    )
    op.create_check_constraint(
        "ck_conversations_title_max_length",
        "conversations",
        "char_length(title) <= 120",
    )


def downgrade() -> None:
    op.drop_constraint("ck_conversations_title_max_length", "conversations", type_="check")
    op.drop_constraint("ck_conversations_title_not_blank", "conversations", type_="check")
    op.drop_column("conversations", "title")
