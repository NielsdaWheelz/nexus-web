"""Search query hashing and structured search logging."""

from __future__ import annotations

import hashlib
import time
from uuid import UUID

from nexus.logging import get_logger

logger = get_logger(__name__)


# =============================================================================
# Query Logging Helpers (Privacy-Safe)
# =============================================================================


def hash_query(q: str) -> str:
    """Hash a normalized query for logging (privacy-safe).

    Never log raw queries - only the hash for debugging.
    """
    q_normalized = q.strip().lower()
    return hashlib.sha256(q_normalized.encode("utf-8")).hexdigest()[:16]


def _log_search(
    viewer_id: UUID,
    q: str,
    scope: str,
    types: list[str],
    results_count: int,
    start_time: float,
) -> None:
    """Log search metrics (privacy-safe - no raw query).

    Per spec: Do NOT log raw search queries.
    Log only hash, length, and aggregate metrics.
    """
    latency_ms = int((time.time() - start_time) * 1000)
    logger.info(
        "search_executed",
        query_len=len(q),
        query_hash=hash_query(q),
        scope=scope,
        types_count=len(types),
        results_count=results_count,
        latency_ms=latency_ms,
        user_id=str(viewer_id),
    )
