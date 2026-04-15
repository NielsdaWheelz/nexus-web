"""Add unique X media provider identity index.

Revision ID: 0044
Revises: 0043
Create Date: 2026-04-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "uix_media_x_provider_id",
        "media",
        ["provider", "provider_id"],
        unique=True,
        postgresql_where=sa.text("provider = 'x' AND provider_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uix_media_x_provider_id", table_name="media")
