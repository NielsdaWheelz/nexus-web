"""Content chunking and semantic embedding helpers."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

import httpx

from nexus.config import Environment, get_settings
from nexus.errors import ApiError, ApiErrorCode

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"


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
        normalized.append(float(value))
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


def _embed_with_openai(texts: list[str], *, dimensions: int) -> list[list[float]]:
    settings = get_settings()
    api_key = settings.openai_api_key
    if not settings.enable_openai or not api_key:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "OPENAI_API_KEY is required for transcript semantic embeddings.",
        )

    payload = {
        "model": settings.transcript_embedding_model_openai,
        "input": texts,
        "dimensions": dimensions,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    response = httpx.post(
        _OPENAI_EMBEDDINGS_URL,
        headers=headers,
        json=payload,
        timeout=httpx.Timeout(settings.transcript_embedding_timeout_seconds, connect=10.0),
    )
    response.raise_for_status()
    body = response.json()
    data = body.get("data")
    if not isinstance(data, list):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Embedding provider response missing data list.")

    ordered = sorted(data, key=lambda item: int(item.get("index", 0)))
    vectors: list[list[float]] = []
    for item in ordered:
        vectors.append(_normalize_and_validate_vector(item.get("embedding"), dimensions=dimensions))
    if len(vectors) != len(texts):
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            f"Embedding provider returned {len(vectors)} vectors for {len(texts)} inputs.",
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


def chunk_transcript_segments(transcript_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build one semantic chunk per normalized transcript segment."""
    chunks: list[dict[str, Any]] = []
    for idx, segment in enumerate(transcript_segments):
        chunk_text = str(segment.get("text") or "").strip()
        if not chunk_text:
            continue
        t_start_ms = int(segment.get("t_start_ms") or 0)
        t_end_ms = int(segment.get("t_end_ms") or 0)
        if t_end_ms <= t_start_ms:
            continue
        chunks.append(
            {
                "chunk_idx": idx,
                "chunk_text": chunk_text,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
            }
        )

    if not chunks:
        return []

    model_name, embeddings = build_text_embeddings([chunk["chunk_text"] for chunk in chunks])
    for chunk, embedding in zip(chunks, embeddings, strict=True):
        chunk["embedding_model"] = model_name
        chunk["embedding"] = embedding
    return chunks
