"""Add default view mode to reader profiles.

Revision ID: 0017
Revises: 0016
Create Date: 2026-03-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reader_profiles",
        sa.Column("default_view_mode", sa.Text(), nullable=False, server_default="scroll"),
    )
    op.create_check_constraint(
        "ck_reader_profiles_default_view_mode",
        "reader_profiles",
        "default_view_mode IN ('scroll', 'paged')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_reader_profiles_default_view_mode",
        "reader_profiles",
        type_="check",
    )
    op.drop_column("reader_profiles", "default_view_mode")
