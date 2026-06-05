"""allow source attempts to outlive ingest jobs

Revision ID: 0134
Revises: 0133
Create Date: 2026-06-04

Source attempts are durable user-visible ingest records. Background jobs are
operational work items that can be pruned or reset independently, so deleting a
job must never delete or block a source-attempt record.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0134"
down_revision: str | Sequence[str] | None = "0133"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "media_source_attempts_job_id_fkey",
        "media_source_attempts",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "media_source_attempts_job_id_fkey",
        "media_source_attempts",
        "background_jobs",
        ["job_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0134 is not reversible")
