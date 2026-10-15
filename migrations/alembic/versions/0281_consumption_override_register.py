"""The consumption override becomes a register; five write-only timestamps go.

Revision ID: 0281
Revises: 0280

``consumption_overrides.status`` becomes nullable: reset and the clearing of unread keep the row
and advance its revision instead of deleting it, so a revision is never reused (finish undo and
the natural-end settle carry it as their version). ``consumption_overrides.created_at``,
``reader_engagement_states.created_at``, ``reader_media_state.created_at`` and ``updated_at``
and ``podcast_listening_states.updated_at`` are dropped: nothing reads or writes them.

Data effects: no row changes; existing overrides keep their status and revision. Nothing is
refused (every row converts). Downgrade restores the pre-release backup.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0281"
down_revision: str | Sequence[str] | None = "0280"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE consumption_overrides ALTER COLUMN status DROP NOT NULL, DROP COLUMN created_at;
        ALTER TABLE reader_engagement_states DROP COLUMN created_at;
        ALTER TABLE reader_media_state DROP COLUMN created_at, DROP COLUMN updated_at;
        ALTER TABLE podcast_listening_states DROP COLUMN updated_at;
    """)


def downgrade() -> None:
    raise NotImplementedError("0281 requires restoring the pre-release database backup")
