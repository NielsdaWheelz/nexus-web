"""Per-type weights and within-type score normalization."""

from __future__ import annotations

from nexus.services.search.results import InternalSearchResult

# Supported search result types (ordered for deterministic behavior).
# Omitted type filters must mean "search everything the caller can ask for".
# Type weight multipliers (applied post-rank)
TYPE_WEIGHTS = {
    "media": 1.3,
    "podcast": 1.15,
    "episode": 1.15,
    "video": 1.15,
    "content_chunk": 1.1,
    "fragment": 1.1,
    "contributor": 1.25,
    "page": 1.2,
    "note_block": 1.2,
    "highlight": 1.25,
    "message": 1.0,
    "evidence_span": 1.15,
    "reader_apparatus_item": 1.1,
    "conversation": 0.95,
    "web_result": 0.9,
}


def _normalize_scores_by_type(results: list[InternalSearchResult]) -> None:
    """Normalize weighted scores within each type to [0, 1] range.

    Modifies results in place.
    """
    # Group by type
    by_type: dict[str, list[InternalSearchResult]] = {}
    for result in results:
        by_type.setdefault(result.result_type, []).append(result)

    # Normalize each type
    for type_results in by_type.values():
        if not type_results:
            continue

        max_score = max(result.score.weighted for result in type_results)
        min_score = min(result.score.weighted for result in type_results)

        if max_score == min_score:
            # All same score -> all get 1.0 (or 0.5 if zero)
            norm_value = 1.0 if max_score > 0 else 0.5
            for result in type_results:
                result.score.normalized = norm_value
        else:
            for result in type_results:
                result.score.normalized = (result.score.weighted - min_score) / (
                    max_score - min_score
                )
