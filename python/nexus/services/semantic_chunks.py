"""Deterministic transcript chunking + lightweight semantic scoring helpers."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_EMBEDDING_DIM = 3


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
                "embedding": build_text_embedding(chunk_text),
            }
        )
    return chunks


def build_text_embedding(text: str) -> list[float]:
    """Deterministic tiny embedding vector for local ranking."""
    tokens = _TOKEN_RE.findall(str(text or "").lower())
    if not tokens:
        return [0.0] * _EMBEDDING_DIM

    vector = [0.0] * _EMBEDDING_DIM
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for i in range(_EMBEDDING_DIM):
            chunk = digest[i * 4 : (i + 1) * 4]
            # Deterministic signed contribution in [-1, 1].
            value = (int.from_bytes(chunk, "big") % 2001) - 1000
            vector[i] += float(value) / 1000.0

    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0.0:
        return [0.0] * _EMBEDDING_DIM
    return [component / norm for component in vector]


def cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    """Cosine similarity with graceful handling of malformed vectors."""
    if len(lhs) != len(rhs) or not lhs:
        return 0.0
    dot = 0.0
    lhs_norm = 0.0
    rhs_norm = 0.0
    for l_val, r_val in zip(lhs, rhs, strict=False):
        dot += l_val * r_val
        lhs_norm += l_val * l_val
        rhs_norm += r_val * r_val
    if lhs_norm <= 0.0 or rhs_norm <= 0.0:
        return 0.0
    return dot / math.sqrt(lhs_norm * rhs_norm)


def lexical_overlap_score(query: str, text: str) -> float:
    """Simple token-overlap score used as stable semantic tie-breaker."""
    query_tokens = set(_TOKEN_RE.findall(str(query or "").lower()))
    text_tokens = set(_TOKEN_RE.findall(str(text or "").lower()))
    if not query_tokens or not text_tokens:
        return 0.0
    overlap = len(query_tokens.intersection(text_tokens))
    return float(overlap) / float(len(query_tokens))


def normalize_embedding_payload(payload: Any) -> list[float]:
    """Parse embedding payloads from json/jsonb query rows."""
    if not isinstance(payload, list):
        return []
    normalized: list[float] = []
    for value in payload:
        try:
            normalized.append(float(value))
        except (TypeError, ValueError):
            return []
    return normalized
