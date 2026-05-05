"""Tests for structured chat retrieval planning."""

import pytest
from llm_calling.types import Turn

from nexus.errors import ApiError
from nexus.services.retrieval_planner import (
    APP_SEARCH_TYPES_ALL,
    APP_SEARCH_TYPES_SCOPED,
    app_search_scope_for_conversation,
    build_retrieval_plan,
)

pytestmark = pytest.mark.unit


def test_general_scope_can_plan_all_app_search():
    plan = build_retrieval_plan(
        user_content="Find my notes about transformers",
        history=[],
        scope_metadata={"type": "general"},
        web_search_options={"mode": "off"},
    )

    assert plan.app_search.enabled is True
    assert plan.app_search.scope == "all"
    assert plan.app_search.types == APP_SEARCH_TYPES_ALL
    assert plan.web_search.enabled is False


def test_media_scope_never_expands_outside_media_scope():
    media_id = "11111111-1111-1111-1111-111111111111"
    plan = build_retrieval_plan(
        user_content="What did it say about attention?",
        history=[],
        scope_metadata={"type": "media", "media_id": media_id, "title": "Attention Paper"},
        web_search_options={"mode": "auto"},
    )

    assert plan.app_search.enabled is True
    assert plan.app_search.scope == f"media:{media_id}"
    assert plan.app_search.types == APP_SEARCH_TYPES_SCOPED
    assert "Attention Paper" in (plan.app_search.query or "")
    assert plan.web_search.enabled is False


def test_library_scope_never_includes_message_search():
    library_id = "22222222-2222-2222-2222-222222222222"
    scope = {"type": "library", "library_id": library_id, "title": "Research"}

    assert app_search_scope_for_conversation(scope) == f"library:{library_id}"
    plan = build_retrieval_plan(
        user_content="Compare saved sources",
        history=[],
        scope_metadata=scope,
    )

    assert "message" not in plan.app_search.types


def test_contributor_conversation_scope_is_not_planned_until_persistable():
    with pytest.raises(ApiError):
        app_search_scope_for_conversation(
            {"type": "contributor", "contributor_handle": "octavia-butler"}
        )


def test_attached_contributor_context_adds_app_search_filter():
    plan = build_retrieval_plan(
        user_content="Find related saved work",
        history=[],
        scope_metadata={"type": "general"},
        attached_context_refs=[
            {"type": "contributor", "id": "octavia-butler"},
            {"type": "contributor", "contributor_handle": "octavia-butler"},
        ],
    )

    assert plan.app_search.filters["contributor_handles"] == ["octavia-butler"]


def test_followup_query_uses_recent_user_turn():
    plan = build_retrieval_plan(
        user_content="What about that?",
        history=[
            Turn(role="user", content="Find sources about retrieval augmented generation"),
            Turn(role="assistant", content="I found a few."),
        ],
        scope_metadata={"type": "general"},
    )

    assert plan.app_search.query is not None
    assert "retrieval augmented generation" in plan.app_search.query


def test_web_search_required_and_memory_lookup_plans_are_structured():
    source_ref = {
        "type": "message_retrieval",
        "retrieval_id": "33333333-3333-3333-3333-333333333333",
    }
    plan = build_retrieval_plan(
        user_content="Verify the latest API documentation",
        history=[],
        scope_metadata={"type": "general"},
        memory_source_refs=[source_ref, source_ref],
        web_search_options={"mode": "required"},
    )

    assert plan.web_search.enabled is True
    assert len(plan.context_lookup) == 1
    assert plan.context_lookup[0].source_ref == source_ref
