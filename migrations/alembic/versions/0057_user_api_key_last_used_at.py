"""Add last-used tracking for BYOK provider keys.

Revision ID: 0057
Revises: 0059
Create Date: 2026-04-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0057"
down_revision: str | None = "0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE user_api_keys
        ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_api_keys DROP COLUMN IF EXISTS last_used_at")
