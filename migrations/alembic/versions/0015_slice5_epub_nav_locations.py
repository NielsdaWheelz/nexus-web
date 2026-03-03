"""Slice 5 hardening — durable EPUB navigation locations

Revision ID: 0015
Revises: 0014
Create Date: 2026-03-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "epub_nav_locations",
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("location_id", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("source_node_id", sa.Text(), nullable=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("fragment_idx", sa.Integer(), nullable=False),
        sa.Column("href_path", sa.Text(), nullable=True),
        sa.Column("href_fragment", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            ondelete="CASCADE",
            name="fk_epub_nav_locations_media",
        ),
        sa.ForeignKeyConstraint(
            ["media_id", "source_node_id"],
            ["epub_toc_nodes.media_id", "epub_toc_nodes.node_id"],
            ondelete="CASCADE",
            name="fk_epub_nav_locations_toc_node",
        ),
        sa.ForeignKeyConstraint(
            ["media_id", "fragment_idx"],
            ["fragments.media_id", "fragments.idx"],
            ondelete="CASCADE",
            initially="DEFERRED",
            deferrable=True,
            name="fk_epub_nav_locations_fragment",
        ),
        sa.PrimaryKeyConstraint("media_id", "location_id"),
        sa.UniqueConstraint(
            "media_id",
            "ordinal",
            name="uix_epub_nav_locations_media_ordinal",
        ),
        sa.UniqueConstraint(
            "media_id",
            "source_node_id",
            name="uix_epub_nav_locations_media_source",
        ),
        sa.CheckConstraint(
            "char_length(location_id) BETWEEN 1 AND 255",
            name="ck_epub_nav_locations_location_id_nonempty",
        ),
        sa.CheckConstraint(
            "char_length(trim(label)) BETWEEN 1 AND 512",
            name="ck_epub_nav_locations_label_nonempty",
        ),
        sa.CheckConstraint(
            "fragment_idx >= 0",
            name="ck_epub_nav_locations_fragment_idx_nonneg",
        ),
        sa.CheckConstraint(
            "ordinal >= 0",
            name="ck_epub_nav_locations_ordinal_nonneg",
        ),
        sa.CheckConstraint(
            "source IN ('toc', 'fragment_fallback')",
            name="ck_epub_nav_locations_source_valid",
        ),
    )

    op.create_index(
        "idx_epub_nav_locations_media_fragment",
        "epub_nav_locations",
        ["media_id", "fragment_idx"],
    )


def downgrade() -> None:
    op.drop_index("idx_epub_nav_locations_media_fragment", table_name="epub_nav_locations")
    op.drop_table("epub_nav_locations")
