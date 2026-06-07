"""contributor sort_name invariant and directory index

Revision ID: 0137
Revises: 0136
Create Date: 2026-06-05

Make contributors.sort_name a NOT NULL invariant (backfilled from display_name) and add the
(sort_name, id) composite index that powers the Authors directory's A-Z keyset cursor.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0137"
down_revision: str | Sequence[str] | None = "0136"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE contributors SET sort_name = display_name WHERE sort_name IS NULL")
    op.execute("ALTER TABLE contributors ALTER COLUMN sort_name SET NOT NULL")
    op.execute("CREATE INDEX ix_contributors_sort_name ON contributors (sort_name, id)")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0137 is not reversible")
