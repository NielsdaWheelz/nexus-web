"""Retain insertion endpoints while enforcing unordered user-link uniqueness.

Revision ID: 0299
Revises: 0298

Data effects: existing edges and their endpoint ranks are unchanged. Replace the
ordered-column unique index with unordered canonical-ref expressions so new user
links can retain their original insertion source for exact retries. Raise before
changing the index if existing reverse pairs would violate unordered uniqueness;
choosing which relationship to remove would lose user facts and link notes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0299"
down_revision: str | Sequence[str] | None = "0298"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    duplicates = op.get_bind().scalar(
        sa.text("""
        SELECT count(*) FROM (
            SELECT user_id,
                   least(source_scheme || ':' || source_id::text,
                         target_scheme || ':' || target_id::text),
                   greatest(source_scheme || ':' || source_id::text,
                            target_scheme || ':' || target_id::text)
            FROM resource_edges WHERE origin = 'user'
            GROUP BY 1, 2, 3 HAVING count(*) > 1
        ) duplicate_pairs
    """)
    )
    if duplicates:
        raise RuntimeError(
            f"0299 cannot convert {duplicates} duplicate unordered user-link pairs"
        )
    op.drop_index("uq_resource_edges_user_link_pair", table_name="resource_edges")
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_user_link_pair ON resource_edges (
            user_id,
            least(source_scheme || ':' || source_id::text,
                  target_scheme || ':' || target_id::text),
            greatest(source_scheme || ':' || source_id::text,
                     target_scheme || ':' || target_id::text)
        ) WHERE origin = 'user'
    """)


def downgrade() -> None:
    raise NotImplementedError("0299 is irreversible; restore the pre-release backup")
