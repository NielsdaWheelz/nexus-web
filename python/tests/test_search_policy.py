"""Search policy tests."""

from nexus.services.search.policy import (
    APP_SEARCH_DEEP_CANDIDATE_LIMIT,
    APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
    plan_app_search,
)


def test_app_search_planner_chooses_scope_depth_and_query_class() -> None:
    scoped = plan_app_search("find this phrase", ["media:00000000-0000-0000-0000-000000000001"], [])
    assert scoped.query_class == "scoped_passage_lookup"
    assert scoped.candidate_limit == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
    assert scoped.retrieval_mode == "fast"
    assert scoped.policy_reason == "single_narrow_scope"

    library_absence = plan_app_search(
        "Do any sources mention barter?",
        ["library:00000000-0000-0000-0000-000000000001"],
        [],
    )
    assert library_absence.query_class == "negative_absence_question"
    assert library_absence.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert library_absence.retrieval_mode == "deep"
    assert library_absence.policy_reason == "library_scope"

    multi_scope = plan_app_search(
        "compare the themes",
        [
            "media:00000000-0000-0000-0000-000000000001",
            "media:00000000-0000-0000-0000-000000000002",
        ],
        [],
    )
    assert multi_scope.query_class == "cross_document_synthesis"
    assert multi_scope.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert multi_scope.retrieval_mode == "deep"
    assert multi_scope.policy_reason == "multiple_scopes"

    conversation = plan_app_search("latest notes", [], ["conversations"])
    assert conversation.query_class == "recency_or_conversation_question"
    assert conversation.policy_reason == "global_scope"

    multi_hop = plan_app_search("inspect then read the follow up", [], [])
    assert multi_hop.query_class == "multi_hop_search_read_inspect_question"

    exact = plan_app_search("Satoshi Nakamoto", [], [])
    assert exact.query_class == "exact_lookup"
