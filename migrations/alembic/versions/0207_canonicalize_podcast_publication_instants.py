"""Canonicalize persisted Podcast publication instants.

Revision ID: 0207
Revises: 0206
Create Date: 2026-07-31
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0207"
down_revision: str | Sequence[str] | None = "0206"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_PODCAST_INSTANT_PATTERN = (
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2} "
    r"[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"([.][0-9]{1,6})?([+-][0-9]{2}:[0-9]{2})?$"
)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE media
            SET published_date =
                CASE
                    WHEN published_date ~ '[+-][0-9]{2}:[0-9]{2}$'
                    THEN replace(
                        (published_date::timestamptz AT TIME ZONE 'UTC')::text,
                        ' ',
                        'T'
                    ) || 'Z'
                    ELSE replace(published_date::timestamp::text, ' ', 'T') || 'Z'
                END
            WHERE kind = 'podcast_episode'
              AND published_date ~ :legacy_pattern
            """
        ),
        {"legacy_pattern": _LEGACY_PODCAST_INSTANT_PATTERN},
    )

    remaining = bind.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM media
            WHERE kind = 'podcast_episode'
              AND published_date ~ :legacy_pattern
            """
        ),
        {"legacy_pattern": _LEGACY_PODCAST_INSTANT_PATTERN},
    )
    if remaining != 0:
        raise RuntimeError("0207 failed to canonicalize every legacy Podcast publication instant")


def downgrade() -> None:
    raise RuntimeError("0207 is a hard cutover migration and has no downgrade path")
