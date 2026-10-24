"""Query embeddings and cardinality-routed nearest neighbours over eligible chunks.

A bounded current-ready chunk count chooses exact distance through 25,000 vectors,
otherwise 40-probe ivfflat. The publisher owns one matching nonnull vector per
current ready chunk; cutover validates that bijection for serving legacy data.
The count and vector reads share one caller snapshot, active model and visibility.
Only the small branch fetches its eligible vector ids; a saturated count never
caps ANN's domain. Actual vector reads retain their provider and nonnull filters.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from provider_runtime.errors import CredentialMissing, NonGenerationCallFailed
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
_EXACT_MAX = 25_000
_READY = """JOIN content_index_states cis ON cis.owner_kind = cc.owner_kind
                AND cis.owner_id = cc.owner_id AND cis.status = 'ready'
                AND (cis.lexical_revision = cis.revision) IS TRUE
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model"""

type Embedding = tuple[str, list[float]]  # (model, vector)


def embed_text(q: str) -> Embedding | None:
    """One provider call that never touches a session; the caller holds no transaction.

    An expected provider failure degrades to lexical search with one warning; a malformed
    vector is a provider defect (``embed_texts`` refuses it).
    """
    try:
        return embedding_model(), embed_texts([q])[0]
    except (NonGenerationCallFailed, CredentialMissing) as exc:
        logger.warning(
            "search_semantic_embedding_unavailable_lexical_fallback",
            error=type(exc.failure).__name__
            if isinstance(exc, NonGenerationCallFailed)
            else type(exc).__name__,
        )
        return None


def _eligible(owner: str) -> str:
    return f"""FROM content_embeddings ce
            JOIN content_chunks cc ON cc.id = ce.chunk_id
            {_READY}
            WHERE ce.embedding_provider = :provider AND ce.embedding_model = :model
              AND ce.embedding_vector IS NOT NULL AND ({owner})"""


def has_media_vectors(db: Session, model: str, owners: Sequence[UUID]) -> bool:
    """Current-vector absence is a visibility-independent superset witness only.

    Consume it in the ranking's same caller RR snapshot. This does not authorize owners.
    """
    logger.info("search.vector_readiness.begin", mono_ns=time.monotonic_ns())
    try:
        eligible = _eligible(
            "cc.owner_kind = 'media' AND cc.owner_id = ANY(CAST(:owners AS uuid[]))"
        )
        return bool(
            db.scalar(
                text("SELECT EXISTS(SELECT 1 " + eligible + ")"),
                {"provider": EMBEDDING_PROVIDER, "model": model, "owners": list(owners)},
            )
        )
    finally:
        logger.info("search.vector_readiness.end", mono_ns=time.monotonic_ns())


def nearest_chunks(
    db: Session, embedding: Embedding, *, owner: str, params: Mapping[str, Any], limit: int
) -> list[tuple[UUID, float]]:
    """``(chunk_id, cosine)`` nearest first, ties by chunk id, among the embedded chunks of
    current lexical publications with ready indexes on the query's model.

    ``owner`` is the caller's self-contained predicate over ``cc`` (content_chunks); it is
    the only visibility. Ready-vector coverage makes the bounded chunk count equal
    the eligible vector count. The small branch then fetches actual vector ids in
    the same snapshot. Exact ordering disables ANN; broad ordering keeps its bound
    distance operand and complete eligibility predicate.
    """
    logger.info("search.nearest_chunks.begin", mono_ns=time.monotonic_ns())
    try:
        model, vector = embedding
        query_vector = f"CAST(:embedding AS vector({EMBEDDING_DIMENSIONS}))"
        eligible = _eligible(owner)
        bindings = {
            **params,
            "embedding": pgvector_literal(vector),
            "provider": EMBEDDING_PROVIDER,
            "model": model,
            "limit": limit,
        }
        count = db.execute(
            text(f"""SELECT count(*) FROM (
            SELECT 1 FROM content_chunks cc {_READY}
            WHERE ({owner}) LIMIT :count_limit) bounded"""),
            bindings | {"count_limit": _EXACT_MAX + 1},
        ).scalar_one()
        if count == 0:
            return []
        distance = f"ce.embedding_vector <=> {query_vector}"
        if count <= _EXACT_MAX:
            eligible_ids = list(
                db.scalars(
                    text(f"SELECT ce.chunk_id {eligible} LIMIT :count_limit"),
                    bindings | {"count_limit": _EXACT_MAX + 1},
                )
            )
            rows = db.execute(
                text(f"""SELECT ce.chunk_id, 1 - ({distance}) FROM content_embeddings ce
                WHERE ce.chunk_id = ANY(CAST(:eligible_ids AS uuid[]))
                  AND ce.embedding_provider = :provider AND ce.embedding_model = :model
                  AND ce.embedding_vector IS NOT NULL
                ORDER BY ({distance}) + 0, ce.chunk_id LIMIT :limit"""),
                bindings | {"eligible_ids": eligible_ids},
            )
        else:
            db.execute(text("SET LOCAL ivfflat.probes = 40"))
            rows = db.execute(
                text(
                    f"SELECT ce.chunk_id, 1 - ({distance}) {eligible} ORDER BY {distance} LIMIT :limit"
                ),
                bindings,
            )
        near = [(row[0], float(row[1])) for row in rows]
        return sorted(near, key=lambda pair: (-pair[1], pair[0]))
    finally:
        logger.info("search.nearest_chunks.end", mono_ns=time.monotonic_ns())
