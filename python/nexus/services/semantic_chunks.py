"""Embedding identity, the OpenAI batch embed, and resonance's ANN relation."""

from __future__ import annotations

import asyncio
import math
import re
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

from nexus.config import Settings, get_settings
from nexus.errors import ApiError, ApiErrorCode

if TYPE_CHECKING:
    import httpx

_EMBEDDING_BATCH_SIZE = 64


def transcript_embedding_dimensions() -> int:
    return max(8, int(get_settings().transcript_embedding_dimensions))


def current_transcript_embedding_model() -> str:
    """The active model identity stamped on every row it embeds."""
    settings = get_settings()
    normalized = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(settings.transcript_embedding_model_openai or "text-embedding-3-small").lower(),
    ).strip("_")
    return f"openai_{normalized}_{transcript_embedding_dimensions()}_v1"


def transcript_embedding_provider_for_model(model_name: str) -> str:
    del model_name
    return "openai"


def current_transcript_embedding_provider() -> str:
    return transcript_embedding_provider_for_model(current_transcript_embedding_model())


def to_pgvector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in vector) + "]"


def _checked(
    vectors: tuple[tuple[float, ...], ...], *, dimensions: int, expected_count: int
) -> list[list[float]]:
    """Every returned vector must be complete, finite and of the configured width."""
    try:
        if len(vectors) != expected_count:
            raise ValueError("Embedding provider returned incomplete indexes")
        checked: list[list[float]] = []
        for vector in vectors:
            values = [float(value) for value in vector]
            if len(values) != dimensions or not all(math.isfinite(value) for value in values):
                raise ValueError("Embedding payload is malformed")
            checked.append(values)
        return checked
    except (TypeError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED, "Embedding provider returned an invalid response."
        ) from exc


async def _embed_async(
    texts: list[str], *, dimensions: int, settings: Settings, http_client: httpx.AsyncClient
) -> list[list[float]]:
    """Embed through the platform OpenAI credential, in bounded batches.

    ``NonGenerationCallFailed`` (transient-exhausted or oversize input) and a
    missing platform key propagate unwrapped: ``search.service`` is the sole
    catcher of the former for its lexical fallback.
    """
    from provider_runtime import Credentials, EmbeddingCall, Present, ProviderRuntime

    from nexus.services.llm_credentials import embedding_credential

    credential = embedding_credential(settings)
    runtime = ProviderRuntime(Credentials(openai=credential.key), http_client=http_client)
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _EMBEDDING_BATCH_SIZE):
        batch = texts[start : start + _EMBEDDING_BATCH_SIZE]
        response = await runtime.embed(
            EmbeddingCall(
                model=settings.transcript_embedding_model_openai,
                inputs=tuple(batch),
                dimensions=Present(dimensions),
            ),
            credential=credential,
        )
        vectors.extend(
            _checked(response.embeddings, dimensions=dimensions, expected_count=len(batch))
        )
    return vectors


def build_text_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
    """Embed many texts from synchronous code (the indexing job's path)."""
    import httpx

    dimensions = transcript_embedding_dimensions()
    model_name = current_transcript_embedding_model()
    normalized = [str(text or "").strip() for text in texts]
    if not normalized:
        return model_name, []

    settings = get_settings()

    async def embed() -> list[list[float]]:
        async with httpx.AsyncClient(trust_env=False) as client:
            return await _embed_async(
                normalized, dimensions=dimensions, settings=settings, http_client=client
            )

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return model_name, asyncio.run(embed())
    # Called from a thread that already owns a loop: run the call on its own.
    with ThreadPoolExecutor(max_workers=1) as executor:
        return model_name, executor.submit(lambda: asyncio.run(embed())).result()


def build_text_embedding(text: str) -> tuple[str, list[float]]:
    model_name, vectors = build_text_embeddings([text])
    return model_name, (vectors[0] if vectors else [0.0] * transcript_embedding_dimensions())


async def build_text_embedding_async(text: str) -> tuple[str, list[float]]:
    """Build one query embedding on the caller's event loop, without DB state."""
    import httpx

    settings = get_settings()
    dimensions = transcript_embedding_dimensions()
    async with httpx.AsyncClient(trust_env=False) as client:
        vectors = await _embed_async(
            [str(text or "").strip()],
            dimensions=dimensions,
            settings=settings,
            http_client=client,
        )
    return current_transcript_embedding_model(), vectors[0]


def media_neighbor_rows_sql(eligible_media_relation: str) -> str:
    """Same-active-tuple media neighbors per bounded candidate partition.

    ``eligible_media_relation`` must be a checked-in composable relation with a
    ``media_id`` and non-null ``candidate_partition`` column; it is never request
    text. The returned SQL binds
    ``:anchor_media_id``, ``:embedding_dimensions``, and ``:candidate_limit``
    plus any binds owned by the supplied relation. It returns
    ``peer_media_id``, minimum cosine ``distance``, ``embedding_provider``,
    ``embedding_model``, ``embedding_dimensions``, and ``candidate_partition``.

    Eligibility is joined before the ANN candidate limit. The anchor vector is
    the first active media chunk by ``(chunk_idx, id)`` and peer embeddings must
    match that exact active provider/model/dimensions tuple. Limiting is applied
    independently to every caller-owned partition.
    """
    return f"""
        WITH eligible_media AS (
            {eligible_media_relation}
        ),
        eligible_media_partitions AS (
            SELECT DISTINCT media_id, candidate_partition
            FROM eligible_media
            WHERE candidate_partition IS NOT NULL
        ),
        candidate_partitions AS (
            SELECT DISTINCT candidate_partition
            FROM eligible_media_partitions
        ),
        anchor_state AS (
            SELECT
                cis.active_embedding_provider AS embedding_provider,
                cis.active_embedding_model AS embedding_model
            FROM content_index_states cis
            WHERE cis.owner_kind = 'media'
              AND cis.owner_id = :anchor_media_id
              AND cis.status = 'ready'
              AND cis.active_embedding_provider IS NOT NULL
              AND cis.active_embedding_model IS NOT NULL
        ),
        anchor_vector AS (
            SELECT
                ce.embedding_vector AS vector,
                ce.embedding_provider,
                ce.embedding_model,
                ce.embedding_dimensions
            FROM content_chunks cc
            JOIN content_embeddings ce ON ce.chunk_id = cc.id
            JOIN anchor_state ast
              ON ast.embedding_provider = ce.embedding_provider
             AND ast.embedding_model = ce.embedding_model
            WHERE cc.owner_kind = 'media'
              AND cc.owner_id = :anchor_media_id
              AND ce.embedding_dimensions = :embedding_dimensions
              AND ce.embedding_vector IS NOT NULL
            ORDER BY cc.chunk_idx ASC, cc.id ASC
            LIMIT 1
        ),
        nearest_chunks AS (
            SELECT
                nearest.peer_media_id,
                nearest.distance,
                nearest.embedding_provider,
                nearest.embedding_model,
                nearest.embedding_dimensions,
                partitions.candidate_partition
            FROM anchor_vector av
            CROSS JOIN candidate_partitions partitions
            CROSS JOIN LATERAL (
                SELECT
                    cc.owner_id AS peer_media_id,
                    (ce.embedding_vector <=> av.vector) AS distance,
                    ce.embedding_provider,
                    ce.embedding_model,
                    ce.embedding_dimensions
                FROM content_embeddings ce
                JOIN content_chunks cc ON cc.id = ce.chunk_id
                JOIN eligible_media_partitions eligible
                  ON eligible.media_id = cc.owner_id
                 AND eligible.candidate_partition = partitions.candidate_partition
                JOIN content_index_states peer_state
                  ON peer_state.owner_kind = 'media'
                 AND peer_state.owner_id = cc.owner_id
                 AND peer_state.status = 'ready'
                 AND peer_state.active_embedding_provider = av.embedding_provider
                 AND peer_state.active_embedding_model = av.embedding_model
                WHERE cc.owner_kind = 'media'
                  AND cc.owner_id <> :anchor_media_id
                  AND ce.embedding_provider = av.embedding_provider
                  AND ce.embedding_model = av.embedding_model
                  AND ce.embedding_dimensions = av.embedding_dimensions
                  AND ce.embedding_vector IS NOT NULL
                ORDER BY
                    ce.embedding_vector <=> av.vector ASC,
                    cc.owner_id ASC,
                    cc.id ASC
                LIMIT :candidate_limit
            ) nearest
        )
        SELECT
            peer_media_id,
            MIN(distance) AS distance,
            embedding_provider,
            embedding_model,
            embedding_dimensions,
            candidate_partition
        FROM nearest_chunks
        GROUP BY
            peer_media_id,
            embedding_provider,
            embedding_model,
            embedding_dimensions,
            candidate_partition
        ORDER BY candidate_partition ASC, distance ASC, peer_media_id ASC
    """
