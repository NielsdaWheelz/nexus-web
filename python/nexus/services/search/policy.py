"""Search-owned candidate-count policy for retrieval tools."""

from __future__ import annotations

from collections.abc import Sequence

from nexus.services.search.constants import DEFAULT_LIMIT, MAX_LIMIT

APP_SEARCH_SCOPED_CANDIDATE_LIMIT = DEFAULT_LIMIT
APP_SEARCH_DEEP_CANDIDATE_LIMIT = MAX_LIMIT


def app_search_candidate_policy(scope_uris: Sequence[str]) -> tuple[int, str, str]:
    if len(scope_uris) == 1 and scope_uris[0].startswith("media:"):
        return APP_SEARCH_SCOPED_CANDIDATE_LIMIT, "fast", "single_narrow_scope"
    if len(scope_uris) == 1 and scope_uris[0].startswith("library:"):
        return APP_SEARCH_DEEP_CANDIDATE_LIMIT, "deep", "library_scope"
    if len(scope_uris) == 1 and scope_uris[0].startswith("conversation:"):
        return APP_SEARCH_DEEP_CANDIDATE_LIMIT, "deep", "conversation_scope"
    if len(scope_uris) > 1:
        return APP_SEARCH_DEEP_CANDIDATE_LIMIT, "deep", "multiple_scopes"
    return APP_SEARCH_DEEP_CANDIDATE_LIMIT, "deep", "global_scope"
