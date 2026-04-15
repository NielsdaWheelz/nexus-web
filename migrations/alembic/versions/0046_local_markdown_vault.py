"""Add local Markdown vault pages and PDF text anchors.

Revision ID: 0046
Revises: 0045
Create Date: 2026-04-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(title) BETWEEN 1 AND 200",
            name="ck_pages_title_length",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )

    op.drop_constraint("ck_highlights_anchor_kind_valid", "highlights", type_="check")
    op.create_check_constraint(
        "ck_highlights_anchor_kind_valid",
        "highlights",
        "anchor_kind IS NULL OR anchor_kind IN "
        "('fragment_offsets', 'pdf_page_geometry', 'pdf_text_quote')",
    )

    op.create_table(
        "highlight_pdf_text_anchors",
        sa.Column(
            "highlight_id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("plain_text_start_offset", sa.Integer(), nullable=False),
        sa.Column("plain_text_end_offset", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("page_number >= 1", name="ck_hpta_page_number"),
        sa.CheckConstraint(
            "plain_text_start_offset >= 0 "
            "AND plain_text_end_offset > plain_text_start_offset",
            name="ck_hpta_offsets_valid",
        ),
        sa.ForeignKeyConstraint(["highlight_id"], ["highlights.id"]),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
    )


def downgrade() -> None:
    op.drop_table("highlight_pdf_text_anchors")
    op.drop_constraint("ck_highlights_anchor_kind_valid", "highlights", type_="check")
    op.create_check_constraint(
        "ck_highlights_anchor_kind_valid",
        "highlights",
        "anchor_kind IS NULL OR anchor_kind IN ('fragment_offsets', 'pdf_page_geometry')",
    )
    op.drop_table("pages")
