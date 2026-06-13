"""Library Intelligence revision resource refs.

Revision ID: 0156
Revises: 0155
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0156"
down_revision: str | Sequence[str] | None = "0155"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RESOURCE_EDGE_SCHEMES = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_corpus_passage', 'library_intelligence_artifact',
    'library_intelligence_revision',
    'external_snapshot', 'contributor', 'podcast', 'tag'
"""


def upgrade() -> None:
    op.execute("""
        DELETE FROM resource_edges
        WHERE origin = 'citation'
          AND source_scheme = 'library_intelligence_artifact'
          AND ordinal IS NOT NULL
    """)
    op.drop_constraint(
        "ck_resource_edges_source_scheme",
        "resource_edges",
        type_="check",
    )
    op.drop_constraint(
        "ck_resource_edges_target_scheme",
        "resource_edges",
        type_="check",
    )
    op.create_check_constraint(
        "ck_resource_edges_source_scheme",
        "resource_edges",
        f"source_scheme IN ({_RESOURCE_EDGE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_resource_edges_target_scheme",
        "resource_edges",
        f"target_scheme IN ({_RESOURCE_EDGE_SCHEMES})",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0156 is not reversible")
