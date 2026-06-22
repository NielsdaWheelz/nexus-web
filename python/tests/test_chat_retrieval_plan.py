"""Tests for chat-owned run-level retrieval planning."""

import time

import pytest

from nexus.schemas.conversation import TrustRetrievalPlanOut
from nexus.services.chat_retrieval_plan import (
    CHAT_TOOL_NAMES,
    PLAN_VERSION,
    ChatRetrievalPlan,
    plan_chat_retrieval,
)

pytestmark = pytest.mark.unit


PLANNER_EVAL_FIXTURES = [
    {
        "id": "attached_highlight_no_tool",
        "user_text": "What does this passage mean?",
        "context_refs": ["highlight:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": True,
        "web_search_available": False,
        "route_intent": "answer_from_attached_context",
        "source_domain": "private_app",
        "allowed_tools": [],
        "internal_tool_sequence": [],
        "query_class": "attached_context",
        "reason": "reader_selection_answerable_from_prompt",
        "expected_first_tool": None,
        "requires_tool": False,
        "attached_context_answerable": True,
    },
    {
        "id": "referenced_media_exact_read",
        "user_text": "Read the exact quote from this source.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": "media:11111111-1111-1111-1111-111111111111",
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_exact_read",
        "source_domain": "private_app",
        "allowed_tools": ["read_resource", "inspect_resource"],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "exact_saved_source_read",
        "expected_first_tool": "read_resource",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "inspect_then_read",
        "user_text": "Inspect the document structure before answering.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_inspect_then_read",
        "source_domain": "private_app",
        "allowed_tools": ["inspect_resource", "read_resource", "app_search"],
        "internal_tool_sequence": [],
        "query_class": "multi_hop_search_read_inspect_question",
        "reason": "document_structure_question",
        "expected_first_tool": "inspect_resource",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "broad_saved_synthesis",
        "user_text": "Compare themes across my saved sources.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "cross_document_synthesis",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "absence_saved_sources",
        "user_text": "Do any saved sources mention the missing term?",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "negative_absence_question",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "public_word_private_sources",
        "user_text": "Compare my saved notes about public health.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "cross_document_synthesis",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "news_word_private_sources",
        "user_text": "What do my saved sources say about news coverage?",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "saved_web_articles_are_private",
        "user_text": "Search my saved web articles for transformer timelines.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "library_web_clip_is_private",
        "user_text": "Find the library web clip about retrieval budgets.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "global_library_question",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "saved_online_source_is_private",
        "user_text": "What does my saved online source say about reranking?",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "public_web_current",
        "user_text": "Search the web for AI news.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "public_web_search",
        "source_domain": "public_web",
        "allowed_tools": ["web_search"],
        "internal_tool_sequence": [],
        "query_class": "recency_or_conversation_question",
        "reason": "public_outside_source_question",
        "expected_first_tool": "web_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "public_web_deictic_without_anchor_clarifies",
        "user_text": "Search the web for this.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "clarify_scope",
        "source_domain": "none",
        "allowed_tools": [],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "ambiguous_deictic_without_subject",
        "expected_first_tool": None,
        "requires_tool": False,
        "attached_context_answerable": False,
    },
    {
        "id": "current_web_deictic_without_anchor_clarifies",
        "user_text": "Check this against current web sources.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "clarify_scope",
        "source_domain": "none",
        "allowed_tools": [],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "ambiguous_deictic_without_subject",
        "expected_first_tool": None,
        "requires_tool": False,
        "attached_context_answerable": False,
    },
    {
        "id": "public_web_with_attached_context",
        "user_text": "Search the web for AI news.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "public_web_search",
        "source_domain": "public_web",
        "allowed_tools": ["web_search"],
        "internal_tool_sequence": [],
        "query_class": "recency_or_conversation_question",
        "reason": "public_outside_source_question",
        "expected_first_tool": "web_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "bare_current_events",
        "user_text": "What happened today?",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "public_web_search",
        "source_domain": "public_web",
        "allowed_tools": ["web_search"],
        "internal_tool_sequence": [],
        "query_class": "recency_or_conversation_question",
        "reason": "public_outside_source_question",
        "expected_first_tool": "web_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "explicit_saved_web_comparison",
        "user_text": "Compare my saved notes against web news.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "explicit_private_public_comparison",
        "source_domain": "mixed",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource", "web_search"],
        "internal_tool_sequence": [],
        "query_class": "cross_document_synthesis",
        "reason": "explicit_saved_source_web_comparison",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "explicit_saved_online_sources_comparison",
        "user_text": "Compare my saved sources with online sources.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": True,
        "route_intent": "explicit_private_public_comparison",
        "source_domain": "mixed",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource", "web_search"],
        "internal_tool_sequence": [],
        "query_class": "cross_document_synthesis",
        "reason": "explicit_saved_source_web_comparison",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "ambiguous_deictic",
        "user_text": "What about this?",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "clarify_scope",
        "source_domain": "none",
        "allowed_tools": [],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "ambiguous_deictic_without_subject",
        "expected_first_tool": None,
        "requires_tool": False,
        "attached_context_answerable": False,
    },
    {
        "id": "exact_read_without_readable_scope_searches",
        "user_text": "Read the exact quote from the document.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "exact_lookup",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "exact_read_library_scope_searches",
        "user_text": "Read the exact quote from this library.",
        "context_refs": ["library:11111111-1111-1111-1111-111111111111"],
        "subject_ref": "library:11111111-1111-1111-1111-111111111111",
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "global_library_question",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "whole_source_summary",
        "user_text": "Summarize the whole source text.",
        "context_refs": ["media:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_long_context_read",
        "source_domain": "private_app",
        "allowed_tools": ["app_search"],
        "internal_tool_sequence": ["read_resource"],
        "query_class": "single_source_summary",
        "reason": "single_media_whole_source_query",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "whole_source_summary_non_media_scope",
        "user_text": "Summarize the whole source text.",
        "context_refs": ["highlight:11111111-1111-1111-1111-111111111111"],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "global_library_question",
        "reason": "default_private_search_or_context",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
    {
        "id": "multi_hop_private_deep",
        "user_text": "Trace the multi hop connection across sources.",
        "context_refs": [],
        "subject_ref": None,
        "reader_selection_present": False,
        "web_search_available": False,
        "route_intent": "private_deep_retrieval",
        "source_domain": "private_app",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "query_class": "multi_hop_search_read_inspect_question",
        "reason": "multi_hop_saved_source_question",
        "expected_first_tool": "app_search",
        "requires_tool": True,
        "attached_context_answerable": False,
    },
]


@pytest.mark.parametrize(
    "case",
    PLANNER_EVAL_FIXTURES,
    ids=[str(case["id"]) for case in PLANNER_EVAL_FIXTURES],
)
def test_chat_retrieval_plan_fixture_matrix(case: dict[str, object]) -> None:
    plan = plan_chat_retrieval(
        user_text=str(case["user_text"]),
        context_ref_uris=list(case["context_refs"]),
        subject_ref=case["subject_ref"] if isinstance(case["subject_ref"], str) else None,
        reader_selection_present=case["reader_selection_present"] is True,
        web_search_available=case["web_search_available"] is True,
    )

    search_scope_uris = set(list(case["context_refs"]))
    if isinstance(case["subject_ref"], str):
        search_scope_uris.add(case["subject_ref"])
    allowed_tools = list(case["allowed_tools"])
    internal_tool_sequence = list(case["internal_tool_sequence"])
    assert plan.as_json() == {
        "version": PLAN_VERSION,
        "route_intent": case["route_intent"],
        "source_domain": case["source_domain"],
        "mixing_policy": (
            "explicit_mixed"
            if case["source_domain"] == "mixed"
            else "no_retrieval"
            if case["source_domain"] == "none"
            else "single_domain"
        ),
        "query_class": case["query_class"],
        "allowed_tools": allowed_tools,
        "blocked_tools": [tool for tool in CHAT_TOOL_NAMES if tool not in allowed_tools],
        "candidate_tool_sequence": allowed_tools,
        "internal_tool_sequence": internal_tool_sequence,
        "reason": case["reason"],
        "context_ref_count": len(list(case["context_refs"])),
        "search_scope_count": len(search_scope_uris),
        "search_scope_uris": sorted(search_scope_uris),
        "budget_policy": "tool_output_budget_from_prompt_assembly",
    }


def test_chat_retrieval_plan_eval_report() -> None:
    results = []
    started = time.perf_counter()
    for case in PLANNER_EVAL_FIXTURES:
        case_start = time.perf_counter()
        plan = plan_chat_retrieval(
            user_text=str(case["user_text"]),
            context_ref_uris=list(case["context_refs"]),
            subject_ref=case["subject_ref"] if isinstance(case["subject_ref"], str) else None,
            reader_selection_present=case["reader_selection_present"] is True,
            web_search_available=case["web_search_available"] is True,
        )
        latency_ms = round((time.perf_counter() - case_start) * 1000, 4)
        TrustRetrievalPlanOut.model_validate(plan.as_json())
        expected_allowed = set(case["allowed_tools"])
        expected_forbidden = set(CHAT_TOOL_NAMES) - expected_allowed
        results.append(
            {
                "id": case["id"],
                "route_ok": plan.route_intent == case["route_intent"],
                "forbidden_false_positive_count": len(set(plan.allowed_tools) & expected_forbidden),
                "forbidden_count": len(expected_forbidden),
                "unnecessary_tool": (
                    bool(plan.allowed_tools) if case["attached_context_answerable"] else False
                ),
                "missed_retrieval": case["requires_tool"] is True and not plan.allowed_tools,
                "first_tool_ok": (
                    plan.candidate_tool_sequence[0] if plan.candidate_tool_sequence else None
                )
                == case["expected_first_tool"],
                "blocked_tool_precision_ok": set(plan.blocked_tools) >= expected_forbidden,
                "trust_trail_complete": set(plan.as_json())
                == {
                    "version",
                    "route_intent",
                    "source_domain",
                    "mixing_policy",
                    "query_class",
                    "allowed_tools",
                    "blocked_tools",
                    "candidate_tool_sequence",
                    "internal_tool_sequence",
                    "reason",
                    "context_ref_count",
                    "search_scope_count",
                    "search_scope_uris",
                    "budget_policy",
                },
                "latency_ms": latency_ms,
            }
        )

    report = {
        "fixture_count": len(results),
        "route_accuracy": round(sum(1 for item in results if item["route_ok"]) / len(results), 4),
        "forbidden_tool_false_positive_rate": 0.0
        if sum(int(item["forbidden_count"]) for item in results) == 0
        else round(
            sum(int(item["forbidden_false_positive_count"]) for item in results)
            / sum(int(item["forbidden_count"]) for item in results),
            4,
        ),
        "unnecessary_tool_rate": round(
            sum(1 for item in results if item["unnecessary_tool"]) / len(results), 4
        ),
        "missed_retrieval_rate": round(
            sum(1 for item in results if item["missed_retrieval"]) / len(results), 4
        ),
        "first_tool_accuracy": round(
            sum(1 for item in results if item["first_tool_ok"]) / len(results), 4
        ),
        "blocked_tool_precision": round(
            sum(1 for item in results if item["blocked_tool_precision_ok"]) / len(results), 4
        ),
        "trust_trail_completeness": round(
            sum(1 for item in results if item["trust_trail_complete"]) / len(results), 4
        ),
        "max_latency_ms": max(float(item["latency_ms"]) for item in results),
        "suite_latency_ms": round((time.perf_counter() - started) * 1000, 4),
        "results": results,
    }

    assert report["route_accuracy"] == 1.0, report
    assert report["forbidden_tool_false_positive_rate"] == 0.0, report
    assert report["unnecessary_tool_rate"] == 0.0, report
    assert report["missed_retrieval_rate"] == 0.0, report
    assert report["first_tool_accuracy"] == 1.0, report
    assert report["blocked_tool_precision"] == 1.0, report
    assert report["trust_trail_completeness"] == 1.0, report
    assert report["max_latency_ms"] < 10, report


def test_chat_retrieval_plan_tool_policy_is_closed() -> None:
    plan = plan_chat_retrieval(
        user_text="Search my saved notes.",
        context_ref_uris=[],
        subject_ref=None,
        reader_selection_present=False,
        web_search_available=False,
    )

    assert set(plan.allowed_tools).isdisjoint(plan.blocked_tools)
    assert set(plan.allowed_tools) | set(plan.blocked_tools) == set(CHAT_TOOL_NAMES)


def test_chat_retrieval_plan_rejects_unknown_vocabulary() -> None:
    with pytest.raises(AssertionError, match="unknown retrieval route_intent"):
        ChatRetrievalPlan(
            route_intent="maybe_search",
            source_domain="private_app",
            mixing_policy="single_domain",
            query_class="exact_lookup",
            allowed_tools=("app_search",),
            blocked_tools=("web_search", "read_resource", "inspect_resource"),
            candidate_tool_sequence=("app_search",),
            internal_tool_sequence=(),
            reason="test",
            context_ref_count=0,
            search_scope_count=0,
        )


def test_chat_retrieval_plan_rejects_open_reason_text() -> None:
    with pytest.raises(AssertionError, match="reason must be a closed snake_case code"):
        ChatRetrievalPlan(
            route_intent="private_app_search",
            source_domain="private_app",
            mixing_policy="single_domain",
            query_class="exact_lookup",
            allowed_tools=("app_search", "inspect_resource", "read_resource"),
            blocked_tools=("web_search",),
            candidate_tool_sequence=("app_search", "inspect_resource", "read_resource"),
            internal_tool_sequence=(),
            reason='bad"reason',
            context_ref_count=0,
            search_scope_count=0,
        )


def test_chat_retrieval_plan_prompt_note_escapes_attribute_values() -> None:
    plan = plan_chat_retrieval(
        user_text="Search my saved notes.",
        context_ref_uris=[],
        subject_ref=None,
        reader_selection_present=False,
        web_search_available=False,
    )

    assert 'reason="default_private_search_or_context"' in plan.prompt_note()
    assert 'allowed_tools="app_search, inspect_resource, read_resource"' in plan.prompt_note()


def test_chat_retrieval_plan_rejects_incoherent_no_source_policy() -> None:
    with pytest.raises(AssertionError, match="none source_domain requires no_retrieval"):
        ChatRetrievalPlan(
            route_intent="no_retrieval",
            source_domain="none",
            mixing_policy="single_domain",
            query_class="no_retrieval",
            allowed_tools=(),
            blocked_tools=CHAT_TOOL_NAMES,
            candidate_tool_sequence=(),
            internal_tool_sequence=(),
            reason="test",
            context_ref_count=0,
            search_scope_count=0,
        )


def test_chat_retrieval_plan_rejects_incoherent_route_policy() -> None:
    with pytest.raises(AssertionError, match="retrieval plan route policy is incoherent"):
        ChatRetrievalPlan(
            route_intent="private_deep_retrieval",
            source_domain="private_app",
            mixing_policy="single_domain",
            query_class="multi_hop_search_read_inspect_question",
            allowed_tools=("web_search",),
            blocked_tools=("app_search", "read_resource", "inspect_resource"),
            candidate_tool_sequence=("web_search",),
            internal_tool_sequence=(),
            reason="test",
            context_ref_count=0,
            search_scope_count=0,
        )


def test_trust_retrieval_plan_out_rejects_incoherent_no_source_policy() -> None:
    with pytest.raises(ValueError, match="none source_domain requires no_retrieval"):
        TrustRetrievalPlanOut.model_validate(
            {
                "version": PLAN_VERSION,
                "route_intent": "no_retrieval",
                "source_domain": "none",
                "mixing_policy": "single_domain",
                "query_class": "no_retrieval",
                "allowed_tools": [],
                "blocked_tools": list(CHAT_TOOL_NAMES),
                "candidate_tool_sequence": [],
                "internal_tool_sequence": [],
                "reason": "test",
                "context_ref_count": 0,
                "search_scope_count": 0,
                "search_scope_uris": [],
                "budget_policy": "tool_output_budget_from_prompt_assembly",
            }
        )


def test_trust_retrieval_plan_out_rejects_incoherent_route_policy() -> None:
    with pytest.raises(ValueError, match="retrieval plan route policy is incoherent"):
        TrustRetrievalPlanOut.model_validate(
            {
                "version": PLAN_VERSION,
                "route_intent": "private_deep_retrieval",
                "source_domain": "private_app",
                "mixing_policy": "single_domain",
                "query_class": "multi_hop_search_read_inspect_question",
                "allowed_tools": ["web_search"],
                "blocked_tools": ["app_search", "read_resource", "inspect_resource"],
                "candidate_tool_sequence": ["web_search"],
                "internal_tool_sequence": [],
                "reason": "test",
                "context_ref_count": 0,
                "search_scope_count": 0,
                "search_scope_uris": [],
                "budget_policy": "tool_output_budget_from_prompt_assembly",
            }
        )


def test_trust_retrieval_plan_out_rejects_open_tool_policy() -> None:
    with pytest.raises(ValueError, match="retrieval plan tool policy is not closed"):
        TrustRetrievalPlanOut.model_validate(
            {
                "version": PLAN_VERSION,
                "route_intent": "private_app_search",
                "source_domain": "private_app",
                "mixing_policy": "single_domain",
                "query_class": "exact_lookup",
                "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
                "blocked_tools": [],
                "candidate_tool_sequence": ["app_search", "inspect_resource", "read_resource"],
                "internal_tool_sequence": [],
                "reason": "test",
                "context_ref_count": 0,
                "search_scope_count": 0,
                "search_scope_uris": [],
                "budget_policy": "tool_output_budget_from_prompt_assembly",
            }
        )
