"""Select exact original-vector retrieval and require valid cosine vectors.

revision 0321 follows head 0320. data effects: drop the unused derived ann index
and validate stored vectors; original values, chunks, identities, publication
revisions and authored rows remain unchanged. refuse nonnull vectors whose native
cosine self-distance is invalid and current serving chunks without exactly one
active 256-vector. stopped writers and a verified backup are required. the
selected path still requires native resource and lifecycle qualification.
downgrade requires the verified pre-release backup and matching binaries.
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
    invalid_vectors = db.scalar(
        sa.text("""SELECT count(*) FROM public.content_embeddings
            WHERE embedding_vector IS NOT NULL
              AND (embedding_vector <=> embedding_vector BETWEEN 0 AND 2) IS NOT TRUE""")
    )
    if invalid_vectors:
        raise RuntimeError(
            f"0321 refuses {invalid_vectors} original vectors invalid for cosine distance"
        )
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
    db.execute(sa.text("DROP INDEX public.ix_content_embeddings_vector_ann"))


def downgrade() -> None:
    raise RuntimeError(
        "Restore the verified pre-release backup and matching binaries to downgrade"
    )
