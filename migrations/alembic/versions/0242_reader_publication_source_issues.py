"""Record source issues on the reader publication generation.

Revision ID: 0242
Revises: 0241
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0242"
down_revision: str | Sequence[str] | None = "0241"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reader_publications",
        sa.Column("source_issues", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    raise NotImplementedError("0242 is an irreversible cutover")
