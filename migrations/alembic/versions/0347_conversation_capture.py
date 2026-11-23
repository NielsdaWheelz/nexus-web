"""Cut the drained librarian outbox to conversation-only exports.

Retain source identity, sequence counters and all canonical rows. A pending export
or unsettled capture-eligible run holds this stopped-writer migration.
"""

import sqlalchemy as sa
from alembic import op

revision = "0347"
down_revision = "0346"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text("LOCK TABLE chat_runs, memory_exports IN SHARE ROW EXCLUSIVE MODE")
    )
    if connection.scalar(
        sa.text(
            "SELECT EXISTS (SELECT FROM chat_runs WHERE memory_capture_id IS NOT NULL "
            "AND status NOT IN ('complete', 'error', 'cancelled'))"
        )
    ):
        raise RuntimeError(
            "settle all admitted nexus runs before the memory capture cut"
        )
    if connection.scalar(sa.text("SELECT EXISTS (SELECT FROM memory_exports)")):
        raise RuntimeError(
            "acknowledge all nexus memory exports before the capture cut"
        )
    op.create_check_constraint(
        "ck_memory_export_contract_revision",
        "memory_exports",
        "payload->>'contract_revision' IS NOT DISTINCT FROM 'nexus-turn-capture-v2'",
    )


def downgrade() -> None:
    raise RuntimeError("the conversation-only capture cut requires forward repair")
