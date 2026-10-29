"""Remove recent-only usage fields; preserve every ranking row and value.

Downgrade is impossible because the discarded labels and times cannot be recovered.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0327"
down_revision: str | Sequence[str] | None = "0326"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    inspector = sa.inspect(db)
    columns = {column["name"] for column in inspector.get_columns("nexus_usages")}
    expected = {
        "id",
        "user_id",
        "query_normalized",
        "target_href",
        "label_snapshot",
        "source",
        "use_count",
        "visit_timestamps",
        "last_used_at",
        "created_at",
        "updated_at",
    }
    indexes = {index["name"] for index in inspector.get_indexes("nexus_usages")}
    removed_indexes = {
        "ix_nexus_usages_user_last_used_at_id",
        "ix_nexus_usages_user_query_last_used_at",
    }
    if columns != expected or not removed_indexes <= indexes:
        raise RuntimeError("unexpected nexus_usages schema")
    for name in sorted(removed_indexes):
        op.drop_index(name, table_name="nexus_usages")
    for name in ("label_snapshot", "source", "last_used_at", "updated_at"):
        op.drop_column("nexus_usages", name)


def downgrade() -> None:
    raise RuntimeError("nexus ranking cutover discards usage labels and timestamps")
