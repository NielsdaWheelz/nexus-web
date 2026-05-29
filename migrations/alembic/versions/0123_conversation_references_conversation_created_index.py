"""Index conversation reference reads by conversation and creation time.

Revision ID: 0123
Revises: 0122
Create Date: 2026-05-29
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0123"
down_revision: str | None = "0122"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_conversation_references_conversation_created",
        "conversation_references",
        ["conversation_id", "created_at"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0123 is not reversible")
