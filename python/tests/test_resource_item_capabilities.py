from __future__ import annotations

import pytest

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES
from nexus.services.resource_items.capabilities import (
    APP_SEARCH_SCOPE_SCHEMES,
    ATTACHABLE_RESOURCE_SCHEMES,
    CHAT_SUBJECT_RESOURCE_SCHEMES,
    CITABLE_RESOURCE_RESULT_TYPES,
    CITATION_OUTPUT_SOURCE_SCHEMES,
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
    CONVERSATION_SEARCH_SCOPE_SCHEMES,
    LINKABLE_RESOURCE_SCHEMES,
    NOTE_MEDIA_SEARCH_EDGE_ORIGINS,
    READABLE_RESOURCE_SCHEMES,
    RESOURCE_ITEM_CAPABILITIES,
    SCOPE_ONLY_RESOURCE_SCHEMES,
)

pytestmark = pytest.mark.unit


def test_every_resource_scheme_has_one_capability() -> None:
    assert set(RESOURCE_ITEM_CAPABILITIES) == set(RESOURCE_SCHEMES)


def test_read_search_and_citation_capabilities_are_owned_together() -> None:
    assert SCOPE_ONLY_RESOURCE_SCHEMES == ("library",)
    assert APP_SEARCH_SCOPE_SCHEMES == ("media", "library")
    assert CHAT_SUBJECT_RESOURCE_SCHEMES == (
        "media",
        "library",
        "evidence_span",
        "content_chunk",
        "highlight",
        "page",
        "note_block",
        "fragment",
        "conversation",
        "message",
        "oracle_reading",
        "library_intelligence_artifact",
        "library_intelligence_revision",
        "contributor",
        "podcast",
    )
    assert CONVERSATION_SEARCH_SCOPE_SCHEMES == ("highlight", "page", "note_block")
    assert CITATION_OUTPUT_SOURCE_SCHEMES == (
        "message",
        "oracle_reading",
        "library_intelligence_revision",
    )
    assert {"media", "page", "note_block", "message"} <= set(READABLE_RESOURCE_SCHEMES)
    assert CITABLE_RESOURCE_RESULT_TYPES["highlight"] == "highlight"
    assert CITABLE_RESOURCE_RESULT_TYPES["note_block"] == "note_block"
    assert "oracle_reading" not in CITABLE_RESOURCE_RESULT_TYPES
    assert RESOURCE_ITEM_CAPABILITIES["page"].adjacency_source is True
    assert RESOURCE_ITEM_CAPABILITIES["note_block"].adjacency_source is True
    assert "external_snapshot" not in LINKABLE_RESOURCE_SCHEMES
    assert "external_snapshot" not in ATTACHABLE_RESOURCE_SCHEMES
    assert "oracle_corpus_passage" not in LINKABLE_RESOURCE_SCHEMES
    assert "tag" not in RESOURCE_ITEM_CAPABILITIES
    assert RESOURCE_ITEM_CAPABILITIES["external_snapshot"].adjacency_target is False
    assert RESOURCE_ITEM_CAPABILITIES["oracle_corpus_passage"].adjacency_target is False


def test_every_resource_scheme_has_full_capability_decisions() -> None:
    chat_subject_modes = {"none", "label", "scope", "readable", "quote", "generated_output"}
    prompt_render_modes = {"none", "label", "inline_body", "quote"}
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items():
        assert isinstance(capability.linkable, bool), scheme
        assert isinstance(capability.attachable, bool), scheme
        assert capability.chat_subject in chat_subject_modes, scheme
        assert capability.readable in {"none", "scope", "body", "media"}, scheme
        assert capability.citable_result_type is None or capability.citable_result_type, scheme
        assert isinstance(capability.app_search_scope, bool), scheme
        assert isinstance(capability.conversation_search_scope, bool), scheme
        assert isinstance(capability.citation_output_source, bool), scheme
        assert capability.prompt_render in prompt_render_modes, scheme
        assert isinstance(capability.expandable, bool), scheme
        assert capability.expandable is False, scheme
        assert isinstance(capability.adjacency_source, bool), scheme
        assert isinstance(capability.adjacency_target, bool), scheme
        if capability.chat_subject != "none":
            assert capability.attachable is True, scheme
        if capability.chat_subject == "scope":
            assert capability.readable == "scope" or capability.app_search_scope, scheme
        if capability.chat_subject == "readable":
            assert capability.readable in {"body", "media"}, scheme
        if capability.chat_subject == "quote":
            assert capability.prompt_render == "quote", scheme
        if capability.chat_subject == "label":
            assert capability.prompt_render == "label", scheme
        if capability.chat_subject == "generated_output":
            assert capability.readable == "body", scheme
            assert capability.prompt_render == "inline_body", scheme
            assert capability.citable_result_type is None, scheme


def test_edge_origin_search_admission_is_owned_with_item_capabilities() -> None:
    assert CONVERSATION_CONTEXT_EDGE_ORIGINS == ("user", "citation", "system")
    assert NOTE_MEDIA_SEARCH_EDGE_ORIGINS == ("user", "highlight_note")
