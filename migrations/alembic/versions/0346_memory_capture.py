"""Capture future librarian turns through immutable pending exports.

Data effects: existing runs remain ineligible and account boundaries remain unset.
Create an empty source-owned export table without cascading foreign keys; deleting
a turn cannot delete its pending delivery. No historical conversation is imported.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0346"
down_revision = "0345"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "librarian_state", sa.Column("memory_capture_id", sa.UUID(), nullable=True)
    )
    op.add_column(
        "librarian_state",
        sa.Column("memory_capture_after_message_seq", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "librarian_state",
        sa.Column(
            "memory_next_export_seq",
            sa.BigInteger(),
            nullable=False,
            server_default="1",
        ),
    )
    op.create_check_constraint(
        "ck_librarian_memory_capture",
        "librarian_state",
        "(memory_capture_id IS NULL AND memory_capture_after_message_seq IS NULL) OR "
        "(memory_capture_id IS NOT NULL AND memory_capture_after_message_seq IS NOT NULL "
        "AND memory_capture_after_message_seq >= 0)",
    )
    op.create_check_constraint(
        "ck_librarian_memory_next_export",
        "librarian_state",
        "memory_next_export_seq > 0",
    )
    op.add_column("chat_runs", sa.Column("memory_capture_id", sa.UUID(), nullable=True))
    op.create_table(
        "memory_exports",
        sa.Column("owner_user_id", sa.UUID(), primary_key=True),
        sa.Column("capture_id", sa.UUID(), primary_key=True),
        sa.Column("export_seq", sa.BigInteger(), primary_key=True),
        sa.Column("run_id", sa.UUID(), nullable=False, unique=True),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column("payload_sha256", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("parked_code", sa.Text(), nullable=True),
        sa.CheckConstraint("export_seq > 0", name="ck_memory_export_sequence"),
    )


def downgrade() -> None:
    raise RuntimeError("0346 retains delivery evidence and cannot be downgraded")
