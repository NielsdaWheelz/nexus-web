"""Persist exact EPUB navigation offsets computed at ingest.

Revision ID: 0208
Revises: 0207
Create Date: 2026-07-31
"""

from collections.abc import Callable, Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

revision: str = "0208"
down_revision: str | Sequence[str] | None = "0207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_FRAGMENT_KEY_BATCH_SIZE = 256


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
    last_media_id: object | None = None
    last_fragment_idx = -1

    while True:
        if last_media_id is None:
            fragment_keys = bind.execute(
                sa.text(
                    """
                    SELECT DISTINCT n.media_id, n.fragment_idx
                    FROM epub_nav_locations n
                    ORDER BY n.media_id, n.fragment_idx
                    LIMIT :limit
                    """
                ),
                {"limit": _FRAGMENT_KEY_BATCH_SIZE},
            ).mappings().all()
        else:
            fragment_keys = bind.execute(
                sa.text(
                    """
                    SELECT DISTINCT n.media_id, n.fragment_idx
                    FROM epub_nav_locations n
                    WHERE n.media_id > :last_media_id
                       OR (
                            n.media_id = :last_media_id
                        AND n.fragment_idx > :last_fragment_idx
                       )
                    ORDER BY n.media_id, n.fragment_idx
                    LIMIT :limit
                    """
                ),
                {
                    "last_media_id": last_media_id,
                    "last_fragment_idx": last_fragment_idx,
                    "limit": _FRAGMENT_KEY_BATCH_SIZE,
                },
            ).mappings().all()

        if not fragment_keys:
            break

        for fragment_key in fragment_keys:
            _backfill_fragment_offsets(
                bind,
                media_id=fragment_key["media_id"],
                fragment_idx=int(fragment_key["fragment_idx"]),
                generate_offsets=generate_canonical_text_with_element_offsets,
            )

        last_key = fragment_keys[-1]
        last_media_id = last_key["media_id"]
        last_fragment_idx = int(last_key["fragment_idx"])

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


def _backfill_fragment_offsets(
    bind: Connection,
    *,
    media_id: object,
    fragment_idx: int,
    generate_offsets: Callable[[str, set[str]], tuple[str, dict[str, int]]],
) -> None:
    fragment = (
        bind.execute(
            sa.text(
                """
                SELECT html_sanitized, canonical_text
                FROM fragments
                WHERE media_id = :media_id
                  AND idx = :fragment_idx
                """
            ),
            {"media_id": media_id, "fragment_idx": fragment_idx},
        )
        .mappings()
        .one()
    )
    nav_rows = (
        bind.execute(
            sa.text(
                """
                SELECT location_id, href_fragment
                FROM epub_nav_locations
                WHERE media_id = :media_id
                  AND fragment_idx = :fragment_idx
                ORDER BY ordinal
                """
            ),
            {"media_id": media_id, "fragment_idx": fragment_idx},
        )
        .mappings()
        .all()
    )
    element_ids = {
        str(row["href_fragment"])
        for row in nav_rows
        if row["href_fragment"] is not None
    }
    canonical_text, anchor_offsets = generate_offsets(
        str(fragment["html_sanitized"]),
        element_ids,
    )
    persisted_canonical_text = str(fragment["canonical_text"])
    if canonical_text != persisted_canonical_text:
        raise RuntimeError("0208 found canonical text drift in ready EPUB navigation")
    missing = element_ids - anchor_offsets.keys()
    if missing:
        raise RuntimeError(f"0208 found missing EPUB navigation anchor {min(missing)!r}")

    starts = [
        0
        if row["href_fragment"] is None
        else anchor_offsets[str(row["href_fragment"])]
        for row in nav_rows
    ]
    previous_start = -1
    for start in starts:
        if start < previous_start:
            raise RuntimeError("0208 found EPUB navigation anchors out of document order")
        previous_start = start

    fragment_length = len(persisted_canonical_text)
    ends = [fragment_length] * len(starts)
    next_greater_start = fragment_length
    for index in range(len(starts) - 1, -1, -1):
        if index + 1 < len(starts) and starts[index] < starts[index + 1]:
            next_greater_start = starts[index + 1]
        ends[index] = next_greater_start
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
        [
            {
                "media_id": media_id,
                "location_id": row["location_id"],
                "start_offset": starts[index],
                "end_offset": ends[index],
            }
            for index, row in enumerate(nav_rows)
        ],
    )


def downgrade() -> None:
    raise RuntimeError("0208 is a hard cutover migration and has no downgrade path")
