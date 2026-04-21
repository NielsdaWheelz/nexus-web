"""Clear persisted reader-state rows for the resume-state contract cutover.

Revision ID: 0055
Revises: 0054
Create Date: 2026-04-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0055"
down_revision: str | None = "0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE reader_media_state
        SET locator = NULL,
            updated_at = now()
        WHERE locator IS NOT NULL
        """
    )


def downgrade() -> None:
    pass
