"""Add podcast subscription categories and category assignment.

Revision ID: 0035
Revises: 0034
Create Date: 2026-03-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_subscription_categories",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("color", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "user_id",
            "name",
            name="uq_podcast_subscription_categories_user_name",
        ),
    )
    op.create_index(
        "ix_podcast_subscription_categories_user_position",
        "podcast_subscription_categories",
        ["user_id", "position"],
    )

    op.add_column(
        "podcast_subscriptions",
        sa.Column("category_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_podcast_subscriptions_category_id",
        "podcast_subscriptions",
        "podcast_subscription_categories",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_podcast_subscriptions_user_category",
        "podcast_subscriptions",
        ["user_id", "category_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_podcast_subscriptions_user_category", table_name="podcast_subscriptions")
    op.drop_constraint(
        "fk_podcast_subscriptions_category_id",
        "podcast_subscriptions",
        type_="foreignkey",
    )
    op.drop_column("podcast_subscriptions", "category_id")

    op.drop_index(
        "ix_podcast_subscription_categories_user_position",
        table_name="podcast_subscription_categories",
    )
    op.drop_table("podcast_subscription_categories")
