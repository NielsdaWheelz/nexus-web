"""Store canonical document word counts beside their source text.

Revision ID: 0186
Revises: 0185
Create Date: 2026-07-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0186"
down_revision: str | Sequence[str] | None = "0185"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "fragments",
        sa.Column(
            "canonical_text_word_count",
            sa.Integer(),
            sa.Computed(
                "regexp_count(canonical_text, '[^[:space:]]+')",
                persisted=True,
            ),
            nullable=False,
        ),
    )
    op.add_column(
        "media",
        sa.Column(
            "plain_text_word_count",
            sa.Integer(),
            sa.Computed(
                "regexp_count(plain_text, '[^[:space:]]+')",
                persisted=True,
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("media", "plain_text_word_count")
    op.drop_column("fragments", "canonical_text_word_count")
