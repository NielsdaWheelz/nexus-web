"""Tests for the (post-cutover) retrieval planner.

Per spec §5.4, the planner no longer branches on web-search mode and no longer
gates retrieval on conversation scope. Tool registration is universal:
``app_search`` is selected by query cues; ``web_search`` is always available
to the model (the planner does not decide whether it runs). This file
exercises only the contracts that still apply.
"""

import pytest
from llm_calling.types import Turn

from nexus.services.retrieval_planner import (
    APP_SEARCH_TYPES_ALL,
    build_retrieval_plan,
)

pytestmark = pytest.mark.unit


def test_planner_does_not_branch_on_web_search():
    """Smoke test: the planner builds a plan regardless of any web-search
    consideration. Both ``app_search`` and ``web_search`` are always available
    to the model; the planner only decides whether to PRE-FETCH ``app_search``
    (a per-query heuristic), never whether ``web_search`` is allowed."""
    plan = build_retrieval_plan(
        user_content="Verify the latest API documentation",
        history=[],
        attached_context_refs=[],
        memory_source_refs=[],
    )

    # app_search is enabled when the user content contains a search cue or is
    # long enough to merit a pre-fetch. No web-search flag participates.
    assert plan.app_search.enabled is True
    assert plan.app_search.types == APP_SEARCH_TYPES_ALL


def test_planner_uses_app_search_cue_words():
    plan = build_retrieval_plan(
        user_content="Find my notes about transformers",
        history=[],
    )

    assert plan.app_search.enabled is True
    assert "find" not in (plan.app_search.query or "").lower(), (
        f"Search cue prefix should be stripped from the query, got: {plan.app_search.query}"
    )


def test_planner_short_chat_disables_app_search():
    """Short non-search messages do not pre-fetch (e.g., 'hi', 'thanks')."""
    plan = build_retrieval_plan(
        user_content="hi",
        history=[],
    )

    assert plan.app_search.enabled is False


def test_planner_followup_query_uses_recent_user_turn():
    plan = build_retrieval_plan(
        user_content="What about that?",
        history=[
            Turn(role="user", content="Find sources about retrieval augmented generation"),
            Turn(role="assistant", content="I found a few."),
        ],
    )

    assert plan.app_search.query is not None
    assert "retrieval augmented generation" in plan.app_search.query


def test_planner_attached_contributor_context_adds_app_search_filter():
    plan = build_retrieval_plan(
        user_content="Find related saved work",
        history=[],
        attached_context_refs=[
            {"type": "contributor", "id": "octavia-butler"},
            {"type": "contributor", "contributor_handle": "octavia-butler"},
        ],
    )

    assert plan.app_search.filters["contributor_handles"] == ["octavia-butler"]


def test_planner_attached_reader_selection_seeds_query_when_cue_present():
    """A reader_selection seeds the app_search query when cues trigger
    app_search. The reader_selection alone does not auto-enable app_search;
    the user content must still contain a cue or be long enough."""
    plan = build_retrieval_plan(
        user_content="Find related work in my library to this quote.",
        history=[],
        attached_context_refs=[
            {
                "kind": "reader_selection",
                "client_context_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "media_id": "11111111-1111-1111-1111-111111111111",
                "media_title": "Attention Paper",
                "media_kind": "pdf",
                "exact": "scaled dot product attention quote",
                "source_version": "pdf-source:v1",
                "locator": {"kind": "pdf_text_quote", "page_number": 3},
            }
        ],
    )

    assert plan.app_search.enabled is True
    assert "scaled dot product attention quote" in (plan.app_search.query or "")
