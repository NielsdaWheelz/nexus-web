"""Reader profile created_at rename and preference-default removal.

``reader_profiles.updated_at`` was never advanced by any code path — the
service only ever set it via the column's own ``now()`` server default at
first-row creation, then never touched it again on PATCH. Keeping it named
``updated_at`` falsely implies a conflict clock the reader profile does not
have (profile writes are serialization-order last-write-wins, not
revisioned). Renaming it to ``created_at`` makes it truthful creation
metadata; it is never part of the public DTO.

The seven preference columns also lose their server defaults. The FastAPI
reader service's ``READER_PROFILE_DEFAULTS`` is now the one preference-default
authority: a missing-row GET returns it directly without inserting, and the
first PATCH explicitly seeds all seven fields from it before applying the
patch. Duplicating those defaults at the database layer let the two drift.

Revision ID: 0181
Revises: 0180
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0181"
down_revision: str | Sequence[str] | None = "0180"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("reader_profiles", "updated_at", new_column_name="created_at")

    for column_name in (
        "theme",
        "font_size_px",
        "line_height",
        "font_family",
        "column_width_ch",
        "focus_mode",
        "hyphenation",
    ):
        op.alter_column("reader_profiles", column_name, server_default=None)


def downgrade() -> None:
    op.alter_column("reader_profiles", "theme", server_default="light")
    op.alter_column("reader_profiles", "font_size_px", server_default="16")
    op.alter_column("reader_profiles", "line_height", server_default="1.5")
    op.alter_column("reader_profiles", "font_family", server_default="serif")
    op.alter_column("reader_profiles", "column_width_ch", server_default="65")
    op.alter_column("reader_profiles", "focus_mode", server_default="off")
    op.alter_column("reader_profiles", "hyphenation", server_default="auto")

    op.alter_column("reader_profiles", "created_at", new_column_name="updated_at")
