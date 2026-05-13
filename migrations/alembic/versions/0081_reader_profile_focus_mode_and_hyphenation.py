"""Reader profile focus mode enum and hyphenation hard cutover.

Revision ID: 0081
Revises: 0080
Create Date: 2026-05-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0081"
down_revision: str | None = "0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Convert focus_mode boolean to enum text and add hyphenation column."""

    op.add_column(
        "reader_profiles",
        sa.Column(
            "focus_mode_text",
            sa.Text(),
            nullable=False,
            server_default="off",
        ),
    )
    op.execute(
        """
        UPDATE reader_profiles
        SET focus_mode_text = CASE
            WHEN focus_mode THEN 'distraction_free'
            ELSE 'off'
        END
        """
    )
    op.drop_column("reader_profiles", "focus_mode")
    op.alter_column(
        "reader_profiles",
        "focus_mode_text",
        new_column_name="focus_mode",
    )
    op.create_check_constraint(
        "ck_reader_profiles_focus_mode",
        "reader_profiles",
        "focus_mode IN ('off', 'distraction_free', 'paragraph', 'sentence')",
    )

    op.add_column(
        "reader_profiles",
        sa.Column(
            "hyphenation",
            sa.Text(),
            nullable=False,
            server_default="auto",
        ),
    )
    op.create_check_constraint(
        "ck_reader_profiles_hyphenation",
        "reader_profiles",
        "hyphenation IN ('auto', 'off')",
    )


def downgrade() -> None:
    """Revert focus_mode to boolean and drop hyphenation column."""

    op.drop_constraint("ck_reader_profiles_hyphenation", "reader_profiles", type_="check")
    op.drop_column("reader_profiles", "hyphenation")

    op.drop_constraint("ck_reader_profiles_focus_mode", "reader_profiles", type_="check")
    op.add_column(
        "reader_profiles",
        sa.Column(
            "focus_mode_bool",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.execute(
        """
        UPDATE reader_profiles
        SET focus_mode_bool = CASE
            WHEN focus_mode = 'off' THEN false
            ELSE true
        END
        """
    )
    op.drop_column("reader_profiles", "focus_mode")
    op.alter_column(
        "reader_profiles",
        "focus_mode_bool",
        new_column_name="focus_mode",
    )
