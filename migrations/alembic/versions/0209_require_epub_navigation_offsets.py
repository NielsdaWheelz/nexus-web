"""Require validated EPUB navigation offsets after projection repair.

Revision ID: 0209
Revises: 0208
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0209"
down_revision: str | Sequence[str] | None = "0208"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    op.execute("LOCK TABLE epub_nav_locations IN ACCESS EXCLUSIVE MODE")

    missing = bind.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM epub_nav_locations
            WHERE start_offset IS NULL OR end_offset IS NULL
            """
        )
    )
    if missing != 0:
        raise RuntimeError("0209 requires every EPUB navigation projection to have exact offsets")

    invalid_bounds = bind.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM epub_nav_locations n
            LEFT JOIN fragments f
              ON f.media_id = n.media_id
             AND f.idx = n.fragment_idx
            WHERE f.id IS NULL
               OR n.start_offset < 0
               OR n.end_offset < n.start_offset
               OR n.end_offset > char_length(f.canonical_text)
            """
        )
    )
    if invalid_bounds != 0:
        raise RuntimeError("0209 found invalid EPUB navigation offset bounds")

    invalid_intervals = bind.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM epub_nav_locations n
            JOIN fragments f
              ON f.media_id = n.media_id
             AND f.idx = n.fragment_idx
            WHERE n.end_offset <> coalesce(
                (
                    SELECT min(later.start_offset)
                    FROM epub_nav_locations later
                    WHERE later.media_id = n.media_id
                      AND later.fragment_idx = n.fragment_idx
                      AND later.start_offset > n.start_offset
                ),
                char_length(f.canonical_text)
            )
            """
        )
    )
    if invalid_intervals != 0:
        raise RuntimeError("0209 found invalid EPUB navigation intervals")

    op.alter_column("epub_nav_locations", "start_offset", nullable=False)
    op.alter_column("epub_nav_locations", "end_offset", nullable=False)


def downgrade() -> None:
    raise RuntimeError("0209 is a hard cutover migration and has no downgrade path")
