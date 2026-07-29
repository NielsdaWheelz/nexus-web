"""Add durable viewer collection revisions.

Revision ID: 0200
Revises: 0199
Create Date: 2026-07-29
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0200"
down_revision: str | Sequence[str] | None = "0199"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE viewer_collection_revisions (
            viewer_id uuid NOT NULL REFERENCES users(id),
            family text NOT NULL,
            revision bigint NOT NULL,
            PRIMARY KEY (viewer_id, family)
        )
        """
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0200 is not reversible")
