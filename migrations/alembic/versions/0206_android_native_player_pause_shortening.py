"""Add subscription pause shortening and Consumption override fencing.

Revision ID: 0206
Revises: 0205
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0206"
down_revision: str | Sequence[str] | None = "0205"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("pause_shortening_mode", sa.Text(), nullable=True),
    )
    op.add_column(
        "consumption_overrides",
        sa.Column(
            "revision",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    raise RuntimeError("0206 is a hard cutover migration and has no downgrade path")
