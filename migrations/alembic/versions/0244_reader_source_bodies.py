"""Preserve source note bodies and enrich exact existing fragment targets.

Revision ID: 0244
Revises: 0243
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.orm import Session

revision: str = "0244"
down_revision: str | Sequence[str] | None = "0243"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
        "0244 requires restoring the previous application and database together"
    )
