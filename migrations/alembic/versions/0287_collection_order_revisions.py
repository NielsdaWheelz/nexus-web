"""Fence library and lectern order with nonreused aggregate revisions.

Revision ID: 0287
Revises: 0286

Existing positions and membership stay intact. Stopped writers are required by
the normal migration boundary; every future structural writer uses the fence.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0287"
down_revision: str | Sequence[str] | None = "0286"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE SEQUENCE collection_order_revision_seq
        AS bigint START WITH 1 INCREMENT BY 1 CACHE 1 NO CYCLE OWNED BY NONE
    """)
    op.execute("""
        ALTER TABLE users ADD COLUMN lectern_order_revision bigint NOT NULL
        DEFAULT nextval('collection_order_revision_seq')
    """)
    op.execute("""
        ALTER TABLE libraries ADD COLUMN order_revision bigint NOT NULL
        DEFAULT nextval('collection_order_revision_seq')
    """)


def downgrade() -> None:
    raise NotImplementedError("0287 is irreversible; restore the pre-release backup")
