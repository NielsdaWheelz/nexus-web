"""Add 'metadata' value to failure_stage_enum.

Revision ID: 0109
Revises: 0108
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0109"
down_revision: str | None = "0108"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TYPE failure_stage_enum ADD VALUE 'metadata' BEFORE 'other'")


def downgrade() -> None:
    # PostgreSQL does not support removing values from an enum type.
    pass
