"""Cut reader profiles to global theme only and reader media state to resume only.

Revision ID: 0042
Revises: 0041
Create Date: 2026-04-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE reader_profiles SET theme = 'light' WHERE theme NOT IN ('light', 'dark')")

    op.drop_constraint(
        "ck_reader_profiles_theme",
        "reader_profiles",
        type_="check",
    )
    op.drop_constraint(
        "ck_reader_profiles_default_view_mode",
        "reader_profiles",
        type_="check",
    )
    op.drop_column("reader_profiles", "default_view_mode")
    op.create_check_constraint(
        "ck_reader_profiles_theme",
        "reader_profiles",
        "theme IN ('light', 'dark')",
    )

    for constraint_name in (
        "ck_reader_media_state_theme",
        "ck_reader_media_state_font_size_px",
        "ck_reader_media_state_line_height",
        "ck_reader_media_state_font_family",
        "ck_reader_media_state_column_width_ch",
        "ck_reader_media_state_view_mode",
    ):
        op.drop_constraint(constraint_name, "reader_media_state", type_="check")

    for column_name in (
        "theme",
        "font_size_px",
        "line_height",
        "font_family",
        "column_width_ch",
        "focus_mode",
        "view_mode",
    ):
        op.drop_column("reader_media_state", column_name)


def downgrade() -> None:
    op.drop_constraint(
        "ck_reader_profiles_theme",
        "reader_profiles",
        type_="check",
    )
    op.add_column(
        "reader_profiles",
        sa.Column("default_view_mode", sa.Text(), nullable=False, server_default="scroll"),
    )
    op.create_check_constraint(
        "ck_reader_profiles_theme",
        "reader_profiles",
        "theme IN ('light', 'dark', 'sepia')",
    )
    op.create_check_constraint(
        "ck_reader_profiles_default_view_mode",
        "reader_profiles",
        "default_view_mode IN ('scroll', 'paged')",
    )

    op.add_column("reader_media_state", sa.Column("theme", sa.Text(), nullable=True))
    op.add_column("reader_media_state", sa.Column("font_size_px", sa.Integer(), nullable=True))
    op.add_column("reader_media_state", sa.Column("line_height", sa.Numeric(3, 2), nullable=True))
    op.add_column("reader_media_state", sa.Column("font_family", sa.Text(), nullable=True))
    op.add_column("reader_media_state", sa.Column("column_width_ch", sa.Integer(), nullable=True))
    op.add_column("reader_media_state", sa.Column("focus_mode", sa.Boolean(), nullable=True))
    op.add_column(
        "reader_media_state",
        sa.Column("view_mode", sa.Text(), nullable=False, server_default="scroll"),
    )

    op.create_check_constraint(
        "ck_reader_media_state_theme",
        "reader_media_state",
        "theme IS NULL OR theme IN ('light', 'dark', 'sepia')",
    )
    op.create_check_constraint(
        "ck_reader_media_state_font_size_px",
        "reader_media_state",
        "font_size_px IS NULL OR (font_size_px BETWEEN 12 AND 28)",
    )
    op.create_check_constraint(
        "ck_reader_media_state_line_height",
        "reader_media_state",
        "line_height IS NULL OR (line_height BETWEEN 1.2 AND 2.2)",
    )
    op.create_check_constraint(
        "ck_reader_media_state_font_family",
        "reader_media_state",
        "font_family IS NULL OR font_family IN ('serif', 'sans')",
    )
    op.create_check_constraint(
        "ck_reader_media_state_column_width_ch",
        "reader_media_state",
        "column_width_ch IS NULL OR (column_width_ch BETWEEN 40 AND 120)",
    )
    op.create_check_constraint(
        "ck_reader_media_state_view_mode",
        "reader_media_state",
        "view_mode IN ('scroll', 'paged')",
    )
