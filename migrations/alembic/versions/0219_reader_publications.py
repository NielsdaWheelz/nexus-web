"""Add the isolated current Reader publication generation owner.

Revision ID: 0219
Revises: 0218
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from nexus.ids import new_uuid7

revision: str = "0219"
down_revision: str | Sequence[str] | None = "0218"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reader_publications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column(
            "changed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            name="fk_reader_publications_media",
        ),
        sa.PrimaryKeyConstraint("id", name="reader_publications_pkey"),
        sa.UniqueConstraint("media_id", name="uq_reader_publications_media"),
    )

    bind = op.get_bind()
    eligible_media_ids = bind.scalars(
        sa.text(
            """
            SELECT id
            FROM media
            WHERE kind IN ('pdf', 'epub', 'web_article')
              AND processing_status = 'ready_for_reading'
            ORDER BY id
            """
        )
    ).all()
    if eligible_media_ids:
        bind.execute(
            sa.text(
                """
                INSERT INTO reader_publications (id, media_id, generation, changed_at)
                VALUES (:id, :media_id, 1, now())
                """
            ),
            [
                {"id": new_uuid7(), "media_id": media_id}
                for media_id in eligible_media_ids
            ],
        )


def downgrade() -> None:
    raise NotImplementedError("0219 is an additive forward-only migration")
