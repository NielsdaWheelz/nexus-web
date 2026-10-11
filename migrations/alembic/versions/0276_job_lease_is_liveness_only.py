"""A job claim is its execution id; a lease is liveness only.

Revision ID: 0276
Revises: 0275

1. ``background_job_capacity_leases.worker_id`` and ``attempt_no`` duplicated the
   holder's identity: the queue fences every write on the job row's ``execution_id``,
   and the Heavy lease needs only to name its job. Both columns go.
2. Leases become 30 s, renewed every 5 s; old workers renewed to as much as 1,200 s.
   The release stops every writer before this runs, so a ``running`` row is an
   abandoned attempt: its lease expires now, and the Heavy lease is freed, so the new
   workers reclaim it at once (spending that attempt, recorded E_WORKER_INTERRUPTED)
   instead of after the old lease.

Irreversible in data (lease instants); the columns held only transient values.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0276"
down_revision: str | Sequence[str] | None = "0275"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE background_job_capacity_leases DROP COLUMN worker_id, DROP COLUMN attempt_no"
    )
    op.execute(
        "UPDATE background_job_capacity_leases SET job_id = NULL, lease_expires_at = NULL,"
        " updated_at = now()"
    )
    op.execute(
        "UPDATE background_jobs SET lease_expires_at = now(), updated_at = now()"
        " WHERE status = 'running' AND lease_expires_at > now()"
    )


def downgrade() -> None:
    raise NotImplementedError("0276 is irreversible; restore the pre-release backup")
