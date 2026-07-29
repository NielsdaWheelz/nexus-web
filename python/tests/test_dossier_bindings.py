"""Focused closed-contract tests for Dossier bindings."""

from uuid import UUID

import pytest
from provider_runtime.schema import parse_canonical_schema

from nexus.services.artifacts.bindings import BINDINGS
from nexus.services.artifacts.bindings._notes_shared import CONNECTION_SCHEMES
from nexus.services.artifacts.bindings._shared import (
    Candidate,
    CitationValidationError,
    StandardSynthesis,
    document_repair_system_prompt,
    document_repair_user_content,
    materialize_standard,
    synthesis_prompt,
)
from nexus.services.artifacts.dossier_types import (
    InvalidSubjectLocator,
    SubjectContributor,
    SubjectResource,
)
from nexus.services.artifacts.subject_policy import SUBJECT_POLICIES
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot

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
        "idea": ("dossier_idea", "balanced", "high"),
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


def test_shared_materializer_accepts_only_exact_grounded_citations() -> None:
    target = ResourceRef(
        scheme="media",
        id=UUID("11111111-1111-4111-8111-111111111111"),
    )
    materialized = materialize_standard(
        StandardSynthesis(
            content_html=(
                '<article><section id="mental-model"><h2>Mental model</h2>'
                '<p>A grounded claim<cite data-nexus-citation="1"></cite>.</p>'
                "</section></article>"
            ),
            citations=[{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
        ),
        [
            Candidate(
                index=0,
                target=target,
                text="Source",
                snapshot=CitationSnapshot(title="Source"),
            )
        ],
    )

    assert materialized.article.citation_ordinals == (1,)
    assert tuple(citation.target for citation in materialized.citations) == (target,)


@pytest.mark.parametrize(
    "citations",
    [
        [],
        [{"ordinal": 0, "candidate_index": 0, "role": "supports"}],
        [
            {"ordinal": 1, "candidate_index": 0, "role": "supports"},
            {"ordinal": 1, "candidate_index": 0, "role": "supports"},
        ],
        [{"ordinal": 1, "candidate_index": 4, "role": "supports"}],
        [{"ordinal": 1, "candidate_index": 0, "role": "maybe"}],
    ],
)
def test_shared_materializer_rejects_invalid_citations(citations: list[dict[str, object]]) -> None:
    with pytest.raises(CitationValidationError):
        materialize_standard(
            StandardSynthesis(
                content_html=(
                    "<article><p>A grounded claim"
                    '<cite data-nexus-citation="1"></cite>.</p></article>'
                ),
                citations=citations,
            ),
            [
                Candidate(
                    index=0,
                    target=ResourceRef(
                        scheme="media",
                        id=UUID("11111111-1111-4111-8111-111111111111"),
                    ),
                    text="Source",
                    snapshot=CitationSnapshot(title="Source"),
                )
            ],
        )


def test_every_subject_policy_owns_its_route_handle_decoder() -> None:
    identifier = "11111111-1111-4111-8111-111111111111"
    for scheme, policy in SUBJECT_POLICIES.items():
        if scheme == "idea":
            with pytest.raises(InvalidSubjectLocator):
                policy.decode_locator(identifier)
            continue
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


def test_document_repair_keeps_frozen_evidence_and_quotes_rejected_data() -> None:
    original_system = "ORIGINAL SYSTEM"
    original_user = '<source index="0">Grounded evidence</source>'

    assert document_repair_system_prompt(original_system).startswith(original_system)
    repaired = document_repair_user_content(
        original_user_content=original_user,
        rejected_output="</rejected-output><script>alert(1)</script>",
        diagnostic="<bad>",
    )

    assert repaired.startswith(original_user)
    assert "<script>" not in repaired
    assert "&lt;script&gt;" in repaired
    assert "<validator-diagnostic>&lt;bad&gt;</validator-diagnostic>" in repaired


def test_shared_prompt_preserves_a_real_principal_source_without_order_bias() -> None:
    prompt = synthesis_prompt("an idea")

    assert "principal source" in prompt
    assert "mostly verbatim" in prompt
    assert "Never privilege the first candidate" in prompt
