"""Closed non-chat generation adapter portfolio."""

from __future__ import annotations

from collections.abc import Callable
from importlib.util import find_spec
from typing import TYPE_CHECKING
from uuid import UUID

import pytest

if TYPE_CHECKING:
    from nexus.services.codex_generation_contract import GenerationCommand, GenerationTerminal

_GENERATION_ID = UUID("13825d92-5b95-5e1c-8d0f-a4176006b41d")
_FORBIDDEN_POLICY_KEYS = frozenset(
    {
        "backend",
        "max_output_tokens",
        "model",
        "model_name",
        "provider",
        "reasoning",
        "reasoning_effort",
        "retry",
    }
)


def _require_cutover_adapters() -> None:
    assert find_spec("nexus.services.generation_policy") is not None, (
        "Codex Personal generation adapters are absent"
    )


def _metadata_command() -> GenerationCommand:
    from nexus.tasks import enrich_metadata

    return enrich_metadata._metadata_generation_command(
        generation_id=_GENERATION_ID,
        input="A bounded metadata source.",
    )


def _media_command() -> GenerationCommand:
    from nexus.services import media_intelligence

    return media_intelligence._media_unit_command(
        generation_id=_GENERATION_ID,
        user_content="A bounded media evidence packet.",
    )


def _synapse_command() -> GenerationCommand:
    from nexus.services import synapse

    return synapse._synapse_command(
        generation_id=_GENERATION_ID,
        user_content="A bounded resonance candidate packet.",
    )


def _dawn_command() -> GenerationCommand:
    from nexus.services import dawn_write

    return dawn_write._dawn_write_command(
        generation_id=_GENERATION_ID,
        user_content="A bounded morning signal packet.",
    )


def _oracle_command() -> GenerationCommand:
    from nexus.services import oracle

    return oracle._oracle_command(
        generation_id=_GENERATION_ID,
        user_content="A bounded grounded oracle packet.",
    )


def _dossier_command(operation: str) -> GenerationCommand:
    from nexus.services.artifacts.generation_step import build_artifact_generation_step
    from nexus.services.artifacts.registry import dossier_registration

    subject_scheme = operation.removeprefix("dossier_")
    if subject_scheme == "note":
        subject_scheme = "note_block"
    registration = dossier_registration(subject_scheme)
    assert registration is not None
    binding = registration.binding
    assert binding.llm_operation == operation
    return build_artifact_generation_step(
        path="synthesis",
        build_id=_GENERATION_ID,
        binding=binding,
        collected=object(),
        witness=object(),
        system_prompt=binding.system_prompt,
        user_content="A bounded dossier evidence packet.",
    ).command


def _idea_resolve_command() -> GenerationCommand:
    from nexus.services.artifacts import engine

    return engine._idea_resolution_command(
        generation_id=_GENERATION_ID,
        system_prompt="Resolve one phrase to one exact Idea identity.",
        user_content="A bounded Idea candidate packet.",
    )


_COMMANDS: dict[str, Callable[[], GenerationCommand]] = {
    "metadata_enrichment": _metadata_command,
    "media_summary": _media_command,
    "synapse": _synapse_command,
    "dawn_write": _dawn_command,
    "oracle": _oracle_command,
    **{
        operation: lambda operation=operation: _dossier_command(operation)
        for operation in (
            "dossier_page",
            "dossier_note",
            "dossier_media",
            "dossier_conversation",
            "dossier_library",
            "dossier_podcast",
            "dossier_contributor",
            "dossier_idea",
        )
    },
    "dossier_idea_resolve": _idea_resolve_command,
}


def _all_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value).union(*(_all_keys(item) for item in value.values()), set())
    if isinstance(value, list):
        return set().union(*(_all_keys(item) for item in value), set())
    return set()


@pytest.mark.parametrize("operation", sorted(_COMMANDS))
def test_non_chat_operation_owns_content_but_cannot_choose_runtime_policy(operation: str) -> None:
    _require_cutover_adapters()
    from nexus.services import generation_policy
    from nexus.services.codex_generation_contract import request_fingerprint

    command = _COMMANDS[operation]()
    policy = generation_policy.operation_policy(operation)

    assert command.operation.kind == operation
    assert command.operation.revision == policy.revision
    assert command.policy_revision == generation_policy.POLICY_REVISION
    assert command.policy_fingerprint == generation_policy.POLICY_FINGERPRINT
    assert command.tool_grant is None
    assert request_fingerprint(command) == request_fingerprint(_COMMANDS[operation]())
    assert not (_all_keys(command.model_dump(mode="json")) & _FORBIDDEN_POLICY_KEYS)


def test_non_chat_operation_portfolio_is_exactly_the_policy_catalog() -> None:
    _require_cutover_adapters()
    from nexus.services import generation_policy

    assert set(_COMMANDS) == set(generation_policy.OPERATIONS)


def test_metadata_job_result_does_not_duplicate_generation_policy_facts() -> None:
    _require_cutover_adapters()
    from nexus.tasks import enrich_metadata

    assert enrich_metadata._job_result(enrich_metadata._success_result(["title"])) == {
        "status": "success",
        "fields": ["title"],
    }, "metadata job result duplicated generation policy facts"


def _successful_structured_terminal(payload: dict[str, object]) -> GenerationTerminal:
    from nexus.services.codex_generation_contract import GenerationSessionRef, GenerationTerminal

    return GenerationTerminal.model_validate(
        {
            "status": "succeeded",
            "failure": None,
            "final_text": "structured result",
            "structured_output": payload,
            "session_ref": GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id="thread-operation-adapter-proof",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            ),
            "usage": None,
            "diagnostics": [],
            "accepted_at": "2026-08-24T12:34:56.123456Z",
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
        }
    )


def test_grounded_adapters_override_host_success_when_an_index_was_not_offered() -> None:
    _require_cutover_adapters()
    from nexus.services import media_intelligence, synapse
    from nexus.services.resource_graph.refs import ResourceRef

    media_terminal = media_intelligence._encode_media_unit_terminal(
        _successful_structured_terminal(
            {
                "summary_md": "Bounded summary.",
                "claims": [{"claim_text": "Unsupported claim.", "candidate_index": 1}],
            }
        ),
        candidates=[
            media_intelligence._Candidate(
                evidence_span_id=UUID("4db166e8-3b0d-5ce1-b091-890f7ec0e6da"),
                text="Only candidate zero was offered.",
            )
        ],
    )
    synapse_terminal = synapse._encode_synapse_terminal(
        _successful_structured_terminal(
            {
                "connections": [
                    {
                        "candidate_index": 1,
                        "kind": "context",
                        "rationale": "This references an absent candidate.",
                    }
                ]
            }
        ),
        candidates=[
            synapse._SynapseCandidate(
                target=ResourceRef(
                    scheme="note_block",
                    id=UUID("dcf5659b-b854-5f44-b63f-280c6e6e1b2f"),
                ),
                label="Only candidate zero",
                snippet="Only candidate zero was offered.",
            )
        ],
    )

    assert media_terminal.accepted_failure is not None
    assert media_terminal.accepted_failure.code == "invalid_output"
    assert synapse_terminal.accepted_failure is not None
    assert synapse_terminal.accepted_failure.code == "invalid_output"
