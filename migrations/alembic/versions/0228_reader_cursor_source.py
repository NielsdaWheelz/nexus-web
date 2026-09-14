"""Retain reader cursor provenance without inventing historical generations.

Revision ID: 0228
Revises: 0227
Create Date: 2026-09-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0228"
down_revision: str | Sequence[str] | None = "0227"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reader_media_state", sa.Column("source", postgresql.JSONB(), nullable=True)
    )
    op.execute(
        """
        UPDATE reader_media_state
        SET source = CASE WHEN locator->>'kind' = 'transcript'
            THEN '{"kind":"Timeline"}'::jsonb
            ELSE '{"kind":"Unresolved"}'::jsonb END
        WHERE locator IS NOT NULL
        """
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0228 preserves cursor provenance and has no destructive downgrade"
    )
