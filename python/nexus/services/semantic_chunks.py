"""Content chunking and semantic embedding helpers."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

import httpx

from nexus.config import Environment, get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
logger = get_logger(__name__)


def transcript_embedding_dimensions() -> int:
    settings = get_settings()
    return max(8, int(settings.transcript_embedding_dimensions))


def current_transcript_embedding_model() -> str:
    settings = get_settings()
    dimensions = transcript_embedding_dimensions()
    if settings.nexus_env == Environment.TEST:
        return f"test_hash_v2_{dimensions}"
    normalized_model = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(settings.transcript_embedding_model_openai or "text-embedding-3-small").lower(),
    ).strip("_")
    return f"openai_{normalized_model}_{dimensions}_v1"


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


def _build_test_embedding(text: str, *, dimensions: int) -> list[float]:
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


def _embedding_provider_error(status_code: int) -> ApiErrorCode:
    if status_code in {401, 403}:
        return ApiErrorCode.E_LLM_INVALID_KEY
    if status_code == 429:
        return ApiErrorCode.E_LLM_RATE_LIMIT
    if status_code in {408, 504}:
        return ApiErrorCode.E_LLM_TIMEOUT
    if status_code == 404:
        return ApiErrorCode.E_MODEL_NOT_AVAILABLE
    if status_code >= 500:
        return ApiErrorCode.E_LLM_PROVIDER_DOWN
    if 400 <= status_code < 500:
        return ApiErrorCode.E_LLM_BAD_REQUEST
    return ApiErrorCode.E_LLM_PROVIDER_DOWN


def _parse_embedding_response_data(
    body: Any, *, dimensions: int, expected_count: int
) -> list[list[float]]:
    try:
        if not isinstance(body, dict):
            raise ValueError("Embedding provider response must be an object")
        data = body.get("data")
        if not isinstance(data, list):
            raise ValueError("Embedding provider response missing data list")
        vectors_by_index: dict[int, list[float]] = {}
        for item in data:
            if not isinstance(item, dict):
                raise ValueError("Embedding provider data item must be an object")
            index = item.get("index")
            if (
                not isinstance(index, int)
                or isinstance(index, bool)
                or index < 0
                or index >= expected_count
                or index in vectors_by_index
            ):
                raise ValueError("Embedding provider returned invalid indexes")
            vectors_by_index[index] = _normalize_and_validate_vector(
                item.get("embedding"), dimensions=dimensions
            )
        if set(vectors_by_index) != set(range(expected_count)):
            raise ValueError("Embedding provider returned incomplete indexes")
        return [vectors_by_index[index] for index in range(expected_count)]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_LLM_PROVIDER_DOWN,
            "Embedding provider returned an invalid response.",
        ) from exc


def _embed_with_openai(texts: list[str], *, dimensions: int) -> list[list[float]]:
    settings = get_settings()
    api_key = settings.openai_api_key
    if not settings.enable_openai:
        raise ApiError(
            ApiErrorCode.E_MODEL_NOT_AVAILABLE,
            "OpenAI embeddings are disabled.",
        )
    if not api_key:
        raise ApiError(
            ApiErrorCode.E_LLM_NO_KEY,
            "OPENAI_API_KEY is required for transcript semantic embeddings.",
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    vectors: list[list[float]] = []
    for start in range(0, len(texts), 64):
        batch = texts[start : start + 64]
        try:
            response = httpx.post(
                _OPENAI_EMBEDDINGS_URL,
                headers=headers,
                json={
                    "model": settings.transcript_embedding_model_openai,
                    "input": batch,
                    "dimensions": dimensions,
                },
                timeout=httpx.Timeout(settings.transcript_embedding_timeout_seconds, connect=10.0),
            )
        except httpx.TimeoutException as exc:
            raise ApiError(
                ApiErrorCode.E_LLM_TIMEOUT,
                "Embedding provider request timed out.",
            ) from exc
        except httpx.RequestError as exc:
            raise ApiError(
                ApiErrorCode.E_LLM_PROVIDER_DOWN,
                "Embedding provider request failed.",
            ) from exc
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error_code = _embedding_provider_error(response.status_code)
            logger.warning(
                "embedding_provider_request_failed",
                status_code=response.status_code,
                error_code=error_code.value,
                response_chars=len(response.text),
            )
            raise ApiError(
                error_code,
                "Embedding provider request failed.",
            ) from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise ApiError(
                ApiErrorCode.E_LLM_PROVIDER_DOWN,
                "Embedding provider returned invalid JSON.",
            ) from exc
        vectors.extend(
            _parse_embedding_response_data(body, dimensions=dimensions, expected_count=len(batch))
        )
    return vectors


def build_text_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
    """Build embeddings for multiple texts using production embedding backend."""
    dimensions = transcript_embedding_dimensions()
    model_name = current_transcript_embedding_model()

    normalized_texts = [str(text or "").strip() for text in texts]
    if not normalized_texts:
        return model_name, []

    settings = get_settings()
    if settings.nexus_env == Environment.TEST:
        return model_name, [
            _build_test_embedding(text, dimensions=dimensions) for text in normalized_texts
        ]
    return model_name, _embed_with_openai(normalized_texts, dimensions=dimensions)


def build_text_embedding(text: str) -> tuple[str, list[float]]:
    model_name, vectors = build_text_embeddings([text])
    return model_name, (vectors[0] if vectors else [0.0] * transcript_embedding_dimensions())
