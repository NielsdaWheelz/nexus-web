"""Admit note-owned work without changing existing authored writing.

Requires drained and caught-up devices, stopped writers, and a verified backup.
Add null work metadata to canonical notes and advance format-4 replica admission
to 5. Preserve bodies, causal state, identities, source prefixes and immutable
feed records. Retired earlier replicas remain retired. Fence old feed records
at each locked account head; paired device upgrades preserve those cursors.
"""

import sqlalchemy as sa
from alembic import op

revision = "0339"
down_revision = "0338"
branch_labels = None
depends_on = None


def upgrade() -> None:
    db = op.get_bind()
    db.execute(sa.text("SELECT account_id FROM authored_heads ORDER BY account_id FOR UPDATE")).all()
    invalid = db.execute(
        sa.text(
            "SELECT account_id,ref FROM authored_resources "
            "WHERE COALESCE(state->>'kind','') NOT IN ('note','page','highlight') "
            "OR state ? 'work' ORDER BY account_id,ref LIMIT 1"
        )
    ).one_or_none()
    if invalid is not None:
        raise RuntimeError(f"0339 cannot convert authored metadata: {invalid}")
    invalid_replica = db.execute(
        sa.text(
            "SELECT account_id,replica_id,format_revision FROM authored_replicas "
            "WHERE format_revision NOT IN (1,2,3,4) ORDER BY account_id,replica_id LIMIT 1"
        )
    ).one_or_none()
    if invalid_replica is not None:
        raise RuntimeError(f"0339 unsupported authored replica: {invalid_replica}")
    op.execute(
        "UPDATE authored_resources SET state=jsonb_set(state,'{work}','null'::jsonb) "
        "WHERE state->>'kind'='note'"
    )
    op.execute("UPDATE authored_heads SET snapshot_floor_seq=head_seq")
    op.execute("UPDATE authored_replicas SET format_revision=5 WHERE format_revision=4")
    op.execute("ALTER TABLE authored_replicas ALTER COLUMN format_revision SET DEFAULT 5")


def downgrade() -> None:
    raise NotImplementedError("0339 requires restoring the verified backup and matching clients")
