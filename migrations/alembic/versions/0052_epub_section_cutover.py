"""EPUB section cutover for persisted navigation sources.

Revision ID: 0052
Revises: 0051
Create Date: 2026-04-20
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0052"
down_revision: str | None = "0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_epub_nav_locations_source_valid",
        "epub_nav_locations",
        type_="check",
    )
    op.execute(
        """
        UPDATE epub_nav_locations
        SET source = 'spine'
        WHERE source = 'fragment_fallback'
        """
    )
    op.create_check_constraint(
        "ck_epub_nav_locations_source_valid",
        "epub_nav_locations",
        "source IN ('toc', 'spine')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_epub_nav_locations_source_valid",
        "epub_nav_locations",
        type_="check",
    )
    op.execute(
        """
        UPDATE epub_nav_locations
        SET source = 'fragment_fallback'
        WHERE source = 'spine'
        """
    )
    op.create_check_constraint(
        "ck_epub_nav_locations_source_valid",
        "epub_nav_locations",
        "source IN ('toc', 'fragment_fallback')",
    )
