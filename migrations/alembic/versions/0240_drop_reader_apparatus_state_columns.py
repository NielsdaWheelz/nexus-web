"""Drop the write-only reader apparatus state columns: nothing ever read the
fingerprint, the media kind, the row counts or the diagnostics blob, and the
status/count rule the dropped CHECK enforced is enforced in python.

Revision ID: 0240
Revises: 0239
Create Date: 2026-09-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0240"
down_revision: str | Sequence[str] | None = "0239"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for constraint in (
        "ck_reader_apparatus_states_status_counts",
        "ck_reader_apparatus_states_item_count",
        "ck_reader_apparatus_states_edge_count",
        "ck_reader_apparatus_states_diagnostics",
    ):
        op.drop_constraint(constraint, "reader_apparatus_states", type_="check")
    for column in ("source_fingerprint", "media_kind", "item_count", "edge_count", "diagnostics"):
        op.drop_column("reader_apparatus_states", column)


def downgrade() -> None:
    raise NotImplementedError("0240 is an irreversible column deletion")
