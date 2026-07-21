"""Content chunking and semantic embedding helpers."""

from __future__ import annotations

import asyncio
import hashlib
import math
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
from provider_runtime import EmbeddingCall, Present, ProviderRuntime

from nexus.config import Environment, get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.llm_credentials import embedding_credential

_TOKEN_RE = re.compile(r"[a-z0-9]+")
logger = get_logger(__name__)


def transcript_embedding_dimensions() -> int:
    settings = get_settings()
    return max(8, int(settings.transcript_embedding_dimensions))


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


def _validate_embedding_vectors(
    vectors: tuple[tuple[float, ...], ...], *, dimensions: int, expected_count: int
) -> list[list[float]]:
    try:
        if len(vectors) != expected_count:
            raise ValueError("Embedding provider returned incomplete indexes")
        return [
            _normalize_and_validate_vector(list(vector), dimensions=dimensions)
            for vector in vectors
        ]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Embedding provider returned an invalid response.",
        ) from exc


async def _embed_with_openai_async(texts: list[str], *, dimensions: int) -> list[list[float]]:
    """Embed via the platform OpenAI credential.

    ``NonGenerationCallFailed`` (transient-exhausted or oversize input) and
    ``RuntimeDefect`` (missing platform key — a deployment invariant, not a
    product-facing failure) propagate unwrapped; ``search.embedding`` is the
    sole catcher of ``NonGenerationCallFailed`` for the lexical-fallback
    classification (§ preserved). A malformed response is a hard failure.
    """
    settings = get_settings()
    credential = embedding_credential(settings, "openai")

    vectors: list[list[float]] = []
    async with httpx.AsyncClient() as client:
        runtime = ProviderRuntime(client)
        for start in range(0, len(texts), 64):
            batch = texts[start : start + 64]
            call = EmbeddingCall(
                model=settings.transcript_embedding_model_openai,
                inputs=tuple(batch),
                dimensions=Present(dimensions),
            )
            response = await runtime.embed(call, credential=credential)
            vectors.extend(
                _validate_embedding_vectors(
                    response.embeddings,
                    dimensions=dimensions,
                    expected_count=len(batch),
                )
            )
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
