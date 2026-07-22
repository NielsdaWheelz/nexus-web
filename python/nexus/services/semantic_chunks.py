"""Content chunking and semantic embedding helpers."""

from __future__ import annotations

import asyncio
import hashlib
import math
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
from provider_runtime import ModelRuntime, ProviderApiKey
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import EmbeddingCall, ModelRef, RetryPolicy

from nexus.config import Environment, get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.llm_catalog import configured_platform_key, is_provider_enabled
from nexus.logging import get_logger

_TOKEN_RE = re.compile(r"[a-z0-9]+")
# Embeddings are an external third-party API: retries.md gives these a budget
# longer than infrastructure retries, kept well under the 300s worker lease.
_EMBEDDING_PROVIDER_MAX_ATTEMPTS = 5
logger = get_logger(__name__)


def transcript_embedding_dimensions() -> int:
    settings = get_settings()
    return max(8, int(settings.transcript_embedding_dimensions))


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


def media_best_peer_rows_sql(eligible_media_relation: str) -> str:
    """Best same-tuple eligible peer for every eligible anchor media.

    ``eligible_media_relation`` is a checked-in relation exposing ``media_id``;
    it is never request text. The returned relation binds
    ``:embedding_dimensions`` plus the supplied relation's binds and yields one
    row per distinct non-null eligible media id with ``anchor_media_id``,
    nullable ``peer_media_id``/``distance``, and the anchor's nullable active
    ``embedding_provider``, ``embedding_model``, and ``embedding_dimensions``.

    Each anchor uses its first active chunk by ``(chunk_idx, id)``. One LATERAL
    nearest-neighbor read stays inside the composed SQL query, restricts peers
    to the eligible relation before ``LIMIT 1``, and requires the peer's exact
    same active provider/model/dimensions tuple. This is the full-membership
    counterpart to :func:`media_neighbor_rows_sql`; it performs no Python
    per-entry query loop and does not truncate the anchor relation.
    """
    return f"""
        WITH eligible_media AS (
            {eligible_media_relation}
        ),
        eligible_media_ids AS (
            SELECT DISTINCT media_id
            FROM eligible_media
            WHERE media_id IS NOT NULL
        )
        SELECT
            anchor.media_id AS anchor_media_id,
            nearest.peer_media_id,
            nearest.distance,
            anchor_vector.embedding_provider,
            anchor_vector.embedding_model,
            anchor_vector.embedding_dimensions
        FROM eligible_media_ids anchor
        LEFT JOIN LATERAL (
            SELECT
                ce.embedding_vector AS vector,
                ce.embedding_provider,
                ce.embedding_model,
                ce.embedding_dimensions
            FROM content_index_states anchor_state
            JOIN content_chunks cc
              ON cc.owner_kind = 'media'
             AND cc.owner_id = anchor_state.owner_id
            JOIN content_embeddings ce
              ON ce.chunk_id = cc.id
             AND ce.embedding_provider = anchor_state.active_embedding_provider
             AND ce.embedding_model = anchor_state.active_embedding_model
             AND ce.embedding_dimensions = :embedding_dimensions
             AND ce.embedding_vector IS NOT NULL
            WHERE anchor_state.owner_kind = 'media'
              AND anchor_state.owner_id = anchor.media_id
              AND anchor_state.status = 'ready'
              AND anchor_state.active_embedding_provider IS NOT NULL
              AND anchor_state.active_embedding_model IS NOT NULL
            ORDER BY cc.chunk_idx ASC, cc.id ASC
            LIMIT 1
        ) anchor_vector ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                cc.owner_id AS peer_media_id,
                (ce.embedding_vector <=> anchor_vector.vector) AS distance
            FROM content_embeddings ce
            JOIN content_chunks cc
              ON cc.id = ce.chunk_id
             AND cc.owner_kind = 'media'
            JOIN eligible_media_ids eligible_peer
              ON eligible_peer.media_id = cc.owner_id
            JOIN content_index_states peer_state
              ON peer_state.owner_kind = 'media'
             AND peer_state.owner_id = cc.owner_id
             AND peer_state.status = 'ready'
             AND peer_state.active_embedding_provider = anchor_vector.embedding_provider
             AND peer_state.active_embedding_model = anchor_vector.embedding_model
            WHERE anchor_vector.vector IS NOT NULL
              AND cc.owner_id <> anchor.media_id
              AND ce.embedding_provider = anchor_vector.embedding_provider
              AND ce.embedding_model = anchor_vector.embedding_model
              AND ce.embedding_dimensions = anchor_vector.embedding_dimensions
              AND ce.embedding_vector IS NOT NULL
            ORDER BY
                ce.embedding_vector <=> anchor_vector.vector ASC,
                cc.owner_id ASC,
                cc.id ASC
            LIMIT 1
        ) nearest ON TRUE
        ORDER BY anchor.media_id ASC
    """


def current_transcript_embedding_model() -> str:
    settings = get_settings()
    dimensions = transcript_embedding_dimensions()
    if settings.real_media_provider_fixtures:
        return f"fixture_hash_v1_{dimensions}"
    if settings.nexus_env == Environment.TEST:
        return f"test_hash_v2_{dimensions}"
    normalized_model = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(settings.transcript_embedding_model_openai or "text-embedding-3-small").lower(),
    ).strip("_")
    return f"openai_{normalized_model}_{dimensions}_v1"


def transcript_embedding_provider_for_model(model_name: str) -> str:
    if model_name.startswith("fixture_hash_v1_"):
        return "fixture"
    if model_name.startswith("test_hash_v2_"):
        return "test"
    return "openai"


def current_transcript_embedding_provider() -> str:
    return transcript_embedding_provider_for_model(current_transcript_embedding_model())


def to_pgvector_literal(vector: list[float]) -> str:
    """Serialize numeric embedding payload to pgvector literal text."""
    return "[" + ",".join(f"{float(value):.8f}" for value in vector) + "]"


def _normalize_and_validate_vector(vector: Any, *, dimensions: int) -> list[float]:
    if not isinstance(vector, list):
        raise ValueError("Embedding payload must be a list")
    normalized: list[float] = []
    for value in vector:
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError("Embedding payload values must be finite")
        normalized.append(numeric)
    if len(normalized) != dimensions:
        raise ValueError(f"Expected embedding dimension {dimensions}, got {len(normalized)}")
    return normalized


def build_deterministic_hash_embedding(text: str, *, dimensions: int) -> list[float]:
    """Build the deterministic fixture/test embedding shared by local semantic stores."""
    tokens = _TOKEN_RE.findall(str(text or "").lower())
    if not tokens:
        return [0.0] * dimensions

    vector = [0.0] * dimensions
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        # Deterministic signed hashed bag-of-words projection.
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        sign = -1.0 if (digest[4] % 2) else 1.0
        weight = ((int.from_bytes(digest[5:7], "big") % 1000) + 1) / 1000.0
        vector[bucket] += sign * weight

    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0.0:
        return [0.0] * dimensions
    return [component / norm for component in vector]


def _embedding_provider_error(error_code: ModelCallErrorCode) -> ApiErrorCode:
    if error_code == ModelCallErrorCode.INVALID_KEY:
        return ApiErrorCode.E_LLM_INVALID_KEY
    if error_code == ModelCallErrorCode.RATE_LIMIT:
        return ApiErrorCode.E_LLM_RATE_LIMIT
    if error_code == ModelCallErrorCode.TIMEOUT:
        return ApiErrorCode.E_LLM_TIMEOUT
    if error_code == ModelCallErrorCode.MODEL_NOT_AVAILABLE:
        return ApiErrorCode.E_MODEL_NOT_AVAILABLE
    if error_code == ModelCallErrorCode.QUOTA_EXCEEDED:
        return ApiErrorCode.E_LLM_QUOTA_EXCEEDED
    if error_code in {ModelCallErrorCode.BAD_REQUEST, ModelCallErrorCode.CONTEXT_TOO_LARGE}:
        return ApiErrorCode.E_LLM_BAD_REQUEST
    return ApiErrorCode.E_LLM_PROVIDER_DOWN


def _validate_embedding_vectors(
    vectors: list[list[float]], *, dimensions: int, expected_count: int
) -> list[list[float]]:
    try:
        if len(vectors) != expected_count:
            raise ValueError("Embedding provider returned incomplete indexes")
        return [_normalize_and_validate_vector(vector, dimensions=dimensions) for vector in vectors]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_LLM_PROVIDER_DOWN,
            "Embedding provider returned an invalid response.",
        ) from exc


def _api_error_from_embedding_error(exc: ModelCallError) -> ApiError:
    api_code = _embedding_provider_error(exc.error_code)
    message = (
        "Embedding provider returned an invalid response."
        if _is_invalid_embedding_response_error(exc)
        else "Embedding provider request failed."
    )
    return ApiError(api_code, message)


def _is_invalid_embedding_response_error(exc: ModelCallError) -> bool:
    return (
        _embedding_provider_error(exc.error_code) == ApiErrorCode.E_LLM_PROVIDER_DOWN
        and "embedding" in exc.message.lower()
        and "response" in exc.message.lower()
    )


async def _embed_with_openai_async(texts: list[str], *, dimensions: int) -> list[list[float]]:
    settings = get_settings()
    if not is_provider_enabled("openai", settings):
        raise ApiError(
            ApiErrorCode.E_MODEL_NOT_AVAILABLE,
            "OpenAI embeddings are disabled.",
        )
    api_key = configured_platform_key("openai", settings)
    if not api_key:
        raise ApiError(
            ApiErrorCode.E_LLM_NO_KEY,
            "OPENAI_API_KEY is required for transcript semantic embeddings.",
        )

    vectors: list[list[float]] = []
    async with httpx.AsyncClient() as client:
        runtime = ModelRuntime(
            client,
            enable_openai=settings.enable_openai,
            enable_anthropic=False,
            enable_gemini=False,
            enable_openrouter=False,
            enable_cloudflare=False,
        )
        for start in range(0, len(texts), 64):
            batch = texts[start : start + 64]
            call = EmbeddingCall(
                model=ModelRef(provider="openai", model=settings.transcript_embedding_model_openai),
                inputs=batch,
                dimensions=dimensions,
                retry=RetryPolicy(
                    max_attempts=_EMBEDDING_PROVIDER_MAX_ATTEMPTS,
                    initial_delay_s=2.0,
                    max_delay_s=30.0,
                ),
            )
            try:
                response = await runtime.embed(
                    call,
                    key=ProviderApiKey(api_key, source="platform"),
                    timeout_s=int(settings.transcript_embedding_timeout_seconds),
                )
                vectors.extend(
                    _validate_embedding_vectors(
                        response.embeddings,
                        dimensions=dimensions,
                        expected_count=len(batch),
                    )
                )
            except ModelCallError as exc:
                api_code = _embedding_provider_error(exc.error_code)
                logger.warning(
                    "embedding_provider_request_failed",
                    error_code=api_code.value,
                )
                raise _api_error_from_embedding_error(exc) from exc
    return vectors


def _embed_with_openai(texts: list[str], *, dimensions: int) -> list[list[float]]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_embed_with_openai_async(texts, dimensions=dimensions))

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            lambda: asyncio.run(_embed_with_openai_async(texts, dimensions=dimensions))
        )
        return future.result()


def build_text_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
    """Build embeddings for multiple texts using the configured embedding backend."""
    dimensions = transcript_embedding_dimensions()
    model_name = current_transcript_embedding_model()

    normalized_texts = [str(text or "").strip() for text in texts]
    if not normalized_texts:
        return model_name, []

    if transcript_embedding_provider_for_model(model_name) in {"fixture", "test"}:
        return model_name, [
            build_deterministic_hash_embedding(text, dimensions=dimensions)
            for text in normalized_texts
        ]
    return model_name, _embed_with_openai(normalized_texts, dimensions=dimensions)


def build_text_embedding(text: str) -> tuple[str, list[float]]:
    model_name, vectors = build_text_embeddings([text])
    return model_name, (vectors[0] if vectors else [0.0] * transcript_embedding_dimensions())
