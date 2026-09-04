"""RED proofs for the shared Codex synthesis and product error contracts."""

from __future__ import annotations

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from nexus.schemas.llm import ExpectedChatFailure
from nexus.services.codex_generation_contract import GenerationTerminal
from nexus.services.generation_intent import GenerationIntent, JsonSchemaOutput
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)


class _Answer(BaseModel):
    answer: str


def _terminal(
    *,
    status: str = "succeeded",
    structured_output: dict[str, object] | None = None,
    failure: dict[str, str] | None = None,
) -> GenerationTerminal:
    return GenerationTerminal.model_validate(
        {
            "kind": "terminal",
            "status": status,
            "failure": failure,
            "final_text": "",
            "structured_output": structured_output,
            "session_ref": (
                {
                    "schema_version": "agent-session-ref.v1",
                    "backend": "codex",
                    "transport": "sdk",
                    "native_session_id": "session-1",
                    "profile_key": "codex-personal",
                    "state_root_fingerprint": "1" * 64,
                    "cwd_fingerprint": "2" * 64,
                }
                if status == "succeeded"
                else None
            ),
            "usage": None,
            "diagnostics": [] if status == "succeeded" else ["failed"],
            "accepted_at": "2026-08-24T12:34:56.123456Z",
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
        }
    )


def test_structured_synthesis_builds_the_new_provider_free_intent() -> None:
    intent = build_synthesis_intent(
        system_prompt="system",
        user_content="candidates",
        schema=_Answer,
    )

    assert isinstance(intent, GenerationIntent)
    assert intent.instructions == "system"
    assert intent.input == "candidates"
    assert isinstance(intent.output, JsonSchemaOutput)
    assert intent.output.strict is True
    assert "max_output_tokens" not in repr(intent)


def test_structured_synthesis_decodes_terminal_json_and_semantic_failures() -> None:
    value = decode_structured_synthesis(
        _terminal(structured_output={"answer": "ok"}),
        schema=_Answer,
    )
    assert value.answer == "ok"

    with pytest.raises(StructuredSynthesisError, match="does not match"):
        decode_structured_synthesis(
            _terminal(structured_output={"answer": 3}),
            schema=_Answer,
        )

    with pytest.raises(AssertionError, match="non-succeeded terminal"):
        decode_structured_synthesis(
            _terminal(status="failed", failure={"kind": "credential_unavailable"}),
            schema=_Answer,
        )


def test_synthesis_failure_facts_use_the_closed_generation_taxonomy() -> None:
    assert outcome_failure_facts(
        _terminal(status="failed", failure={"kind": "credential_unavailable"})
    ) == ("auth", "codex generation failed: credential_unavailable")
    assert outcome_failure_facts(_terminal(status="cancelled")) == ("cancelled", None)


def test_chat_failure_union_is_the_closed_post_cutover_card_set() -> None:
    adapter = TypeAdapter(ExpectedChatFailure)
    assert adapter.validate_python({"code": "cancelled", "can_rerun": True}).code == "cancelled"
    assert (
        adapter.validate_python({"code": "assistant_unavailable", "can_rerun": True}).code
        == "assistant_unavailable"
    )
    assert adapter.validate_python({"code": "operator_defect", "can_rerun": False}).code == (
        "operator_defect"
    )

    for obsolete in (
        "refused",
        "budget_exceeded",
        "rate_limited",
        "provider_unavailable",
        "stream_interrupted",
        "invalid_tool_arguments",
        "timeout",
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python({"code": obsolete, "can_rerun": False})
