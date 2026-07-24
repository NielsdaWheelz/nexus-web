from __future__ import annotations

from typing import cast
from uuid import uuid4

import pytest

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_items.capabilities import (
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
    NOTE_MEDIA_SEARCH_EDGE_ORIGINS,
    RESOURCE_ITEM_CAPABILITIES,
    app_search_scope_hint,
    app_search_scope_schemes,
    capability_for_scheme,
    citation_output_source_schemes,
    conversation_search_scope_schemes,
    expandable_resource_schemes,
    resource_can_attach,
    resource_can_be_app_search_scope,
    resource_can_be_chat_subject,
    resource_can_be_note_reference_target,
    resource_can_be_ordered_adjacency_target,
    resource_can_link_source,
    resource_can_link_target,
    resource_can_own_ordered_adjacency,
    resource_citation_result_type,
    resource_expansion_policy,
    resource_inspect_policy,
    resource_prompt_render_policy,
    resource_read_policy,
    resource_user_link_target_mode,
)

pytestmark = pytest.mark.unit


def _ref(scheme: str) -> ResourceRef:
    return ResourceRef(scheme=cast(ResourceScheme, scheme), id=uuid4())


def test_every_resource_scheme_has_one_capability() -> None:
    assert set(RESOURCE_ITEM_CAPABILITIES) == set(RESOURCE_SCHEMES)
    for scheme in RESOURCE_SCHEMES:
        assert capability_for_scheme(scheme) is RESOURCE_ITEM_CAPABILITIES[scheme]


def test_every_resource_scheme_has_the_exact_share_mode() -> None:
    expected = {
        "media": "ResourceGrants",
        "highlight": "HighlightGrants",
        "library": "LibraryMembership",
        "podcast": "CopyWithLibraryFiling",
        "page": "CopyOnly",
        "note_block": "CopyOnly",
        "conversation": "CopyOnly",
        "oracle_reading": "CopyOnly",
        "artifact": "CopyOnly",
        "contributor": "CopyOnly",
    }
    assert {
        scheme: capability.sharing
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.sharing != "None"
    } == expected


def test_read_search_and_citation_capabilities_are_owned_together() -> None:
    assert resource_read_policy(_ref("library")) == "scope"
    assert app_search_scope_schemes() == ("media", "library")
    assert app_search_scope_hint() == "media:UUID, library:UUID"
    assert tuple(
        scheme for scheme in RESOURCE_SCHEMES if resource_can_be_chat_subject(_ref(scheme))
    ) == (
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
        "artifact",
        "artifact_revision",
        "contributor",
        "podcast",
        "reader_apparatus_item",
        "passage_anchor",
    )
    assert conversation_search_scope_schemes() == ("highlight", "page", "note_block")
    assert citation_output_source_schemes() == (
        "message",
        "oracle_reading",
        "artifact_revision",
    )
    readable = {
        scheme
        for scheme in RESOURCE_SCHEMES
        if resource_read_policy(_ref(scheme)) in {"body", "media"}
    }
    assert {"media", "page", "note_block", "message"} <= readable
    assert resource_citation_result_type(_ref("highlight")) == "highlight"
    assert resource_citation_result_type(_ref("note_block")) == "note_block"
    assert resource_citation_result_type(_ref("reader_apparatus_item")) == ("reader_apparatus_item")
    assert resource_citation_result_type(_ref("oracle_reading")) is None
    assert resource_can_own_ordered_adjacency(_ref("page")) is True
    assert resource_can_own_ordered_adjacency(_ref("note_block")) is True
    assert resource_can_link_source(_ref("external_snapshot")) is False
    assert resource_can_link_target(_ref("external_snapshot")) is False
    assert resource_can_attach(_ref("external_snapshot")) is False
    # oracle_passage_anchor is passage-candidate-only: raw material a search hit
    # must materialize into a passage_anchor before it can be a durable endpoint
    # (Invariant 4) — it is neither a direct Link source nor target.
    assert resource_can_link_source(_ref("oracle_passage_anchor")) is False
    assert resource_can_link_target(_ref("oracle_passage_anchor")) is False
    assert resource_user_link_target_mode(_ref("oracle_passage_anchor")) == "materialize_passage"
    assert resource_can_attach(_ref("oracle_passage_anchor")) is False
    # passage_anchor is the direct, durable, user-owned Link endpoint that
    # materialization converts passage candidates into.
    assert resource_can_link_source(_ref("passage_anchor")) is True
    assert resource_can_link_target(_ref("passage_anchor")) is True
    assert resource_user_link_target_mode(_ref("passage_anchor")) == "direct"
    assert resource_can_be_note_reference_target(_ref("passage_anchor")) is True
    assert resource_can_be_note_reference_target(_ref("oracle_passage_anchor")) is False
    assert "tag" not in RESOURCE_ITEM_CAPABILITIES
    assert resource_can_be_ordered_adjacency_target(_ref("external_snapshot")) is False
    assert resource_can_be_ordered_adjacency_target(_ref("oracle_passage_anchor")) is True
    assert resource_inspect_policy(_ref("media")) == "media_document_map"
    assert resource_inspect_policy(_ref("highlight")) == "none"
    assert resource_prompt_render_policy(_ref("highlight")) == "quote"
    assert resource_can_be_app_search_scope(_ref("media")) is True
    assert expandable_resource_schemes() == (
        "media",
        "page",
        "note_block",
        "artifact",
    )
    assert resource_expansion_policy(_ref("media")) == "media_owned_reader_children"


def test_every_resource_scheme_has_full_capability_decisions() -> None:
    chat_subject_modes = {"none", "label", "scope", "readable", "quote", "generated_output"}
    inspect_modes = {"none", "media_document_map"}
    prompt_render_modes = {"none", "label", "inline_body", "quote"}
    expansion_modes = {
        "none",
        "media_owned_reader_children",
        "page_note_blocks",
        "note_block_owned_evidence",
        "artifact_revisions",
    }
    user_link_target_modes = {"none", "direct", "materialize_passage"}
    share_modes = {
        "None",
        "CopyOnly",
        "CopyWithLibraryFiling",
        "ResourceGrants",
        "HighlightGrants",
        "LibraryMembership",
    }
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items():
        assert capability.sharing in share_modes, scheme
        assert isinstance(capability.user_relation.user_link_source, bool), scheme
        assert capability.user_relation.user_link_target in user_link_target_modes, scheme
        assert capability.user_relation.note_reference_target is (
            capability.user_relation.user_link_target == "direct"
        ), scheme
        assert isinstance(capability.attachable, bool), scheme
        assert capability.chat_subject in chat_subject_modes, scheme
        assert capability.readable in {"none", "scope", "body", "media"}, scheme
        assert capability.inspectable in inspect_modes, scheme
        assert capability.citable_result_type is None or capability.citable_result_type, scheme
        assert isinstance(capability.app_search_scope, bool), scheme
        assert isinstance(capability.conversation_search_scope, bool), scheme
        assert isinstance(capability.citation_output_source, bool), scheme
        assert capability.prompt_render in prompt_render_modes, scheme
        assert capability.expansion_policy in expansion_modes, scheme
        assert isinstance(capability.expandable, bool), scheme
        assert capability.expandable is (capability.expansion_policy != "none"), scheme
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
        if capability.inspectable != "none":
            assert capability.readable == "media", scheme


def test_derived_capability_aliases_are_absent() -> None:
    from nexus.services.resource_items import capabilities

    for name in (
        "READABLE_RESOURCE_SCHEMES",
        "SCOPE_ONLY_RESOURCE_SCHEMES",
        "APP_SEARCH_SCOPE_SCHEMES",
        "CONVERSATION_SEARCH_SCOPE_SCHEMES",
        "CITABLE_RESOURCE_RESULT_TYPES",
        "CITATION_OUTPUT_SOURCE_SCHEMES",
        "LINKABLE_RESOURCE_SCHEMES",
        "ATTACHABLE_RESOURCE_SCHEMES",
        "CHAT_SUBJECT_RESOURCE_SCHEMES",
    ):
        assert not hasattr(capabilities, name), name


def test_edge_origin_search_admission_is_owned_with_item_capabilities() -> None:
    assert CONVERSATION_CONTEXT_EDGE_ORIGINS == ("user", "citation", "system")
    assert NOTE_MEDIA_SEARCH_EDGE_ORIGINS == ("user", "highlight_note")
