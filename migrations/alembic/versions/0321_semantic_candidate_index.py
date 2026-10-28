"""Rebuild the calibrated original-float IVF index with 723 lists.

revision 0321 follows head 0320. data effects: replace only the derived vector
index; chunks, embedding identities/vectors, publication revisions and authored
rows remain unchanged. refuse current serving chunks without exactly one active
256-dimensional vector. stopped writers and a verified backup are required.

serial construction uses 160 mib maintenance memory and a two-minute statement
cap, qualified under the unchanged 512 mib database limit. rollback restores the
old index if validation or construction fails. downgrade requires the verified
pre-release backup and matching binaries.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0321"
down_revision: str | Sequence[str] | None = "0320"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    db.execute(sa.text("SET LOCAL statement_timeout='120s'"))
    invalid = db.scalar(
        sa.text("""
            SELECT count(*) FROM (
                SELECT c.id
                FROM content_index_states s
                JOIN content_chunks c ON c.owner_kind=s.owner_kind AND c.owner_id=s.owner_id
                LEFT JOIN content_embeddings e ON e.chunk_id=c.id
                    AND e.embedding_provider=s.active_embedding_provider
                    AND e.embedding_model=s.active_embedding_model
                    AND e.embedding_dimensions=256 AND e.embedding_vector IS NOT NULL
                WHERE s.status='ready' AND (s.lexical_revision=s.revision) IS TRUE
                    AND s.active_embedding_provider IS NOT NULL
                    AND s.active_embedding_model IS NOT NULL
                GROUP BY c.id HAVING count(e.id)<>1
            ) invalid
        """)
    )
    if invalid:
        raise RuntimeError(
            f"0321 refuses {invalid} current serving chunks without exactly one active 256-vector"
        )
    db.execute(sa.text("SET LOCAL maintenance_work_mem='160MB'"))
    db.execute(sa.text("SET LOCAL max_parallel_maintenance_workers=0"))
    db.execute(sa.text("DROP INDEX public.ix_content_embeddings_vector_ann"))
    db.execute(
        sa.text("""CREATE INDEX ix_content_embeddings_vector_ann
            ON public.content_embeddings USING ivfflat
            (embedding_vector public.vector_cosine_ops) WITH (lists=723)""")
    )


def downgrade() -> None:
    raise RuntimeError("Restore the verified pre-release backup and matching binaries to downgrade")
