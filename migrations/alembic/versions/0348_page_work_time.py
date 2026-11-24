"""Add unknown work time to old authored pages and advance replication to format 7.

Requires drained devices, stopped writers and a verified backup. Preserves page
merge bytes, causal vectors, accepted source prefixes and immutable feed records.
The old feed ends at the locked head; device upgrades rebuild from a snapshot.
"""

import sqlalchemy as sa
from alembic import op

revision = "0348"
down_revision = "0347"
branch_labels = None
depends_on = None


def upgrade() -> None:
    db = op.get_bind()
    db.execute(sa.text("SELECT account_id FROM authored_heads ORDER BY account_id FOR UPDATE")).all()
    invalid = db.execute(
        sa.text(
            "SELECT account_id,ref FROM authored_resources "
            "WHERE COALESCE(state->>'kind','') NOT IN ('note','page','highlight') "
            "OR state ? 'last_work_at_ms' "
            "OR (state->>'kind'='page' AND ("
            "state->>'ref' IS DISTINCT FROM ref OR merge_bytes IS NULL "
            "OR COALESCE(jsonb_typeof(state->'local_date'),'') NOT IN ('null','string') "
            "OR jsonb_typeof(state->'touch_vv') IS DISTINCT FROM 'object' "
            "OR jsonb_typeof(state->'delete_vv') IS DISTINCT FROM 'object')) "
            "ORDER BY account_id,ref LIMIT 1"
        )
    ).one_or_none()
    if invalid is not None:
        raise RuntimeError(f"0348 cannot convert authored metadata: {invalid}")
    invalid_replica = db.execute(
        sa.text(
            "SELECT account_id,replica_id,format_revision FROM authored_replicas "
            "WHERE format_revision NOT IN (1,2,3,4,5,6) ORDER BY account_id,replica_id LIMIT 1"
        )
    ).one_or_none()
    if invalid_replica is not None:
        raise RuntimeError(f"0348 unsupported authored replica: {invalid_replica}")
    op.execute(
        "UPDATE authored_resources SET state=jsonb_set(state,'{last_work_at_ms}','null'::jsonb) "
        "WHERE state->>'kind'='page'"
    )
    op.execute("UPDATE authored_heads SET snapshot_floor_seq=head_seq")
    op.execute("UPDATE authored_replicas SET format_revision=7 WHERE format_revision=6")
    op.execute("ALTER TABLE authored_replicas ALTER COLUMN format_revision SET DEFAULT 7")


def downgrade() -> None:
    raise NotImplementedError("0348 requires restoring the verified backup and matching clients")
