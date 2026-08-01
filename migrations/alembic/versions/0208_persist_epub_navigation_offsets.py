"""Persist exact EPUB navigation offsets computed at ingest.

Revision ID: 0208
Revises: 0207
Create Date: 2026-07-31
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0208"
down_revision: str | Sequence[str] | None = "0207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "epub_nav_locations",
        sa.Column("start_offset", sa.Integer(), nullable=True),
    )
    op.add_column(
        "epub_nav_locations",
        sa.Column("end_offset", sa.Integer(), nullable=True),
    )

    _backfill_offsets()

    op.alter_column("epub_nav_locations", "start_offset", nullable=False)
    op.alter_column("epub_nav_locations", "end_offset", nullable=False)
    op.create_check_constraint(
        "ck_epub_nav_locations_offsets_valid",
        "epub_nav_locations",
        "start_offset >= 0 AND end_offset >= start_offset",
    )


def _backfill_offsets() -> None:
    from nexus.services.canonicalize import generate_canonical_text_with_element_offsets

    bind = op.get_bind()
    media_ids = bind.execute(
        sa.text(
            """
            SELECT DISTINCT media_id
            FROM epub_nav_locations
            ORDER BY media_id
            """
        )
    ).scalars()

    for media_id in media_ids:
        media_rows = (
            bind.execute(
                sa.text(
                    """
                    SELECT location_id,
                           ordinal,
                           fragment_idx,
                           href_fragment
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                    ORDER BY ordinal
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .all()
        )
        fragment_rows = {
            int(row["idx"]): row
            for row in (
                bind.execute(
                    sa.text(
                        """
                        SELECT f.idx,
                               f.html_sanitized,
                               f.canonical_text
                        FROM fragments f
                        JOIN (
                            SELECT DISTINCT fragment_idx
                            FROM epub_nav_locations
                            WHERE media_id = :media_id
                        ) n ON n.fragment_idx = f.idx
                        WHERE f.media_id = :media_id
                        ORDER BY f.idx
                        """
                    ),
                    {"media_id": media_id},
                )
                .mappings()
                .all()
            )
        }

        requested_ids: dict[int, set[str]] = {}
        for row in media_rows:
            fragment_idx = int(row["fragment_idx"])
            if fragment_idx not in fragment_rows:
                raise RuntimeError("0208 found EPUB navigation without its fragment")
            if row["href_fragment"] is not None:
                requested_ids.setdefault(fragment_idx, set()).add(str(row["href_fragment"]))

        anchor_offsets: dict[int, dict[str, int]] = {}
        for fragment_idx, element_ids in requested_ids.items():
            fragment = fragment_rows[fragment_idx]
            canonical_text, offsets = generate_canonical_text_with_element_offsets(
                str(fragment["html_sanitized"]),
                element_ids,
            )
            if canonical_text != str(fragment["canonical_text"]):
                raise RuntimeError("0208 found canonical text drift in ready EPUB navigation")
            missing = element_ids - offsets.keys()
            if missing:
                raise RuntimeError(f"0208 found missing EPUB navigation anchor {min(missing)!r}")
            anchor_offsets[fragment_idx] = offsets

        starts: list[int] = []
        indexes_by_fragment: dict[int, list[int]] = {}
        for row in media_rows:
            fragment_idx = int(row["fragment_idx"])
            anchor_id = row["href_fragment"]
            starts.append(0 if anchor_id is None else anchor_offsets[fragment_idx][str(anchor_id)])
            indexes_by_fragment.setdefault(fragment_idx, []).append(len(starts) - 1)

        ends = [0] * len(media_rows)
        for fragment_idx, indexes in indexes_by_fragment.items():
            previous_start = -1
            fragment_length = len(str(fragment_rows[fragment_idx]["canonical_text"]))
            for index in indexes:
                if starts[index] < previous_start:
                    raise RuntimeError("0208 found EPUB navigation anchors out of document order")
                previous_start = starts[index]
            for position, index in enumerate(indexes):
                ends[index] = next(
                    (
                        starts[later]
                        for later in indexes[position + 1 :]
                        if starts[later] > starts[index]
                    ),
                    fragment_length,
                )

        updates = [
            {
                "media_id": media_id,
                "location_id": row["location_id"],
                "start_offset": starts[index],
                "end_offset": ends[index],
            }
            for index, row in enumerate(media_rows)
        ]
        bind.execute(
            sa.text(
                """
                UPDATE epub_nav_locations
                SET start_offset = :start_offset,
                    end_offset = :end_offset
                WHERE media_id = :media_id
                  AND location_id = :location_id
                """
            ),
            updates,
        )

    remaining = bind.scalar(
        sa.text(
            """
            SELECT count(*)
            FROM epub_nav_locations
            WHERE start_offset IS NULL OR end_offset IS NULL
            """
        )
    )
    if remaining != 0:
        raise RuntimeError("0208 failed to backfill every EPUB navigation offset")


def downgrade() -> None:
    raise RuntimeError("0208 is a hard cutover migration and has no downgrade path")
