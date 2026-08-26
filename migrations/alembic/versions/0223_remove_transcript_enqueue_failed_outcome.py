"""Remove the non-atomic podcast transcript enqueue failure outcome.

Revision ID: 0223
Revises: 0222
Create Date: 2026-08-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0223"
down_revision: str | Sequence[str] | None = "0222"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "podcast_transcript_request_audits"
_OUTCOME_CONSTRAINT = "ck_podcast_transcript_request_audits_outcome"
_CANONICAL_OUTCOMES = (
    "outcome IN ('forecast', 'queued', 'idempotent', 'rejected_quota')"
)


def upgrade() -> None:
    op.execute(
        "DELETE FROM podcast_transcript_request_audits WHERE outcome = 'enqueue_failed'"
    )
    op.drop_constraint(_OUTCOME_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(_OUTCOME_CONSTRAINT, _TABLE, _CANONICAL_OUTCOMES)


def downgrade() -> None:
    raise NotImplementedError(
        "0223 is an irreversible transcript admission hard cutover"
    )
