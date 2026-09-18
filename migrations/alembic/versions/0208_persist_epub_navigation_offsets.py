"""Expand EPUB navigation rows with nullable exact-offset storage.

Revision ID: 0208
Revises: 0207
Create Date: 2026-07-31
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0208"
down_revision: str | Sequence[str] | None = "0207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "epub_nav_locations",
        sa.Column("start_offset", sa.Integer(), nullable=True),
    )
    op.add_column(
        "epub_nav_locations",
        sa.Column("end_offset", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    raise RuntimeError("0208 is a hard cutover migration and has no downgrade path")
