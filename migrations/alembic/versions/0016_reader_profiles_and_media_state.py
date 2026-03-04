"""Reader profiles and per-media reader state

Revision ID: 0016
Revises: 0015
Create Date: 2026-03-04

Adds durable reader profile (per-user defaults) and reader_media_state
(per user + media overrides and progress). Supports production reading UX:
theme, font settings, focus mode, view mode, and typed progress locators.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ==========================================================================
    # reader_profiles table (per-user defaults)
    # ==========================================================================
    op.create_table(
        "reader_profiles",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("theme", sa.Text(), nullable=False, server_default="light"),
        sa.Column("font_size_px", sa.Integer(), nullable=False, server_default="16"),
        sa.Column("line_height", sa.Numeric(3, 2), nullable=False, server_default="1.5"),
        sa.Column("font_family", sa.Text(), nullable=False, server_default="serif"),
        sa.Column("column_width_ch", sa.Integer(), nullable=False, server_default="65"),
        sa.Column("focus_mode", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id"),
        sa.CheckConstraint(
            "theme IN ('light', 'dark', 'sepia')",
            name="ck_reader_profiles_theme",
        ),
        sa.CheckConstraint(
            "font_size_px BETWEEN 12 AND 28",
            name="ck_reader_profiles_font_size_px",
        ),
        sa.CheckConstraint(
            "line_height BETWEEN 1.2 AND 2.2",
            name="ck_reader_profiles_line_height",
        ),
        sa.CheckConstraint(
            "font_family IN ('serif', 'sans')",
            name="ck_reader_profiles_font_family",
        ),
        sa.CheckConstraint(
            "column_width_ch BETWEEN 40 AND 120",
            name="ck_reader_profiles_column_width_ch",
        ),
    )

    # ==========================================================================
    # reader_media_state table (per user + media)
    # ==========================================================================
    op.create_table(
        "reader_media_state",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("theme", sa.Text(), nullable=True),
        sa.Column("font_size_px", sa.Integer(), nullable=True),
        sa.Column("line_height", sa.Numeric(3, 2), nullable=True),
        sa.Column("font_family", sa.Text(), nullable=True),
        sa.Column("column_width_ch", sa.Integer(), nullable=True),
        sa.Column("focus_mode", sa.Boolean(), nullable=True),
        sa.Column("view_mode", sa.Text(), nullable=False, server_default="scroll"),
        sa.Column("locator_kind", sa.Text(), nullable=True),
        sa.Column("fragment_id", sa.UUID(), nullable=True),
        sa.Column("offset", sa.Integer(), nullable=True),
        sa.Column("section_id", sa.Text(), nullable=True),
        sa.Column("page", sa.Integer(), nullable=True),
        sa.Column("zoom", sa.Numeric(5, 2), nullable=True),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["fragment_id"],
            ["fragments.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("user_id", "media_id"),
        sa.CheckConstraint(
            "theme IS NULL OR theme IN ('light', 'dark', 'sepia')",
            name="ck_reader_media_state_theme",
        ),
        sa.CheckConstraint(
            "font_size_px IS NULL OR (font_size_px BETWEEN 12 AND 28)",
            name="ck_reader_media_state_font_size_px",
        ),
        sa.CheckConstraint(
            "line_height IS NULL OR (line_height BETWEEN 1.2 AND 2.2)",
            name="ck_reader_media_state_line_height",
        ),
        sa.CheckConstraint(
            "font_family IS NULL OR font_family IN ('serif', 'sans')",
            name="ck_reader_media_state_font_family",
        ),
        sa.CheckConstraint(
            "column_width_ch IS NULL OR (column_width_ch BETWEEN 40 AND 120)",
            name="ck_reader_media_state_column_width_ch",
        ),
        sa.CheckConstraint(
            "view_mode IN ('scroll', 'paged')",
            name="ck_reader_media_state_view_mode",
        ),
        sa.CheckConstraint(
            "locator_kind IS NULL OR locator_kind IN ('fragment_offset', 'epub_section', 'pdf_page')",
            name="ck_reader_media_state_locator_kind",
        ),
        sa.CheckConstraint(
            '"offset" IS NULL OR "offset" >= 0',
            name="ck_reader_media_state_offset",
        ),
        sa.CheckConstraint(
            "page IS NULL OR page >= 1",
            name="ck_reader_media_state_page",
        ),
        sa.CheckConstraint(
            "zoom IS NULL OR (zoom BETWEEN 0.25 AND 4.0)",
            name="ck_reader_media_state_zoom",
        ),
    )

    op.create_index(
        "idx_reader_media_state_media",
        "reader_media_state",
        ["media_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_reader_media_state_media", table_name="reader_media_state")
    op.drop_table("reader_media_state")
    op.drop_table("reader_profiles")
