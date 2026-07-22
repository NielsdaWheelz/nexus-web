"""Add truthful listening engagement recency and bounded recent indexes.

``podcast_listening_states.updated_at`` is mutation recency: manual Finished and
Unread commands advance it even though the user did not listen.  Preserve that
operational timestamp, add an engagement-only clock, and index both consumption
recency sources for the viewer-scoped top-N Lectern read model.

Revision ID: 0186
Revises: 0185
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0186"
down_revision: str | Sequence[str] | None = "0185"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_listening_states",
        sa.Column("last_engaged_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    # Existing rows predate the engagement-only clock. Preserve ``updated_at``
    # only when the post-fencing state proves the *latest* mutation was a
    # heartbeat. A positive position with an incomplete state cannot have come
    # from Finished/Unread; a zero-position row is safe only when at least one
    # heartbeat occurred and no reset ever did. Pre-fencing rows and completed
    # rows are deliberately left NULL: they prove at most that listening once
    # occurred, not that the operational ``updated_at`` is its timestamp.
    op.execute(
        "UPDATE podcast_listening_states"
        " SET last_engaged_at = updated_at"
        " WHERE last_engaged_at IS NULL"
        " AND write_revision > 0"
        " AND is_completed IS FALSE"
        " AND (position_ms > 0 OR reset_epoch = 0)"
    )
    op.execute(
        "CREATE INDEX ix_podcast_listening_states_user_last_engaged"
        " ON podcast_listening_states"
        " (user_id, last_engaged_at DESC, media_id DESC)"
        " WHERE last_engaged_at IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_reader_engagement_states_user_last_engaged"
        " ON reader_engagement_states"
        " (user_id, last_engaged_at DESC, media_id DESC)"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_reader_engagement_states_user_last_engaged",
        table_name="reader_engagement_states",
    )
    op.drop_index(
        "ix_podcast_listening_states_user_last_engaged",
        table_name="podcast_listening_states",
    )
    op.drop_column("podcast_listening_states", "last_engaged_at")
