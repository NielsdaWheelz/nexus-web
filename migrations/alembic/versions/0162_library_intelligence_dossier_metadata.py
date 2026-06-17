"""Add Library Intelligence dossier instruction metadata.

Revision ID: 0162
Revises: 0161
Create Date: 2026-06-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0162"
down_revision: str | Sequence[str] | None = "0161"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "library_intelligence_artifact_revisions",
        sa.Column("custom_instruction", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0162 is not reversible")
