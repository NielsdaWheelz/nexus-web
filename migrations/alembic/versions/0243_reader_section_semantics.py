"""Store note groups and give published contents independent targets.

Revision ID: 0243
Revises: 0242
Create Date: 2026-09-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0243"
down_revision: str | Sequence[str] | None = "0242"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reader_apparatus_states",
        sa.Column(
            "note_groups", JSONB, server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
    )
    op.add_column("epub_toc_nodes", sa.Column("section_id", sa.Text(), nullable=True))
    op.add_column("epub_toc_nodes", sa.Column("resolution", sa.Text(), nullable=True))
    op.execute("""
        UPDATE epub_toc_nodes toc
        SET resolution = CASE
            WHEN fragment_idx IS NOT NULL AND target_offset IS NOT NULL THEN 'SourceTarget'
            ELSE 'Unresolved'
        END
    """)
    op.execute("""
        UPDATE epub_toc_nodes toc
        SET section_id = (
            SELECT nav.location_id FROM epub_nav_locations nav
            WHERE nav.media_id = toc.media_id AND nav.source_node_id = toc.node_id
              AND nav.fragment_idx = toc.fragment_idx AND nav.start_offset = toc.target_offset
            ORDER BY nav.ordinal, nav.location_id LIMIT 1
        )
        WHERE toc.fragment_idx IS NOT NULL AND toc.target_offset IS NOT NULL
    """)
    op.execute("""
        UPDATE epub_toc_nodes
        SET fragment_idx = NULL, target_offset = NULL, section_id = NULL
        WHERE resolution = 'Unresolved'
    """)
    op.alter_column("epub_toc_nodes", "resolution", nullable=False)
    op.drop_constraint(
        "fk_epub_nav_locations_toc_node", "epub_nav_locations", type_="foreignkey"
    )
    op.drop_column("epub_nav_locations", "source_node_id")
    op.create_foreign_key(
        "fk_epub_toc_nodes_section",
        "epub_toc_nodes",
        "epub_nav_locations",
        ["media_id", "section_id"],
        ["media_id", "location_id"],
        deferrable=True,
        initially="DEFERRED",
    )


def downgrade() -> None:
    raise NotImplementedError("0243 is an irreversible reader contract cutover")
