"""Cut reader profiles to global theme only and reader media state to resume only.

Revision ID: 0042
Revises: 0041
Create Date: 2026-04-14
"""

from collections.abc import Sequence

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
    raise NotImplementedError("This reader cutover is intentionally irreversible.")
