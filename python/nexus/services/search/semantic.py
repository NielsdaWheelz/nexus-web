"""The query embedding and the one nearest-neighbour query over chunk embeddings."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from provider_runtime.errors import NonGenerationCallFailed
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger
from nexus.services.embeddings import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_PROVIDER,
    embed_texts,
    embedding_model,
    pgvector_literal,
)

logger = get_logger(__name__)

type Embedding = tuple[str, list[float]]  # (model, vector)


def embed_text(q: str) -> Embedding | None:
    """One provider call that never touches a session; the caller holds no transaction.

    An expected provider failure degrades to lexical search with one warning; a malformed
    vector is a provider defect (``embed_texts`` refuses it).
    """
    try:
        return embedding_model(), embed_texts([q])[0]
    except NonGenerationCallFailed as exc:
        logger.warning(
            "search_semantic_embedding_unavailable_lexical_fallback",
            error=type(exc.failure).__name__,
        )
        return None


def nearest_chunks(
    db: Session, embedding: Embedding, *, owner: str, params: Mapping[str, Any], limit: int
) -> list[tuple[UUID, float]]:
    """``(chunk_id, cosine)`` nearest first, ties by chunk id, among the embedded chunks of
    ready indexes on the query's model.

    ``owner`` is the caller's self-contained predicate over ``cc`` (content_chunks); it is
    the only visibility. The order operand is a bound constant, so ivfflat can drive a
    broad scope while a narrow one filters first and sorts exactly.
    """
    model, vector = embedding
    query_vector = f"CAST(:embedding AS vector({EMBEDDING_DIMENSIONS}))"
    db.execute(text("SET LOCAL ivfflat.probes = 10"))
    rows = db.execute(
        text(f"""SELECT ce.chunk_id, 1 - (ce.embedding_vector <=> {query_vector})
            FROM content_embeddings ce
            JOIN content_chunks cc ON cc.id = ce.chunk_id
            JOIN content_index_states cis ON cis.owner_kind = cc.owner_kind
                AND cis.owner_id = cc.owner_id AND cis.status = 'ready'
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model
            WHERE ce.embedding_provider = :provider AND ce.embedding_model = :model
              AND ce.embedding_vector IS NOT NULL AND ({owner})
            ORDER BY ce.embedding_vector <=> {query_vector}
            LIMIT :limit"""),
        {
            **params,
            "embedding": pgvector_literal(vector),
            "provider": EMBEDDING_PROVIDER,
            "model": model,
            "limit": limit,
        },
    )
    near = [(row[0], float(row[1])) for row in rows]
    return sorted(near, key=lambda pair: (-pair[1], pair[0]))
