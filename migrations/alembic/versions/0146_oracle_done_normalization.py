"""oracle done normalization + create idempotency storage

Revision ID: 0146
Revises: 0145
Create Date: 2026-06-09

Generation-run harness S5 (oracle). Oracle failures now terminate with the one
normalized ``done {status, error_code}`` event, so the ``error`` event type is
retired: drop the event-type CHECK, DELETE the retired ``error`` rows (0142's
DELETE-then-tighten pattern — prod has 0 readings; dev/test DBs may carry
rows; these are streaming-log rows, the failure itself lives on
``oracle_readings.status/error_code``), then re-add the tightened 8-type CHECK.

Plus oracle create idempotency: ``oracle_readings.idempotency_key`` with a
``(user_id, idempotency_key)`` partial unique index (mirrors LI's
``uq_li_revisions_artifact_idempotency_key``); NULL keys stay unrestricted.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0146"
down_revision: str | Sequence[str] | None = "0145"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE oracle_reading_events DROP CONSTRAINT ck_oracle_reading_events_type")
    op.execute("DELETE FROM oracle_reading_events WHERE event_type = 'error'")
    op.execute("""
        ALTER TABLE oracle_reading_events
        ADD CONSTRAINT ck_oracle_reading_events_type CHECK (
            event_type IN (
                'meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', 'done'
            )
        )
    """)

    op.add_column("oracle_readings", sa.Column("idempotency_key", sa.Text(), nullable=True))
    op.execute("""
        CREATE UNIQUE INDEX uq_oracle_readings_user_idempotency_key
        ON oracle_readings (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0146 is not reversible")
