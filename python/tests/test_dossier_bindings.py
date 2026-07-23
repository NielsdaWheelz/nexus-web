"""Focused closed-contract tests for the seven Dossier bindings."""

import pytest
from provider_runtime.schema import parse_canonical_schema

from nexus.services.artifacts.bindings import BINDINGS
from nexus.services.artifacts.bindings._notes_shared import CONNECTION_SCHEMES
from nexus.services.artifacts.dossier_types import SubjectContributor, SubjectResource
from nexus.services.artifacts.subject_policy import SUBJECT_POLICIES

pytestmark = pytest.mark.unit


def test_binding_and_policy_registries_are_closed_and_aligned() -> None:
    expected = {
        "media": ("dossier_media", "balanced", "medium"),
        "conversation": ("dossier_conversation", "balanced", "medium"),
        "library": ("dossier_library", "balanced", "high"),
        "podcast": ("dossier_podcast", "balanced", "high"),
        "contributor": ("dossier_contributor", "balanced", "high"),
        "page": ("dossier_page", "fast", "low"),
        "note_block": ("dossier_note", "fast", "low"),
    }
    assert set(BINDINGS) == set(SUBJECT_POLICIES) == set(expected)
    for scheme, (operation, profile, reasoning) in expected.items():
        binding = BINDINGS[scheme]
        assert binding.subject_scheme == scheme
        assert binding.llm_operation == operation
        assert binding.profile == profile
        assert binding.reasoning == reasoning
        assert SUBJECT_POLICIES[scheme].subject_scheme == scheme


def test_every_generated_schema_is_provider_runtime_canonical() -> None:
    for binding in BINDINGS.values():
        parse_canonical_schema(binding.schema.model_json_schema())


def test_every_subject_policy_owns_its_route_handle_decoder() -> None:
    identifier = "11111111-1111-4111-8111-111111111111"
    for scheme, policy in SUBJECT_POLICIES.items():
        locator = policy.decode_locator("jane-doe" if scheme == "contributor" else identifier)
        if scheme == "contributor":
            assert isinstance(locator, SubjectContributor)
            assert locator.handle == "jane-doe"
        else:
            assert isinstance(locator, SubjectResource)
            assert locator.ref.scheme == scheme


def test_page_note_connection_scope_explicitly_excludes_artifacts() -> None:
    assert "artifact" not in CONNECTION_SCHEMES
    assert "artifact_revision" not in CONNECTION_SCHEMES
    assert {"media", "page", "note_block"} <= set(CONNECTION_SCHEMES)
