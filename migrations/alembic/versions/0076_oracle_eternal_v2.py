"""Black Forest Oracle — Eternal Volume II schema migration.

Revision ID: 0076
Revises: 0075
Create Date: 2026-05-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0076"
down_revision: str | None = "0075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_THEME_CHECK = (
    "folio_theme IS NULL OR folio_theme IN ("
    "'Of Time','Of Death','Of the Threshold','Of Vanity','Of Solitude','Of Love',"
    "'Of Fortune','Of Memory','Of the Self','Of the Other','Of Fear','Of Courage',"
    "'Of Faith','Of Doubt','Of Power','Of Wisdom','Of the Body','Of the Soul',"
    "'Of Origins','Of Endings','Of Silence','Of the Word','Of Justice','Of Mercy'"
    ")"
)


def upgrade() -> None:
    op.add_column("oracle_readings", sa.Column("folio_motto", sa.Text(), nullable=True))
    op.add_column("oracle_readings", sa.Column("folio_motto_gloss", sa.Text(), nullable=True))
    op.add_column("oracle_readings", sa.Column("folio_theme", sa.Text(), nullable=True))

    op.execute(
        "UPDATE oracle_readings SET folio_motto = folio_title WHERE folio_title IS NOT NULL"
    )

    op.drop_column("oracle_readings", "folio_title")

    op.create_check_constraint(
        "ck_oracle_readings_motto_length",
        "oracle_readings",
        "folio_motto IS NULL OR char_length(folio_motto) BETWEEN 1 AND 80",
    )
    op.create_check_constraint(
        "ck_oracle_readings_motto_gloss_length",
        "oracle_readings",
        "folio_motto_gloss IS NULL OR char_length(folio_motto_gloss) BETWEEN 1 AND 120",
    )
    op.create_check_constraint(
        "ck_oracle_readings_theme",
        "oracle_readings",
        _THEME_CHECK,
    )

    op.create_index(
        "idx_oracle_readings_user_image",
        "oracle_readings",
        ["user_id", "image_id"],
    )
    op.create_index(
        "idx_oracle_readings_user_theme",
        "oracle_readings",
        ["user_id", "folio_theme"],
    )
    op.execute(
        "CREATE INDEX idx_oracle_reading_passages_citation_key "
        "ON oracle_reading_passages ((source_ref->>'citation_key'))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_oracle_reading_passages_citation_key")
    op.drop_index("idx_oracle_readings_user_theme", table_name="oracle_readings")
    op.drop_index("idx_oracle_readings_user_image", table_name="oracle_readings")

    op.drop_constraint("ck_oracle_readings_theme", "oracle_readings", type_="check")
    op.drop_constraint(
        "ck_oracle_readings_motto_gloss_length", "oracle_readings", type_="check"
    )
    op.drop_constraint("ck_oracle_readings_motto_length", "oracle_readings", type_="check")

    op.add_column("oracle_readings", sa.Column("folio_title", sa.Text(), nullable=True))

    op.execute(
        "UPDATE oracle_readings SET folio_title = folio_motto WHERE folio_motto IS NOT NULL"
    )

    op.drop_column("oracle_readings", "folio_theme")
    op.drop_column("oracle_readings", "folio_motto_gloss")
    op.drop_column("oracle_readings", "folio_motto")
