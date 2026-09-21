"""Drop the write-only tool-position self-comparison digests.

Revision ID: 0237
Revises: 0236
Create Date: 2026-09-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0237"
down_revision: str | Sequence[str] | None = "0236"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("llm_tool_positions", "scope_digest")
    op.drop_column("llm_tool_positions", "budget_digest")


def downgrade() -> None:
    raise NotImplementedError("0237 is forward-only")
