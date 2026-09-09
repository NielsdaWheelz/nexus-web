"""Require drained generation work before the shared kernel contract cutover.

Revision ID: 0225
Revises: 0224
"""

from alembic import op
from sqlalchemy import text

revision = "0225"
down_revision = "0224"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    # Deployment stops admissions and workers before migrating. These locks
    # make the drain check and version change one atomic database boundary.
    connection.execute(
        text("LOCK TABLE chat_runs, llm_calls, background_jobs IN EXCLUSIVE MODE")
    )
    pending = connection.execute(
        text(
            """
            SELECT owner, id FROM (
                SELECT 'chat_run' AS owner, id FROM chat_runs
                WHERE status IN ('queued', 'running')
                UNION ALL
                SELECT 'generation' AS owner, id FROM llm_calls
                WHERE completed_at IS NULL
                UNION ALL
                SELECT 'generation_job' AS owner, id FROM background_jobs
                WHERE status IN ('pending', 'running', 'failed')
                  AND kind IN (
                    'enrich_metadata', 'chat_run', 'dossier_build',
                    'oracle_reading_generate', 'media_unit_build',
                    'synapse_scan', 'dawn_write_job'
                  )
            ) AS active ORDER BY owner, id LIMIT 1
            """
        )
    ).first()
    if pending is not None:
        raise RuntimeError(
            "Shared agent kernel cutover requires drained generation work; "
            f"resolve or explicitly abandon {pending.owner} {pending.id} first. "
            "Historical records and unknown effects have not been modified."
        )


def downgrade() -> None:
    raise RuntimeError(
        "Shared kernel tool authority is a forward-only contract cutover"
    )
