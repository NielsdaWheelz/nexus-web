"""Closed-wire proof for the metadata-only native-agent boundary."""

from __future__ import annotations

import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.services.native_agent_contract import (
    METADATA_ENRICHMENT_MAX_INPUT_BYTES,
    NativeAgentCapacityRejection,
    NativeAgentFrame,
    NativeAgentHealth,
    NativeAgentTerminal,
)
from nexus.services.native_agent_operations import (
    METADATA_ENRICHMENT_OPERATION_REVISION,
    build_metadata_enrichment_command,
    metadata_enrichment_operation_facts,
)

REQUEST_ID = UUID("755a2de9-2bdc-5c57-a6a0-17a2407f14bb")


def _successful_terminal() -> dict[str, object]:
    return {
        "kind": "terminal",
        "status": "succeeded",
        "failure": None,
        "final_text": '{"title":"The Left Hand of Darkness"}',
        "structured_output": {
            "title": "The Left Hand of Darkness",
            "authors": ["Ursula K. Le Guin"],
            "publisher": None,
            "description": None,
            "published_date": "1969",
            "language": "en",
        },
        "session_ref": {
            "schema_version": "agent-session-ref.v1",
            "backend": "codex",
            "transport": "sdk",
            "native_session_id": "thread-metadata-1",
            "profile_key": "codex-personal",
            "state_root_fingerprint": "1" * 64,
            "cwd_fingerprint": "2" * 64,
        },
        "usage": {
            "input_tokens": 100,
            "output_tokens": 40,
            "total_tokens": 140,
            "reasoning_tokens": 10,
            "cache_read_input_tokens": None,
            "cache_write_input_tokens": None,
        },
        "diagnostics": [],
        "sdk_version": "0.144.4",
        "runtime_version": "0.144.4",
    }


def test_metadata_command_and_terminal_round_trip_only_the_closed_revision() -> None:
    assert METADATA_ENRICHMENT_OPERATION_REVISION == "metadata-enrichment.2026-08-12.4"
    facts = metadata_enrichment_operation_facts()
    assert facts.transport_deadline_seconds == 255.0
    command = build_metadata_enrichment_command(
        request_id=REQUEST_ID,
        input="Known metadata and a bounded content sample.",
    )
    decoded_command = type(command).model_validate_json(command.model_dump_json())
    assert decoded_command == command
    assert decoded_command.operation.model_dump() == {
        "kind": "metadata_enrichment",
        "revision": METADATA_ENRICHMENT_OPERATION_REVISION,
        "input": "Known metadata and a bounded content sample.",
    }

    frame = NativeAgentFrame.model_validate(
        {
            "schema_version": "nexus-agent-event.v1",
            "request_id": str(REQUEST_ID),
            "sequence": 0,
            "event": _successful_terminal(),
        }
    )
    decoded_frame = NativeAgentFrame.model_validate_json(frame.model_dump_json())
    assert decoded_frame == frame
    assert isinstance(decoded_frame.event, NativeAgentTerminal)
    assert decoded_frame.event.structured_output["language"] == "en"

    command_payload = command.model_dump(mode="json")
    command_payload["unexpected"] = True
    with pytest.raises(ValidationError, match="extra_forbidden"):
        type(command).model_validate(command_payload)

    drifted_operation = command.model_dump(mode="json")
    drifted_operation["operation"]["revision"] = "metadata-enrichment.v999"
    with pytest.raises(ValidationError, match="literal_error"):
        type(command).model_validate(drifted_operation)

    assert METADATA_ENRICHMENT_MAX_INPUT_BYTES == 32_768
    oversized = command.model_dump(mode="json")
    oversized["operation"]["input"] = "n" * (METADATA_ENRICHMENT_MAX_INPUT_BYTES + 1)
    with pytest.raises(ValidationError, match="UTF-8 bytes"):
        type(command).model_validate(oversized)


def test_event_union_carries_no_freeform_payload_channels() -> None:
    """Risk: a payload side channel reappears on tool or native events."""

    for event in (
        {
            "kind": "tool_use",
            "tool_call_id": "tool-1",
            "name": "commandExecution",
            "phase": "started",
            "payload": {"command": "must not cross the boundary"},
        },
        {
            "kind": "native",
            "native_type": "codex/thread.started",
            "payload": {"detail": "must not cross the boundary"},
        },
    ):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            NativeAgentFrame.model_validate(
                {
                    "schema_version": "nexus-agent-event.v1",
                    "request_id": str(REQUEST_ID),
                    "sequence": 0,
                    "event": event,
                }
            )


def test_event_union_rejects_unknown_kinds_and_invalid_terminal_states() -> None:
    frame = {
        "schema_version": "nexus-agent-event.v1",
        "request_id": str(REQUEST_ID),
        "sequence": 0,
        "event": {"kind": "reasoning", "text": "not in the wire union"},
    }
    with pytest.raises(ValidationError, match="union_tag_invalid"):
        NativeAgentFrame.model_validate(frame)

    succeeded_without_output = _successful_terminal()
    succeeded_without_output["structured_output"] = None
    frame["event"] = succeeded_without_output
    with pytest.raises(ValidationError, match="successful metadata terminal"):
        NativeAgentFrame.model_validate(frame)

    failed_without_failure = _successful_terminal()
    failed_without_failure.update({"status": "failed", "failure": None, "structured_output": None})
    frame["event"] = failed_without_failure
    with pytest.raises(ValidationError, match="failed terminal"):
        NativeAgentFrame.model_validate(frame)

    silent_failure = _successful_terminal()
    silent_failure.update(
        {
            "status": "failed",
            "failure": {"kind": "backend_failed"},
            "structured_output": None,
            "diagnostics": [],
        }
    )
    frame["event"] = silent_failure
    with pytest.raises(ValidationError, match="at least one diagnostic"):
        NativeAgentFrame.model_validate(frame)

    silent_cancellation = _successful_terminal()
    silent_cancellation.update(
        {
            "status": "cancelled",
            "failure": None,
            "structured_output": None,
            "diagnostics": [],
        }
    )
    frame["event"] = silent_cancellation
    with pytest.raises(ValidationError, match="at least one diagnostic"):
        NativeAgentFrame.model_validate(frame)

    failed_with_legacy_collapsed_reason = _successful_terminal()
    failed_with_legacy_collapsed_reason.update(
        {
            "status": "failed",
            "failure": {"kind": "turn_not_started"},
            "structured_output": None,
        }
    )
    frame["event"] = failed_with_legacy_collapsed_reason
    with pytest.raises(ValidationError, match="literal_error"):
        NativeAgentFrame.model_validate(frame)


def test_capacity_rejection_is_one_exact_closed_pre_accept_shape() -> None:
    rejection = NativeAgentCapacityRejection.model_validate_json(
        '{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}'
    )
    assert rejection.model_dump(mode="json") == {
        "schema_version": "nexus-agent-rejection.v1",
        "kind": "capacity_unavailable",
    }

    for drift in (
        {"schema_version": "nexus-agent-rejection.v2", "kind": "capacity_unavailable"},
        {"schema_version": "nexus-agent-rejection.v1", "kind": "busy"},
        {
            "schema_version": "nexus-agent-rejection.v1",
            "kind": "capacity_unavailable",
            "detail": "private host pressure must not cross the wire",
        },
    ):
        with pytest.raises(ValidationError):
            NativeAgentCapacityRejection.model_validate(drift)


def test_wire_decoders_require_every_tag_the_exact_body_names() -> None:
    """Risk: constructor defaults let a decoded body omit its schema or kind tag.

    §6 recognizes capacity only on the exact body; a `{}` that decodes to the
    rejection, or a command, frame, or health body without its tag, would be
    accepted as the closed shape it never stated.
    """

    for body in (
        "{}",
        '{"kind":"capacity_unavailable"}',
        '{"schema_version":"nexus-agent-rejection.v1"}',
    ):
        with pytest.raises(ValidationError, match="wire tags are required"):
            NativeAgentCapacityRejection.model_validate_json(body)
    with pytest.raises(ValidationError, match="wire tags are required"):
        NativeAgentHealth.model_validate_json('{"status":"ready"}')

    command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
    untagged_command = command.model_dump(mode="json")
    del untagged_command["schema_version"]
    with pytest.raises(ValidationError, match="wire tags are required"):
        type(command).model_validate_json(json.dumps(untagged_command))
    untagged_operation = command.model_dump(mode="json")
    del untagged_operation["operation"]["kind"]
    with pytest.raises(ValidationError):
        type(command).model_validate_json(json.dumps(untagged_operation))

    frame = {
        "request_id": str(REQUEST_ID),
        "sequence": 0,
        "event": _successful_terminal(),
    }
    with pytest.raises(ValidationError, match="wire tags are required"):
        NativeAgentFrame.model_validate_json(json.dumps(frame))
    frame["schema_version"] = "nexus-agent-event.v1"
    del frame["event"]["kind"]
    with pytest.raises(ValidationError):
        NativeAgentFrame.model_validate_json(json.dumps(frame))

    # In-process authors still spell only the fields that vary.
    assert NativeAgentCapacityRejection().kind == "capacity_unavailable"
