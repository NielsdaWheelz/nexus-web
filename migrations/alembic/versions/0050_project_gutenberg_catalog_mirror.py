"""Add local Project Gutenberg catalog mirror table.

Revision ID: 0050
Revises: 0049
Create Date: 2026-04-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_gutenberg_catalog",
        sa.Column("ebook_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("gutenberg_type", sa.Text(), nullable=True),
        sa.Column("issued", sa.Date(), nullable=True),
        sa.Column("language", sa.Text(), nullable=True),
        sa.Column("authors", sa.Text(), nullable=True),
        sa.Column("subjects", sa.Text(), nullable=True),
        sa.Column("locc", sa.Text(), nullable=True),
        sa.Column("bookshelves", sa.Text(), nullable=True),
        sa.Column("copyright_status", sa.Text(), nullable=True),
        sa.Column("download_count", sa.Integer(), nullable=True),
        sa.Column(
            "raw_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "synced_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "ebook_id > 0",
            name="ck_project_gutenberg_catalog_ebook_id_positive",
        ),
        sa.PrimaryKeyConstraint("ebook_id"),
    )
    op.create_index(
        "ix_project_gutenberg_catalog_language",
        "project_gutenberg_catalog",
        ["language"],
        unique=False,
    )
    op.create_index(
        "ix_project_gutenberg_catalog_title",
        "project_gutenberg_catalog",
        ["title"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_project_gutenberg_catalog_title", table_name="project_gutenberg_catalog")
    op.drop_index("ix_project_gutenberg_catalog_language", table_name="project_gutenberg_catalog")
    op.drop_table("project_gutenberg_catalog")
