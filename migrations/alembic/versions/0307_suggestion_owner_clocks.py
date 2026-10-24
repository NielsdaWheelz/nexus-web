"""Replace the shared suggestion counter with stable source-owner clocks.

Revision ID: 0307
Revises: 0306

Data effects: preserve the sole legacy input row's revision and created_at
under the reserved text key baseline:legacy. Future canonical source owners get
independent rows; deleted sources leave opaque clock tombstones so the sum never
decreases. No source records or suggestion publications change. Refuse missing,
additional or negative legacy state. The old uuid is incidental, not source identity.
Stop writers for this cutover.
Restore the pre-release backup to downgrade.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0307"
down_revision: str | Sequence[str] | None = "0306"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    valid = db.scalar(
        sa.text("""
            SELECT count(*) = 1 AND bool_and(revision >= 0)
            FROM suggestion_inputs
        """),
    )
    if not valid:
        raise RuntimeError(
            "0307 requires exactly one nonnegative legacy suggestion input"
        )
    op.alter_column(
        "suggestion_inputs", "id", type_=sa.Text(), postgresql_using="id::text"
    )
    db.execute(sa.text("UPDATE suggestion_inputs SET id = 'baseline:legacy'"))


def downgrade() -> None:
    raise NotImplementedError("0307 is irreversible; restore the pre-release backup")
