"""Red proof for the strict app-owned generation command and event algebra."""

from __future__ import annotations

import copy
import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    MAX_COMMAND_BODY_BYTES,
    MAX_OUTPUT_SCHEMA_BYTES,
    MAX_TOOL_GRANT_BYTES,
    GenerationCapacityRejection,
    GenerationCommand,
    GenerationContractDefect,
    GenerationFrame,
    GenerationTerminal,
    normalized_failure,
    request_fingerprint,
)

_POLICY_FINGERPRINT = generation_policy.POLICY_FINGERPRINT
_METADATA_INPUT = "bounded metadata input"
_INSTRUCTIONS = "Return only the requested result."
_TOKEN = "grant-secret-must-never-cross-a-diagnostic"


def _command_payload(
    *,
    operation: str = "metadata_enrichment",
    instructions: str = _INSTRUCTIONS,
    input: str = _METADATA_INPUT,
    output: dict[str, object] | None = None,
    grant: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "nexus-generation-command.v2",
        "request_id": "755a2de9-2bdc-5c57-a6a0-17a2407f14bb",
        "operation": {
            "kind": operation,
            "revision": (
                generation_policy.operation_revision(operation)
                if operation in generation_policy.OPERATIONS
                else "unknown-operation.revision"
            ),
        },
        "policy_revision": generation_policy.POLICY_REVISION,
        "policy_fingerprint": _POLICY_FINGERPRINT,
        "intent": {
            "instructions": instructions,
            "input": input,
            "output": output or {"kind": "Text"},
        },
    }
    if grant is not None:
        payload["tool_grant"] = {"kind": "Bearer", "token": grant}
    return payload


def _chat_payload(*, grant: str | None = _TOKEN) -> dict[str, object]:
    payload = _command_payload(
        operation="metadata_enrichment", input="<user>hello</user>", grant=grant
    )
    payload["operation"] = {
        "kind": "chat",
        "profile": "balanced",
        "revision": generation_policy.operation_revision("chat", profile="balanced"),
    }
    return payload


def test_generation_command_round_trips_only_the_closed_v2_shape() -> None:
    command = GenerationCommand.model_validate(_command_payload())
    assert command.model_dump(mode="json", exclude_none=True) == _command_payload()
    assert command.intent.output.kind == "Text"

    structured = copy.deepcopy(_command_payload())
    structured["intent"]["output"] = {
        "kind": "JsonSchema",
        "name": "answer",
        "schema": {"type": "object", "properties": {"answer": {"type": "string"}}},
        "strict": True,
    }
    decoded = GenerationCommand.model_validate(structured)
    assert decoded.intent.output.kind == "JsonSchema"
    assert decoded.intent.output.strict is True

    structured["intent"]["output"]["strict"] = False
    with pytest.raises(ValidationError):
        GenerationCommand.model_validate(structured)

    frame = {
        "schema_version": "nexus-generation-event.v2",
        "request_id": "755a2de9-2bdc-5c57-a6a0-17a2407f14bb",
        "sequence": 0,
        "event": {"kind": "not-a-closed-event"},
    }
    with pytest.raises(ValidationError):
        GenerationFrame.model_validate(frame)

    terminal_with_extra = {
        "kind": "terminal",
        "status": "cancelled",
        "failure": None,
        "final_text": "",
        "structured_output": None,
        "session_ref": None,
        "usage": None,
        "diagnostics": ["cancelled by caller"],
        "accepted_at": "2026-08-24T12:34:56.123456Z",
        "sdk_version": "0.144.4",
        "runtime_version": "0.144.4",
        "unexpected": True,
    }
    with pytest.raises(ValidationError, match="extra_forbidden"):
        GenerationTerminal.model_validate(terminal_with_extra)


def test_command_rejects_policy_revision_or_fingerprint_drift_before_admission() -> None:
    for field, value in (
        ("policy_revision", "codex-generation.drifted"),
        ("policy_fingerprint", "f" * 64),
    ):
        payload = _command_payload()
        payload[field] = value
        with pytest.raises(ValidationError, match="policy"):
            GenerationCommand.model_validate(payload)


def test_command_rejects_provider_controls_unknown_tags_and_unbounded_text() -> None:
    for forbidden in ("model", "provider", "reasoning", "max_output_tokens", "tools", "retry"):
        payload = _command_payload()
        payload["intent"][forbidden] = "must not be app-owned command state"
        with pytest.raises(ValidationError, match="extra_forbidden"):
            GenerationCommand.model_validate(payload)

    unknown_operation = _command_payload(operation="not_a_catalog_operation")
    with pytest.raises(ValidationError):
        GenerationCommand.model_validate(unknown_operation)

    for field in ("instructions", "input"):
        oversized = _command_payload()
        oversized["intent"][field] = "x" * (32 * 1024 + 1)
        with pytest.raises(ValidationError, match="bytes"):
            GenerationCommand.model_validate(oversized)

    oversized_chat = _chat_payload()
    oversized_chat["intent"]["input"] = "x" * (512 * 1024 + 1)
    with pytest.raises(ValidationError, match="bytes"):
        GenerationCommand.model_validate(oversized_chat)


def test_chat_operation_is_typed_by_required_profile_and_requires_a_grant() -> None:
    command = GenerationCommand.model_validate(_chat_payload())
    assert command.operation.kind == "chat"
    assert command.operation.profile == "balanced"
    assert command.tool_grant is not None

    missing_profile = _chat_payload()
    del missing_profile["operation"]["profile"]
    with pytest.raises(ValidationError):
        GenerationCommand.model_validate(missing_profile)

    for profile in ("fast", "balanced", "deep"):
        payload = _chat_payload()
        payload["operation"]["profile"] = profile
        payload["operation"]["revision"] = generation_policy.operation_revision(
            "chat", profile=profile
        )
        assert GenerationCommand.model_validate(payload).operation.profile == profile

    without_grant = _chat_payload(grant=None)
    with pytest.raises(ValidationError, match="grant"):
        GenerationCommand.model_validate(without_grant)

    synthesis_with_grant = _command_payload(grant=_TOKEN)
    with pytest.raises(ValidationError, match="grant"):
        GenerationCommand.model_validate(synthesis_with_grant)

    chat_with_schema = _chat_payload()
    chat_with_schema["intent"]["output"] = {
        "kind": "JsonSchema",
        "name": "unsupported",
        "schema": {"type": "object"},
        "strict": True,
    }
    with pytest.raises(ValidationError, match="Text output"):
        GenerationCommand.model_validate(chat_with_schema)


def test_tool_grant_is_secret_like_and_never_enters_repr_dump_or_fingerprint() -> None:
    command = GenerationCommand.model_validate(_chat_payload())
    assert command.tool_grant is not None
    assert _TOKEN not in repr(command)
    assert _TOKEN not in repr(command.tool_grant)
    assert _TOKEN not in json.dumps(command.model_dump(mode="json"), default=str)

    other = GenerationCommand.model_validate(_chat_payload(grant="different-secret"))
    assert request_fingerprint(command) == request_fingerprint(other)


def test_nested_tagged_types_require_their_kind_on_json_wire() -> None:
    payload = _command_payload()
    del payload["intent"]["output"]["kind"]
    with pytest.raises(ValidationError):
        GenerationCommand.model_validate_json(json.dumps(payload))

    chat = _chat_payload()
    del chat["tool_grant"]["kind"]
    with pytest.raises(ValidationError, match="wire tags are required"):
        GenerationCommand.model_validate_json(json.dumps(chat))


def test_terminal_accepted_at_is_utc_rfc3339_with_six_fractional_digits() -> None:
    valid = {
        "kind": "terminal",
        "status": "cancelled",
        "failure": None,
        "final_text": "",
        "structured_output": None,
        "session_ref": None,
        "usage": None,
        "diagnostics": ["cancelled by caller"],
        "accepted_at": "2026-08-24T12:34:56.123456Z",
        "sdk_version": "0.144.4",
        "runtime_version": "0.144.4",
    }
    terminal = GenerationTerminal.model_validate(valid)
    assert terminal.accepted_at == "2026-08-24T12:34:56.123456Z"
    from nexus.services.codex_generation_contract import normalized_outcome

    assert normalized_outcome(terminal) == "Cancelled"

    for invalid in (
        "2026-08-24T12:34:56Z",
        "2026-08-24T12:34:56.123456+00:00",
        "2026-08-24T12:34:56.123456-07:00",
        "2026-08-24T12:34:56.1234567Z",
        "2026-13-99T12:34:56.123456Z",
    ):
        drifted = {**valid, "accepted_at": invalid}
        with pytest.raises(ValidationError):
            GenerationTerminal.model_validate(drifted)

    frame = GenerationFrame(
        request_id=UUID("755a2de9-2bdc-5c57-a6a0-17a2407f14bb"),
        sequence=0,
        event=terminal,
    )
    assert frame.event.accepted_at.endswith("Z")


def test_text_success_has_no_structured_output_and_session_usage_are_typed() -> None:
    session_ref = {
        "schema_version": "agent-session-ref.v1",
        "backend": "codex",
        "transport": "sdk",
        "native_session_id": "thread-1",
        "profile_key": "codex-personal",
        "state_root_fingerprint": "1" * 64,
        "cwd_fingerprint": "2" * 64,
    }
    terminal = GenerationTerminal.model_validate(
        {
            "kind": "terminal",
            "status": "succeeded",
            "failure": None,
            "final_text": "hello",
            "structured_output": None,
            "session_ref": session_ref,
            "usage": {
                "input_tokens": 1,
                "output_tokens": 2,
                "total_tokens": 3,
                "reasoning_tokens": 0,
                "cache_read_input_tokens": 4,
                "cache_write_input_tokens": 5,
            },
            "diagnostics": [],
            "accepted_at": "2026-08-24T12:34:56.123456Z",
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
        }
    )
    assert terminal.session_ref is not None
    assert terminal.session_ref.profile_key == "codex-personal"
    assert terminal.usage is not None
    assert terminal.usage.cache_write_input_tokens == 5


def test_tool_completion_and_permission_tool_name_are_closed() -> None:
    with pytest.raises(ValidationError):
        GenerationFrame.model_validate(
            {
                "schema_version": "nexus-generation-event.v2",
                "request_id": "755a2de9-2bdc-5c57-a6a0-17a2407f14bb",
                "sequence": 0,
                "event": {
                    "kind": "tool_use",
                    "tool_call_id": "tool-1",
                    "name": "workspace_write",
                    "phase": "completed",
                },
            }
        )
    with pytest.raises(ValidationError):
        GenerationFrame.model_validate(
            {
                "schema_version": "nexus-generation-event.v2",
                "request_id": "755a2de9-2bdc-5c57-a6a0-17a2407f14bb",
                "sequence": 0,
                "event": {
                    "kind": "permission_request",
                    "operation": "command",
                    "summary": "must be denied",
                    "tool_name": "workspace_write",
                    "decision": "deny",
                },
            }
        )


def test_health_and_capacity_rejection_are_exact_canonical_contracts() -> None:
    from nexus.services.codex_generation_contract import (
        GenerationHealth,
        capacity_rejection_bytes,
        command_policy,
    )

    health = GenerationHealth(
        policy_revision=generation_policy.POLICY_REVISION,
        sdk_version="0.144.4",
        runtime_version="0.144.4",
    )
    assert (health.backend, health.transport, health.auth_profile) == (
        "codex",
        "sdk",
        "codex-personal",
    )
    assert capacity_rejection_bytes() == (
        b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}'
    )
    assert MAX_COMMAND_BODY_BYTES > 6 * (1024 * 1024 + 32 * 1024)
    assert (
        MAX_COMMAND_BODY_BYTES
        == 6 * (32 * 1024 + 1024 * 1024 + MAX_OUTPUT_SCHEMA_BYTES + MAX_TOOL_GRANT_BYTES) + 4 * 1024
    )
    assert command_policy(GenerationCommand.model_validate(_command_payload())).capability == (
        "Synthesis"
    )
    assert GenerationCapacityRejection.model_validate_json(capacity_rejection_bytes())


def test_command_bounds_schema_and_grant_body_contributors() -> None:
    oversized_schema = _command_payload()
    oversized_schema["intent"]["output"] = {
        "kind": "JsonSchema",
        "name": "answer",
        "schema": {"type": "object", "padding": "x" * MAX_OUTPUT_SCHEMA_BYTES},
        "strict": True,
    }
    with pytest.raises(ValidationError, match="schema bytes"):
        GenerationCommand.model_validate(oversized_schema)

    oversized_grant = _chat_payload(grant="x" * (MAX_TOOL_GRANT_BYTES + 1))
    with pytest.raises(ValidationError, match="grant bytes"):
        GenerationCommand.model_validate(oversized_grant)

    with pytest.raises(ValidationError, match="blank"):
        GenerationCommand.model_validate(_chat_payload(grant="   "))


@pytest.mark.parametrize(
    ("kind", "expected"),
    (
        ("credential_unavailable", "auth"),
        ("credential_rejected", "auth"),
        ("quota_exhausted", "quota"),
        ("turn_timeout", "timeout"),
        ("output_limit_exceeded", "output_limit"),
        ("output_schema_violation", "invalid_output"),
        ("policy_violation", "policy_violation"),
        ("approval_unanswered", "policy_violation"),
        ("executable_unavailable", "runtime_unavailable"),
        ("sdk_unavailable", "runtime_unavailable"),
        ("session_unavailable", "runtime_unavailable"),
        ("backend_failed", "runtime_unavailable"),
        ("capacity_unavailable", "capacity_unavailable"),
    ),
)
def test_host_failure_derives_the_closed_normalized_code(kind: str, expected: str) -> None:
    assert normalized_failure(kind) == expected


@pytest.mark.parametrize("kind", ("invalid_request", "runtime_defect"))
def test_host_defect_failure_never_becomes_a_product_code(kind: str) -> None:
    with pytest.raises(GenerationContractDefect):
        normalized_failure(kind)
