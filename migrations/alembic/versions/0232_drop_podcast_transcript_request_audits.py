"""Drop the write-only podcast transcript request audit ledger.

Revision ID: 0232
Revises: 0231
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0232"
down_revision: str | Sequence[str] | None = "0231"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("podcast_transcript_request_audits")

    # Pre-cut podcast unsubscribe memos carry a private `_queueRevocation` key
    # that PodcastUnsubscribedOut/PodcastAlreadyUnsubscribedOut (extra="forbid")
    # would now reject on replay.
    op.execute(
        "UPDATE resource_mutations "
        "SET response_json = response_json - '_queueRevocation' "
        "WHERE response_json ? '_queueRevocation'"
    )


def downgrade() -> None:
    raise NotImplementedError("0232 is an irreversible dead-schema hard cutover")
