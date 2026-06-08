"""page reindex: at-most-one-in-flight-per-page dedupe index

Revision ID: 0144
Revises: 0143
Create Date: 2026-06-07

A note/page edit enqueues a debounced page_reindex_job. We want rapid edits to
coalesce onto the already-queued/running job, but an edit after that job reaches a
terminal state MUST enqueue a fresh job (otherwise the edit is silently never
indexed). The global idx_background_jobs_dedupe_key_unique index covers ALL statuses
and is load-bearing for the periodic scheduler's run-once-per-slot semantics, so it
cannot be made in-flight-only. Instead, scope the in-flight invariant to page reindex
jobs with a partial unique index on the payload's page_id, restricted to non-terminal
rows. The enqueue path inserts under a SAVEPOINT and treats a violation as "already
covered" (services/note_indexing.enqueue_page_reindex).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0144"
down_revision: str | Sequence[str] | None = "0143"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "uq_page_reindex_job_inflight",
        "background_jobs",
        [sa.text("(payload->>'page_id')")],
        unique=True,
        postgresql_where=sa.text(
            "kind = 'page_reindex_job' AND status NOT IN ('succeeded', 'dead')"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_page_reindex_job_inflight", table_name="background_jobs")
