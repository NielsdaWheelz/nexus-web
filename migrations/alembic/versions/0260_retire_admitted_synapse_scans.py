"""Retire synapse scans that a previous release already admitted.

Their frozen admission input (synapse-input.v1) and terminal memo predate the
rewritten scan and cannot replay. Unfinished rows go; the next trigger queues a
fresh scan, and existing synapse edges and suppressions are untouched. Finished
rows stay: the status read only needs their status and result. Irreversible.

Revision ID: 0260
Revises: 0259
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0260"
down_revision: str | Sequence[str] | None = "0259"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "DELETE FROM background_jobs WHERE kind = 'synapse_scan'"
        " AND status IN ('pending', 'running', 'failed')"
        " AND payload ? 'generation_admissions'"
    )


def downgrade() -> None:
    raise NotImplementedError("0260 is an irreversible retirement of admitted synapse scans")
