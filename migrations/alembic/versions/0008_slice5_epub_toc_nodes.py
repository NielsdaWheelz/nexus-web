"""Slice 5: EPUB TOC nodes schema

Revision ID: 0008
Revises: 0007
Create Date: 2026-02-20

S5 PR-01: Land S5 contract primitives — epub_toc_nodes storage and
error surface registration.

Creates table:
  - epub_toc_nodes (persisted TOC snapshot for EPUB media)

Adds indexes:
  - uix_epub_toc_nodes_media_order (unique on media_id, order_key)
  - idx_epub_toc_nodes_media_fragment (media_id, fragment_idx)
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "epub_toc_nodes",
        sa.Column(
            "media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column("node_id", sa.Text(), nullable=False, primary_key=True),
        sa.Column("parent_node_id", sa.Text(), nullable=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("href", sa.Text(), nullable=True),
        sa.Column("fragment_idx", sa.Integer(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("order_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # Check constraints
        sa.CheckConstraint(
            "char_length(node_id) BETWEEN 1 AND 255",
            name="ck_epub_toc_nodes_node_id_nonempty",
        ),
        sa.CheckConstraint(
            "parent_node_id IS NULL OR parent_node_id <> node_id",
            name="ck_epub_toc_nodes_parent_nonself",
        ),
        sa.CheckConstraint(
            "char_length(trim(label)) BETWEEN 1 AND 512",
            name="ck_epub_toc_nodes_label_nonempty",
        ),
        sa.CheckConstraint(
            "depth >= 0 AND depth <= 16",
            name="ck_epub_toc_nodes_depth_range",
        ),
        sa.CheckConstraint(
            "fragment_idx IS NULL OR fragment_idx >= 0",
            name="ck_epub_toc_nodes_fragment_idx_nonneg",
        ),
        sa.CheckConstraint(
            r"order_key ~ '^[0-9]{4}([.][0-9]{4})*$'",
            name="ck_epub_toc_nodes_order_key_format",
        ),
        # Self-referential FK for parent hierarchy
        sa.ForeignKeyConstraint(
            ["media_id", "parent_node_id"],
            ["epub_toc_nodes.media_id", "epub_toc_nodes.node_id"],
            name="fk_epub_toc_nodes_parent",
            ondelete="CASCADE",
        ),
        # FK to fragments (media_id, fragment_idx) — deferrable for bulk insert
        sa.ForeignKeyConstraint(
            ["media_id", "fragment_idx"],
            ["fragments.media_id", "fragments.idx"],
            name="fk_epub_toc_nodes_fragment",
            ondelete="CASCADE",
            initially="DEFERRED",
            deferrable=True,
        ),
    )

    op.create_index(
        "uix_epub_toc_nodes_media_order",
        "epub_toc_nodes",
        ["media_id", "order_key"],
        unique=True,
    )
    op.create_index(
        "idx_epub_toc_nodes_media_fragment",
        "epub_toc_nodes",
        ["media_id", "fragment_idx"],
    )


def downgrade() -> None:
    op.drop_index("idx_epub_toc_nodes_media_fragment", table_name="epub_toc_nodes")
    op.drop_index("uix_epub_toc_nodes_media_order", table_name="epub_toc_nodes")
    op.drop_table("epub_toc_nodes")
