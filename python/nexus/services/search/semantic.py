"""Calibrated complete semantic windows inside a caller-owned snapshot.

Each owner predicate carries its own authority over the ``cc`` chunk alias.
Original float vectors decide both the threshold and the per-domain ordering.
The publisher supplies one active vector per current ready chunk.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any
from uuid import UUID

from provider_runtime.errors import CredentialMissing, NonGenerationCallFailed
from provider_runtime.retry import DEFAULT_RETRY
from provider_runtime.types import TransientExhausted
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.content_indexing import reading_chunks_sql
from nexus.services.embeddings import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_PROVIDER,
    embed_texts_async,
    embedding_model,
)

logger = get_logger(__name__)
_READY = """JOIN content_index_states cis ON cis.owner_kind = cc.owner_kind
                AND cis.owner_id = cc.owner_id AND cis.status = 'ready'
                AND (cis.lexical_revision = cis.revision) IS TRUE
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model"""

type Embedding = tuple[str, list[float]]


async def embed_text(q: str) -> Embedding:
    """One required query embedding, outside database admission.

    Missing configuration and transient exhaustion are modeled unavailability.
    Other provider failures and malformed vectors remain defects. Callers skip
    this operation entirely when semantics were not requested.
    """
    try:
        vectors = await embed_texts_async([q], retry=replace(DEFAULT_RETRY, max_attempts=1))
        return embedding_model(), vectors[0]
    except (NonGenerationCallFailed, CredentialMissing) as exc:
        if isinstance(exc, NonGenerationCallFailed) and not isinstance(
            exc.failure, TransientExhausted
        ):
            raise
        logger.warning(
            "search_semantic_embedding_unavailable",
            error=type(exc.failure).__name__
            if isinstance(exc, NonGenerationCallFailed)
            else type(exc).__name__,
        )
        raise ApiError(
            ApiErrorCode.E_EMBEDDING_PROVIDER_UNAVAILABLE, "Related matches are unavailable."
        ) from exc


def _eligible(owner: str) -> str:
    return f"""FROM content_embeddings ce
            JOIN content_chunks cc ON cc.id = ce.chunk_id
            {_READY}
            WHERE ce.embedding_provider = :provider AND ce.embedding_model = :model
              AND ce.embedding_dimensions = :dimensions
              AND ce.embedding_vector IS NOT NULL AND ({owner})"""


def has_media_vectors(db: Session, model: str, owners: Sequence[UUID], viewer_id: UUID) -> bool:
    """Current-vector absence is a visibility-independent superset witness only.

    Consume it in the ranking's same caller RR snapshot. This does not authorize owners.
    """
    logger.info("search.vector_readiness.begin", mono_ns=time.monotonic_ns())
    try:
        eligible = _eligible(
            "cc.owner_kind IN ('media','fragment') AND cc.id IN (SELECT chunk_id FROM ("
            + reading_chunks_sql("SELECT unnest(CAST(:owners AS uuid[])) AS media_id")
            + ") reading)"
        )
        return bool(
            db.scalar(
                text("SELECT EXISTS(SELECT 1 " + eligible + ")"),
                {
                    "provider": EMBEDDING_PROVIDER,
                    "model": model,
                    "dimensions": EMBEDDING_DIMENSIONS,
                    "owners": list(owners),
                    "viewer_id": viewer_id,
                },
            )
        )
    finally:
        logger.info("search.vector_readiness.end", mono_ns=time.monotonic_ns())


def nearest_chunks(
    db: Session,
    embedding: Embedding,
    *,
    domains: Sequence[str],
    params: Mapping[str, Any],
    limit: int,
    ctes: str,
    maximum_distance: float,
) -> list[list[tuple[UUID, float]]]:
    """Complete independent windows ordered by original cosine and chunk id."""
    logger.info("search.nearest_chunks.begin", mono_ns=time.monotonic_ns())
    try:
        model, vector = embedding
        distance = f"ce.embedding_vector <=> CAST(:embedding AS vector({EMBEDDING_DIMENSIONS}))"
        bindings = {
            **params,
            # Query-only round trip: publication's serializer and stored vectors stay owned there.
            "embedding": "[" + ",".join(repr(float(value)) for value in vector) + "]",
            "provider": EMBEDDING_PROVIDER,
            "model": model,
            "dimensions": EMBEDDING_DIMENSIONS,
            "limit": limit,
            "maximum_distance": maximum_distance,
        }
        # justify-service-invariant-check: validate the exact serialized query even for empty domains.
        valid = db.scalar(
            text(f"""SELECT (CAST(:embedding AS vector({EMBEDDING_DIMENSIONS}))
                <=> CAST(:embedding AS vector({EMBEDDING_DIMENSIONS})) BETWEEN 0 AND 2) IS TRUE"""),
            {"embedding": bindings["embedding"]},
        )
        if not valid:
            raise ValueError("query embedding is not representable for cosine distance")
        windows = []
        for owner in domains:
            rows = db.execute(
                text(f"""{ctes} SELECT ce.chunk_id, 1 - ({distance})
                    {_eligible(owner)} AND ({distance}) <= :maximum_distance
                    ORDER BY ({distance}) + 0, ce.chunk_id LIMIT :limit"""),
                bindings,
            )
            windows.append([(row[0], float(row[1])) for row in rows])
        return windows
    finally:
        logger.info("search.nearest_chunks.end", mono_ns=time.monotonic_ns())
