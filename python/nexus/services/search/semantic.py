"""Calibrated query embeddings and nearest chunks in one caller-owned snapshot.

The publisher supplies one active vector per current ready chunk. A bounded count
routes through 25,000 chunks to exact scoring; larger domains use ordered IVF
candidates. Tight distance bounds use eight probes, broader bounds forty. ANN
membership is approximate; returned scores and distance bounds use original floats.
Eligibility is a caller-owned predicate over ``cc``. Count proofs may come only
from a stronger domain in this same snapshot, audience and calibrated model.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any
from uuid import UUID

from provider_runtime.errors import CredentialMissing, NonGenerationCallFailed
from provider_runtime.retry import DEFAULT_RETRY
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger
from nexus.services.content_indexing import reading_chunks_sql
from nexus.services.embeddings import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_PROVIDER,
    embed_texts_async,
    embedding_model,
)

logger = get_logger(__name__)
_EXACT_MAX = 25_000
_READY = """JOIN content_index_states cis ON cis.owner_kind = cc.owner_kind
                AND cis.owner_id = cc.owner_id AND cis.status = 'ready'
                AND (cis.lexical_revision = cis.revision) IS TRUE
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model"""
_READY_COUNT = """JOIN (
    WITH current_ready AS MATERIALIZED (
        SELECT owner_kind,owner_id FROM content_index_states
        WHERE status='ready' AND (lexical_revision=revision) IS TRUE
            AND active_embedding_provider=:provider AND active_embedding_model=:model
    ) SELECT * FROM current_ready
) cis ON cis.owner_kind=cc.owner_kind AND cis.owner_id=cc.owner_id"""

type Embedding = tuple[str, list[float]]


async def embed_text(q: str) -> Embedding | None:
    """One cancellable foreground provider attempt, outside database admission.

    Expected provider failures return None for the caller's failure policy;
    malformed vectors remain defects.
    """
    try:
        vectors = await embed_texts_async([q], retry=replace(DEFAULT_RETRY, max_attempts=1))
        return embedding_model(), vectors[0]
    except (NonGenerationCallFailed, CredentialMissing) as exc:
        logger.warning(
            "search_semantic_embedding_unavailable",
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
    """Same-snapshot superset witness for vector absence; it authorizes no owner."""
    logger.info("search.vector_readiness.begin", mono_ns=time.monotonic_ns())
    try:
        eligible = _eligible(
            "cc.owner_kind = 'media' AND cc.id IN (SELECT chunk_id FROM ("
            + reading_chunks_sql("SELECT unnest(CAST(:owners AS uuid[])) AS media_id")
            + ") reading)"
        )
        return bool(
            db.scalar(
                text("SELECT EXISTS(SELECT 1 " + eligible + ")"),
                {"provider": EMBEDDING_PROVIDER, "model": model, "owners": list(owners)},
            )
        )
    finally:
        logger.info("search.vector_readiness.end", mono_ns=time.monotonic_ns())


def bounded_eligible_count(
    db: Session, *, model: str, owner: str, params: Mapping[str, Any], ctes: str
) -> int:
    """Current ready chunks, saturated at 25,001; never an ANN corpus cap.

    Reuse only as a lower bound for a superset in this caller's same read snapshot,
    model and audience. An unsaturated subset count proves no upper bound there.
    """
    return int(
        db.execute(
            text(f"""{ctes} SELECT count(*) FROM (
                SELECT 1 FROM content_chunks cc {_READY_COUNT}
                WHERE ({owner}) LIMIT :count_limit) bounded"""),
            {
                **params,
                "provider": EMBEDDING_PROVIDER,
                "model": model,
                "count_limit": _EXACT_MAX + 1,
            },
        ).scalar_one()
    )


def nearest_chunks(
    db: Session,
    embedding: Embedding,
    *,
    owner: str,
    params: Mapping[str, Any],
    limit: int,
    ctes: str,
    maximum_distance: float,
    eligible_count_lower_bound: int | None = None,
) -> list[tuple[UUID, float]]:
    """Return ``(chunk_id, cosine)`` with deterministic ties within the retained set.

    Only a caller-proved subset count above the cutoff skips this domain's count.
    Unknown or unsaturated bounds retain normal routing. The raw ANN cursor has
    no candidate cap: each row retains its eligibility boolean so crossing the
    distance bound can stop before scanning unrelated eligible rows. The cursor
    closes inside this caller-owned snapshot, including on cancellation.
    """
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
            "limit": limit,
            "maximum_distance": maximum_distance,
        }
        count = (
            eligible_count_lower_bound
            if eligible_count_lower_bound is not None and eligible_count_lower_bound > _EXACT_MAX
            else bounded_eligible_count(db, model=model, owner=owner, params=params, ctes=ctes)
        )
        if count == 0:
            return []
        if count <= _EXACT_MAX:
            eligible_ids = list(
                db.scalars(
                    text(f"{ctes} SELECT ce.chunk_id {_eligible(owner)} LIMIT :count_limit"),
                    bindings | {"count_limit": _EXACT_MAX + 1},
                )
            )
            rows = db.execute(
                text(f"""SELECT ce.chunk_id, 1 - ({distance}) FROM content_embeddings ce
                    WHERE ce.chunk_id = ANY(CAST(:eligible_ids AS uuid[]))
                      AND ce.embedding_provider = :provider AND ce.embedding_model = :model
                      AND ce.embedding_vector IS NOT NULL
                      AND ({distance}) <= :maximum_distance
                    ORDER BY ({distance}) + 0, ce.chunk_id LIMIT :limit"""),
                bindings | {"eligible_ids": eligible_ids},
            )
            return sorted(
                ((row[0], float(row[1])) for row in rows),
                key=lambda pair: (-pair[1], pair[0]),
            )
        probes = 8 if maximum_distance <= 1 - 0.80 else 40
        db.execute(text(f"SET LOCAL ivfflat.probes = {probes}"))
        rows = db.execute(
            text(f"""{ctes} SELECT ce.chunk_id, ({distance}) AS distance,
                EXISTS (SELECT 1 FROM content_chunks cc {_READY}
                    WHERE cc.id=ce.chunk_id AND ({owner}) OFFSET 0) AS admitted
                FROM content_embeddings ce
                WHERE ce.embedding_provider=:provider AND ce.embedding_model=:model
                  AND ce.embedding_vector IS NOT NULL
                ORDER BY {distance}"""),
            bindings,
            execution_options={"yield_per": 32},
        )
        near = []
        try:
            for chunk_id, raw_distance, admitted in rows:
                if not raw_distance <= maximum_distance:
                    break
                if admitted:
                    near.append((chunk_id, 1 - float(raw_distance)))
                    if len(near) == limit:
                        break
        finally:
            rows.close()
        return sorted(near, key=lambda pair: (-pair[1], pair[0]))
    finally:
        logger.info("search.nearest_chunks.end", mono_ns=time.monotonic_ns())
