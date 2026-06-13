"""Drop conversation_media.

Revision ID: 0159
Revises: 0158
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0159"
down_revision: str | Sequence[str] | None = "0158"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("conversation_media")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0159 is not reversible")
