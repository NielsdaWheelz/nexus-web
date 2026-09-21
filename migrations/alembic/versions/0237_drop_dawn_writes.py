"""Delete Dawn Write: drop the `dawn_writes` table, its retired queue rows, and
the generation ledger rows owned by the `dawn_write` operation.

Revision ID: 0237
Revises: 0236
Create Date: 2026-09-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0237"
down_revision: str | Sequence[str] | None = "0236"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DAWN_GENERATIONS = "SELECT id FROM llm_calls WHERE owner_kind = 'dawn_write'"


def _delete_generation_ledger() -> None:
    op.execute(
        f"DELETE FROM llm_model_turn_continuations WHERE generation_id IN ({_DAWN_GENERATIONS})"
    )
    op.execute(f"DELETE FROM llm_tool_positions WHERE generation_id IN ({_DAWN_GENERATIONS})")
    op.execute(f"DELETE FROM llm_model_turns WHERE generation_id IN ({_DAWN_GENERATIONS})")
    op.execute("DELETE FROM llm_calls WHERE owner_kind = 'dawn_write'")


def _delete_queue_rows() -> None:
    op.execute(
        "UPDATE background_job_capacity_leases "
        "SET job_id = NULL, worker_id = NULL, attempt_no = NULL, "
        "lease_expires_at = NULL, updated_at = now() "
        "WHERE job_id IN (SELECT id FROM background_jobs WHERE kind = 'dawn_write_job')"
    )
    op.execute("DELETE FROM background_jobs WHERE kind = 'dawn_write_job'")


def upgrade() -> None:
    _delete_generation_ledger()
    _delete_queue_rows()
    op.drop_table("dawn_writes")


def downgrade() -> None:
    raise NotImplementedError("0237 is an irreversible feature deletion")
