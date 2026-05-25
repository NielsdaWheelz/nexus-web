"""Add podcast subscription libraries join table.

Revision ID: 0111
Revises: 0110
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0111"
down_revision: str | None = "0110"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_subscription_libraries",
        sa.Column(
            "subscription_user_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "subscription_podcast_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "library_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["subscription_user_id", "subscription_podcast_id"],
            ["podcast_subscriptions.user_id", "podcast_subscriptions.podcast_id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["library_id"],
            ["libraries.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "subscription_user_id",
            "subscription_podcast_id",
            "library_id",
            name="pk_podcast_subscription_libraries",
        ),
    )
    op.create_index(
        "ix_podcast_subscription_libraries_library_id",
        "podcast_subscription_libraries",
        ["library_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_podcast_subscription_libraries_library_id",
        table_name="podcast_subscription_libraries",
    )
    op.drop_table("podcast_subscription_libraries")
