"""Add metadata columns to media and create media_authors table.

Revision ID: 0019
Revises: 0018
Create Date: 2026-03-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add metadata columns to media
    op.add_column("media", sa.Column("published_date", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("publisher", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("language", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("description", sa.Text(), nullable=True))
    op.add_column(
        "media",
        sa.Column(
            "metadata_enriched_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
        ),
    )

    # Create media_authors table
    op.create_table(
        "media_authors",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            primary_key=True,
        ),
        sa.Column(
            "media_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_index("ix_media_authors_media_id", "media_authors", ["media_id"])

    # Unique index on (media_id, name, COALESCE(role, '')) to handle NULL role dedup.
    # Must be a unique INDEX (not a UNIQUE constraint) because Postgres constraints
    # cannot contain expressions — only indexes can.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_media_authors_media_name_role
        ON media_authors (media_id, name, COALESCE(role, ''))
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_media_authors_media_name_role")
    op.drop_index("ix_media_authors_media_id", table_name="media_authors")
    op.drop_table("media_authors")

    op.drop_column("media", "metadata_enriched_at")
    op.drop_column("media", "description")
    op.drop_column("media", "language")
    op.drop_column("media", "publisher")
    op.drop_column("media", "published_date")
