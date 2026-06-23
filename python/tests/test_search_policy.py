"""Search policy tests."""

from typing import cast
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.services.search.guidance import (
    AppSearchGuidance,
    load_app_search_guidance,
    unused_guidance_metadata,
)
from nexus.services.search.policy import (
    APP_SEARCH_DEEP_CANDIDATE_LIMIT,
    APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
    plan_app_search,
)

pytestmark = pytest.mark.unit


def test_app_search_guidance_is_disabled_unused_stub() -> None:
    # Generated retrieval guidance is intentionally deferred: the loader must stay a
    # fail-safe disabled stub — empty query suffix (no ranking influence) and
    # unused-status metadata — until a real generated-guidance owner exists, so it
    # can never silently affect candidate ordering or leak into evidence. See
    # docs/cutovers/search/search-contextual-hierarchy-artifacts-hard-cutover.md.
    guidance = load_app_search_guidance(
        cast(Session, None),
        viewer_id=uuid4(),
        query_class="cross_document_synthesis",
        scope_uris=["library:00000000-0000-0000-0000-000000000001"],
    )
    assert guidance == AppSearchGuidance(
        query_suffix="",
        metadata={"version": "retrieval_guidance_usage.v1", "status": "unused"},
    )
    assert guidance.metadata == unused_guidance_metadata()


def test_app_search_planner_chooses_scope_depth_and_query_class() -> None:
    scoped = plan_app_search(
        "find this phrase",
        ["media:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert scoped.query_class == "scoped_passage_lookup"
    assert scoped.candidate_limit == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
    assert scoped.retrieval_mode == "fast"
    assert scoped.policy_reason == "single_narrow_scope"
    assert scoped.context_route == "search_fetch_read"

    scoped_summary = plan_app_search(
        "summarize this whole document",
        ["media:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert scoped_summary.query_class == "single_source_summary"
    assert scoped_summary.candidate_limit == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
    assert scoped_summary.retrieval_mode == "fast"
    assert scoped_summary.policy_reason == "single_narrow_scope"
    assert scoped_summary.context_route == "long_context_candidate"
    assert scoped_summary.context_route_reason == "single_media_whole_source_query"

    scoped_search = plan_app_search(
        "summarize the pricing argument",
        ["media:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert scoped_search.query_class == "scoped_passage_lookup"
    assert scoped_search.context_route == "search_fetch_read"

    library_absence = plan_app_search(
        "Do any sources mention barter?",
        ["library:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert library_absence.query_class == "negative_absence_question"
    assert library_absence.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert library_absence.retrieval_mode == "deep"
    assert library_absence.policy_reason == "library_scope"
    assert library_absence.context_route == "search_fetch_read"

    multi_scope = plan_app_search(
        "compare the themes",
        [
            "media:00000000-0000-0000-0000-000000000001",
            "media:00000000-0000-0000-0000-000000000002",
        ],
        [],
        provider_rerank_allowed=False,
    )
    assert multi_scope.query_class == "cross_document_synthesis"
    assert multi_scope.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert multi_scope.retrieval_mode == "deep"
    assert multi_scope.policy_reason == "multiple_scopes"
    assert multi_scope.context_route == "search_fetch_read"
    assert multi_scope.rerank_mode == "deterministic"

    multi_scope_hop = plan_app_search(
        "inspect then read the follow up",
        [
            "media:00000000-0000-0000-0000-000000000001",
            "media:00000000-0000-0000-0000-000000000002",
        ],
        [],
        provider_rerank_allowed=True,
    )
    assert multi_scope_hop.query_class == "multi_hop_search_read_inspect_question"
    assert multi_scope_hop.rerank_mode == "provider_rerank"
    assert multi_scope_hop.rerank_reason == "multi_hop_deep_retrieval"

    library_summary = plan_app_search(
        "summarize this library",
        ["library:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert library_summary.query_class == "global_library_question"
    assert library_summary.retrieval_mode == "deep"
    assert library_summary.context_route == "search_fetch_read"

    conversation = plan_app_search(
        "latest notes",
        [],
        ["conversations"],
        provider_rerank_allowed=False,
    )
    assert conversation.query_class == "recency_or_conversation_question"
    assert conversation.policy_reason == "global_scope"

    scoped_conversation_exact = plan_app_search(
        "Satoshi Nakamoto",
        ["conversation:00000000-0000-0000-0000-000000000001"],
        [],
        provider_rerank_allowed=False,
    )
    assert scoped_conversation_exact.query_class == "exact_lookup"
    assert scoped_conversation_exact.policy_reason == "conversation_scope"

    multi_hop = plan_app_search(
        "trace the connection across saved sources",
        [],
        [],
        provider_rerank_allowed=True,
    )
    assert multi_hop.query_class == "multi_hop_search_read_inspect_question"
    assert multi_hop.rerank_mode == "provider_rerank"

    multi_hop_ineligible = plan_app_search(
        "inspect then read the follow up",
        [],
        [],
        provider_rerank_allowed=False,
    )
    assert multi_hop_ineligible.query_class == "multi_hop_search_read_inspect_question"
    assert multi_hop_ineligible.rerank_mode == "deterministic"
    assert multi_hop_ineligible.rerank_reason == "deterministic_baseline"

    exact = plan_app_search(
        "Satoshi Nakamoto",
        [],
        [],
        provider_rerank_allowed=False,
    )
    assert exact.query_class == "exact_lookup"
