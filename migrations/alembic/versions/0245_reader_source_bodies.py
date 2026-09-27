"""Preserve source note bodies and enrich exact existing fragment targets.

Revision ID: 0245
Revises: 0244
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.orm import Session

revision: str = "0245"
down_revision: str | Sequence[str] | None = "0244"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    missing_count, sample_ids = (
        op.get_bind()
        .execute(
            sa.text("""
        WITH missing AS (
            SELECT DISTINCT item.media_id
            FROM reader_apparatus_items item
            LEFT JOIN reader_publications publication ON publication.media_id = item.media_id
            WHERE publication.media_id IS NULL
        )
        SELECT (SELECT COUNT(*) FROM missing),
               ARRAY(SELECT media_id FROM missing ORDER BY media_id LIMIT 10)
        """)
        )
        .one()
    )
    if missing_count:
        raise RuntimeError(
            f"0245 blocked: {missing_count} apparatus media have no reader publication; "
            f"sample media ids: {', '.join(str(media_id) for media_id in sample_ids)}. "
            "repair publication linkage and retry"
        )

    op.add_column(
        "reader_apparatus_items",
        sa.Column("body_html_sanitized", sa.Text(), nullable=True),
    )
    from nexus.services.reader_apparatus import enrich_media_apparatus_bodies

    with Session(bind=op.get_bind()) as db:
        for media_id in db.scalars(sa.text("SELECT DISTINCT media_id FROM reader_apparatus_items")):
            enrich_media_apparatus_bodies(db, media_id=media_id)
        db.flush()


def downgrade() -> None:
    raise NotImplementedError(
        "0245 requires restoring the previous application and database together"
    )
