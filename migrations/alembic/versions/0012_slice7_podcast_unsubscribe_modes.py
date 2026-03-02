"""Slice 7 PR-02 — podcast unsubscribe modes

Revision ID: 0012
Revises: 0011
Create Date: 2026-03-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("unsubscribe_mode", sa.Integer(), server_default="1", nullable=False),
    )
    op.create_check_constraint(
        "ck_podcast_subscriptions_unsubscribe_mode_valid",
        "podcast_subscriptions",
        "unsubscribe_mode IN (1, 2, 3)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_podcast_subscriptions_unsubscribe_mode_valid",
        "podcast_subscriptions",
        type_="check",
    )
    op.drop_column("podcast_subscriptions", "unsubscribe_mode")
