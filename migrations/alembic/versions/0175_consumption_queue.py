"""Consumption queue: rename playback_queue_items and widen for all media kinds.

The queue table has never restricted media kind at the FK; the widening to hold
web articles, epubs, and PDFs alongside podcast episodes and video is a rename +
source-CHECK widen only (no data migration, no backfill). The ``assistant``
source is added now (amanuensis writes it later; kept here to avoid a split
schema — see lectern §5.1/§D-8).

Revision ID: 0175
Revises: 0174
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0175"
down_revision: str | Sequence[str] | None = "0174"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE playback_queue_items RENAME TO consumption_queue_items")
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "RENAME CONSTRAINT uq_playback_queue_items_user_media "
        "TO uq_consumption_queue_items_user_media"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "RENAME CONSTRAINT ck_playback_queue_items_position_non_negative "
        "TO ck_consumption_queue_items_position_non_negative"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items DROP CONSTRAINT ck_playback_queue_items_source"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "ADD CONSTRAINT ck_consumption_queue_items_source "
        "CHECK (source IN ('manual', 'auto_subscription', 'auto_playlist', 'assistant'))"
    )
    op.execute(
        "ALTER INDEX ix_playback_queue_items_user_position "
        "RENAME TO ix_consumption_queue_items_user_position"
    )


def downgrade() -> None:
    # No 'assistant' rows exist at downgrade time in any test run; the narrowed
    # CHECK re-add is safe.
    op.execute(
        "ALTER INDEX ix_consumption_queue_items_user_position "
        "RENAME TO ix_playback_queue_items_user_position"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items DROP CONSTRAINT ck_consumption_queue_items_source"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "ADD CONSTRAINT ck_playback_queue_items_source "
        "CHECK (source IN ('manual', 'auto_subscription', 'auto_playlist'))"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "RENAME CONSTRAINT ck_consumption_queue_items_position_non_negative "
        "TO ck_playback_queue_items_position_non_negative"
    )
    op.execute(
        "ALTER TABLE consumption_queue_items "
        "RENAME CONSTRAINT uq_consumption_queue_items_user_media "
        "TO uq_playback_queue_items_user_media"
    )
    op.execute("ALTER TABLE consumption_queue_items RENAME TO playback_queue_items")
