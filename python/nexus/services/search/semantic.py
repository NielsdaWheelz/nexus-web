"""Calibrated query embeddings and nearest chunks in one caller-owned snapshot.

The publisher supplies one active vector per current ready chunk. A bounded count
routes through 25,000 chunks to exact scoring; larger domains use ordered IVF
candidates. Tight distance bounds use eight probes, broader bounds 128. ANN uses
normalized half inner product only for access; original floats own scores/radii.
Stored and query originals have finite components and l2 norm in [0.5, 2].
Each domain owns its eligibility predicate over ``cc`` and its independent result
window. ANN domains share one ordered scan; exact domains retain complete scoring.
Count proofs may come only from a stronger domain in this same snapshot, audience
and calibrated model. Callers own distinct parameter names across domains.
"""

from __future__ import annotations

import time
from bisect import insort
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
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


@dataclass(frozen=True)
class ChunkDomain:
    owner: str
    eligible_count_lower_bound: int | None = None


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


def _ready_chunks(owner: str) -> str:
    """The shared count/id domain; actual vector eligibility remains in scoring."""
    return f"FROM content_chunks cc {_READY_COUNT} WHERE ({owner})"


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
                SELECT 1 {_ready_chunks(owner)} LIMIT :count_limit) bounded"""),
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
    domains: Sequence[ChunkDomain],
    params: Mapping[str, Any],
    limit: int,
    ctes: str,
    maximum_distance: float,
) -> list[list[tuple[UUID, float]]]:
    """Aligned independent windows, each sorted by cosine then chunk id.

    Only a caller-proved subset count above the cutoff skips that domain's count.
    Unknown or unsaturated bounds retain normal routing. ANN domains share one
    uncapped raw cursor and independent original-score top-k windows. The selected
    half stream can reorder originals; stop only beyond every window's original
    threshold plus the conservative .01 access-key error bound, or at stream end.
    Noniterative IVF preserves one ordered batch across the fixed selected lists.
    The cursor closes inside this caller-owned snapshot, including on cancellation.
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
        near: list[list[tuple[UUID, float]]] = [[] for _ in domains]
        ann_domains: list[int] = []
        for index, domain in enumerate(domains):
            count = (
                domain.eligible_count_lower_bound
                if domain.eligible_count_lower_bound is not None
                and domain.eligible_count_lower_bound > _EXACT_MAX
                else bounded_eligible_count(
                    db, model=model, owner=domain.owner, params=params, ctes=ctes
                )
            )
            if count == 0:
                continue
            if count > _EXACT_MAX:
                ann_domains.append(index)
                continue
            # Enumerate the complete counted domain; final scoring filters vectors.
            eligible_ids = list(
                db.scalars(
                    text(f"{ctes} SELECT cc.id {_ready_chunks(domain.owner)} LIMIT :count_limit"),
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
            near[index] = sorted(
                ((row[0], float(row[1])) for row in rows),
                key=lambda pair: (-pair[1], pair[0]),
            )
            del eligible_ids, rows
        if not ann_domains:
            return near
        probes = 8 if maximum_distance <= 1 - 0.80 else 128
        db.execute(text(f"SET LOCAL ivfflat.probes = {probes}"))
        db.execute(text("SET LOCAL ivfflat.iterative_scan = off"))
        access_distance = (
            f"CAST(public.l2_normalize(ce.embedding_vector) AS public.halfvec({EMBEDDING_DIMENSIONS}))"
            " <#> "
            f"CAST(public.l2_normalize(CAST(:embedding AS vector({EMBEDDING_DIMENSIONS})))"
            f" AS public.halfvec({EMBEDDING_DIMENSIONS}))"
        )
        admission = ", ".join(
            f"""CASE WHEN ({distance}) <= :maximum_distance THEN
                EXISTS (SELECT 1 FROM content_chunks cc {_READY}
                    WHERE cc.id=ce.chunk_id AND ({domains[index].owner}) OFFSET 0)
                ELSE FALSE END AS admitted_{index}"""
            for index in ann_domains
        )
        # Half keys own access only; admission and retained windows use original cosine.
        rows = db.execute(
            text(f"""{ctes} SELECT ce.chunk_id, ({distance}) AS distance,
                1 + ({access_distance}) AS frontier,
                {admission}
                FROM content_embeddings ce
                WHERE ce.embedding_provider=:provider AND ce.embedding_model=:model
                  AND ce.embedding_vector IS NOT NULL
                ORDER BY {access_distance}"""),
            bindings,
            execution_options={"yield_per": 32},
        )
        try:
            for row in rows:
                chunk_id, raw_distance, frontier = row[:3]
                cosine = 1 - float(raw_distance)
                for index, admitted in zip(ann_domains, row[3:], strict=True):
                    window = near[index]
                    if admitted and (
                        len(window) < limit or (-cosine, chunk_id) < (-window[-1][1], window[-1][0])
                    ):
                        insort(window, (chunk_id, cosine), key=lambda pair: (-pair[1], pair[0]))
                        if len(window) > limit:
                            window.pop()
                # Strictness retains possible equal-distance candidates with better UUIDs.
                if (
                    float(frontier)
                    > max(
                        maximum_distance if len(near[index]) < limit else 1 - near[index][-1][1]
                        for index in ann_domains
                    )
                    + 0.01
                ):
                    break
        finally:
            rows.close()
        return near
    finally:
        logger.info("search.nearest_chunks.end", mono_ns=time.monotonic_ns())
