"""Listening keeps only position, duration, rate and its reset epoch; the Lectern loses source.

Revision ID: 0263
Revises: 0262

podcast_listening_states.is_completed folds into consumption_overrides: a completed episode
without an override gains `finished` (revision 1), the state the read ladder already gave it; an
existing override wins, as it did in the ladder. write_revision goes: the reset epoch is the only
listening fence, and within an epoch the last writer already won. consumption_queue_items.source
was written and never read. No constraint, index or view references the dropped columns.

downgrade() re-adds the three columns with their old defaults (false, 0, 'manual'), enough for the
previous release to run; the folded overrides stay.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0263"
down_revision: str | Sequence[str] | None = "0262"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UPGRADE = """
INSERT INTO consumption_overrides (user_id, media_id, status, revision)
SELECT user_id, media_id, 'finished', 1 FROM podcast_listening_states WHERE is_completed
ON CONFLICT (user_id, media_id) DO NOTHING;
ALTER TABLE podcast_listening_states DROP COLUMN is_completed, DROP COLUMN write_revision;
ALTER TABLE consumption_queue_items DROP COLUMN source;
"""

_DOWNGRADE = """
ALTER TABLE podcast_listening_states
    ADD COLUMN is_completed boolean DEFAULT false NOT NULL,
    ADD COLUMN write_revision integer DEFAULT 0 NOT NULL;
ALTER TABLE consumption_queue_items ADD COLUMN source text DEFAULT 'manual' NOT NULL;
"""


def upgrade() -> None:
    # Multi-statement SQL goes straight to the DBAPI cursor, as 0236 does.
    with op.get_bind().connection.cursor() as cursor:
        cursor.execute(_UPGRADE)


def downgrade() -> None:
    with op.get_bind().connection.cursor() as cursor:
        cursor.execute(_DOWNGRADE)
