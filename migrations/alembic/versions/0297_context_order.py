"""Separate conversation admission order from endpoint display ranks.

Revision ID: 0297
Revises: 0296

Data effects: copy each conversation user-link occurrence's existing order_key
into context_order_key. Missing/null ranks retain their existing null ordering.
Subsequent display moves cannot change admission order. Raise on malformed
numeric ranks or a conversation occurrence not incident to its owned link;
such rows cannot establish the allocator's invariant without guessing.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0297"
down_revision: str | Sequence[str] | None = "0296"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bad = op.get_bind().scalar(
        sa.text("""
        SELECT count(*) FROM resource_view_states v
        JOIN resource_edges e ON e.id = v.edge_id
        WHERE v.surface_scheme = 'conversation' AND e.origin = 'user'
          AND (v.user_id <> e.user_id
            OR NOT ((e.source_scheme = 'conversation' AND e.source_id = v.surface_id)
              OR (e.target_scheme = 'conversation' AND e.target_id = v.surface_id))
            OR (v.order_key IS NOT NULL AND v.order_key !~ '^[0-9]{1,64}$'))
    """)
    )
    if bad:
        raise RuntimeError(f"0297 cannot convert {bad} invalid conversation link ranks")
    op.add_column(
        "resource_view_states", sa.Column("context_order_key", sa.Text(), nullable=True)
    )
    op.execute("""
        UPDATE resource_view_states v SET context_order_key = v.order_key
        FROM resource_edges e
        WHERE e.id = v.edge_id AND e.origin = 'user'
          AND v.surface_scheme = 'conversation'
    """)


def downgrade() -> None:
    raise NotImplementedError("0297 is irreversible; restore the pre-release backup")
