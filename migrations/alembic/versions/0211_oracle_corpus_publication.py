"""Add the current Oracle corpus publication marker.

Revision ID: 0211
Revises: 0210
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0211"
down_revision: str | Sequence[str] | None = "0210"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oracle_corpus_publications",
        sa.Column("corpus_key", sa.Text(), primary_key=True, nullable=False),
        sa.Column("manifest_digest", sa.Text(), nullable=False),
        sa.Column("embedding_provider", sa.Text(), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0211 is a hard cutover migration and has no downgrade path"
    )
