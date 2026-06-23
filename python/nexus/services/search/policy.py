"""Search-owned candidate-count policy for retrieval tools."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from nexus.services.search.constants import DEFAULT_LIMIT, MAX_LIMIT

APP_SEARCH_SCOPED_CANDIDATE_LIMIT = DEFAULT_LIMIT
APP_SEARCH_DEEP_CANDIDATE_LIMIT = MAX_LIMIT


@dataclass(frozen=True, slots=True)
class AppSearchRetrievalPlan:
    query_class: str
    candidate_limit: int
    retrieval_mode: str
    policy_reason: str
    rerank_mode: str = "deterministic"
    rerank_reason: str = "deterministic_baseline"
    context_route: str = "search_fetch_read"
    context_route_reason: str = "default_search_fetch_read"


def plan_app_search(
    query: str,
    scope_uris: Sequence[str],
    requested_kinds: Sequence[str] | None,
    *,
    provider_rerank_allowed: bool,
) -> AppSearchRetrievalPlan:
    query_class = _query_class(query, requested_kinds)
    rerank_mode = (
        "provider_rerank"
        if query_class == "multi_hop_search_read_inspect_question" and provider_rerank_allowed
        else "deterministic"
    )
    rerank_reason = (
        "multi_hop_deep_retrieval" if rerank_mode == "provider_rerank" else "deterministic_baseline"
    )
    if len(scope_uris) == 1 and scope_uris[0].startswith("media:"):
        terms = set(re.findall(r"[a-z0-9]+", query.lower()))
        if terms & {"all", "entire", "full", "whole"} and terms & {
            "article",
            "book",
            "document",
            "media",
            "source",
            "text",
        }:
            return AppSearchRetrievalPlan(
                query_class="single_source_summary",
                candidate_limit=APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
                retrieval_mode="fast",
                policy_reason="single_narrow_scope",
                context_route="long_context_candidate",
                context_route_reason="single_media_whole_source_query",
            )
        return AppSearchRetrievalPlan(
            query_class="scoped_passage_lookup",
            candidate_limit=APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
            retrieval_mode="fast",
            policy_reason="single_narrow_scope",
        )
    if len(scope_uris) == 1 and scope_uris[0].startswith("library:"):
        return AppSearchRetrievalPlan(
            query_class=query_class,
            candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
            retrieval_mode="deep",
            policy_reason="library_scope",
            rerank_mode=rerank_mode,
            rerank_reason=rerank_reason,
        )
    if len(scope_uris) == 1 and scope_uris[0].startswith("conversation:"):
        if query_class == "multi_hop_search_read_inspect_question":
            return AppSearchRetrievalPlan(
                query_class=query_class,
                candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
                retrieval_mode="deep",
                policy_reason="conversation_scope",
                rerank_mode=rerank_mode,
                rerank_reason=rerank_reason,
            )
        return AppSearchRetrievalPlan(
            query_class=query_class,
            candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
            retrieval_mode="deep",
            policy_reason="conversation_scope",
        )
    if len(scope_uris) > 1:
        multi_scope_query_class = (
            query_class
            if query_class == "multi_hop_search_read_inspect_question"
            else "cross_document_synthesis"
        )
        multi_scope_rerank_mode = (
            "provider_rerank"
            if multi_scope_query_class == "multi_hop_search_read_inspect_question"
            and provider_rerank_allowed
            else "deterministic"
        )
        return AppSearchRetrievalPlan(
            query_class=multi_scope_query_class,
            candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
            retrieval_mode="deep",
            policy_reason="multiple_scopes",
            rerank_mode=multi_scope_rerank_mode,
            rerank_reason=(
                "multi_hop_deep_retrieval"
                if multi_scope_rerank_mode == "provider_rerank"
                else "deterministic_baseline"
            ),
        )
    return AppSearchRetrievalPlan(
        query_class=query_class,
        candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
        retrieval_mode="deep",
        policy_reason="global_scope",
        rerank_mode=rerank_mode,
        rerank_reason=rerank_reason,
    )


def _query_class(query: str, requested_kinds: Sequence[str] | None) -> str:
    lower = query.lower()
    terms = set(re.findall(r"[a-z0-9]+", query.lower()))
    if (
        terms & {"absent", "absence", "missing", "mentions"}
        or "do any" in lower
        or "does any" in lower
        or "any source" in lower
        or "any sources" in lower
    ):
        return "negative_absence_question"
    if terms & {"inspect", "read", "follow", "multi", "hop", "trace", "connect", "connection"}:
        return "multi_hop_search_read_inspect_question"
    if terms & {"recent", "recency", "conversation", "latest"} or (
        requested_kinds is not None and "conversations" in requested_kinds
    ):
        return "recency_or_conversation_question"
    if terms & {"compare", "across", "cross", "themes", "patterns", "synthesis"}:
        return "cross_document_synthesis"
    if terms & {"global", "overview", "summarize", "summary", "library"}:
        return "global_library_question"
    return "exact_lookup"
