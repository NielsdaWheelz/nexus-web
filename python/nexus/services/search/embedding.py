"""Query embedding capability gate and full-text-term detection.

Hybrid retrieval is an invariant (spec §5.5): the query embedding is built once and
fed to every semantic-capable retriever regardless of structured filters. The build
is operationally resilient — a missing embedding key degrades to lexical-only,
typed and logged, never a silent legacy fallback.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.semantic_chunks import build_text_embedding, transcript_embedding_dimensions

logger = get_logger(__name__)


def _query_has_full_text_terms(db: Session, q: str) -> bool:
    return bool(
        db.scalar(
            text("SELECT numnode(websearch_to_tsquery('english', :query)) > 0"),
            {"query": q},
        )
    )


def build_query_embedding(
    db: Session,
    q: str,
    result_types: list[str],
    *,
    transaction_active_at_entry: bool,
) -> tuple[str, list[float]] | None:
    """Build the query embedding once, or return None for lexical-only fallback.

    Rolls back a non-caller transaction first so the embedding HTTP call does not
    hold a DB transaction open. A missing embedding key degrades to lexical-only
    (typed + logged); a wrong-dimension response is a hard provider error.
    """
    if not transaction_active_at_entry and db.in_transaction():
        db.rollback()
    try:
        embedding = build_text_embedding(q)
    except ApiError as exc:
        if exc.code is not ApiErrorCode.E_LLM_NO_KEY:
            raise
        logger.warning(
            "search_semantic_embedding_unavailable_lexical_fallback",
            error_code=exc.code.value,
            result_types=",".join(result_types),
        )
        return None
    if len(embedding[1]) != transcript_embedding_dimensions():
        raise ApiError(
            ApiErrorCode.E_LLM_PROVIDER_DOWN,
            "Embedding provider returned an invalid response.",
        )
    return embedding
