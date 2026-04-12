"""Add immutable context snapshot payload to messages.

Revision ID: 0040
Revises: 0039
Create Date: 2026-04-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "context_items",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.execute("UPDATE messages SET context_items = '[]'::jsonb WHERE context_items IS NULL")
    op.alter_column("messages", "context_items", nullable=False)


def downgrade() -> None:
    op.drop_column("messages", "context_items")
