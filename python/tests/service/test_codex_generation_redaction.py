"""Failure-retention proof for the Codex generation host boundary."""

from pathlib import Path
from uuid import UUID

from apps.codex_agent.host import RuntimeVersions, _terminal_to_wire
from provider_runtime.agent_runtime import AgentFailure, AgentSessionRef, AgentTerminal

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    MetadataEnrichmentOperation,
)
from nexus.services.codex_generation_operations import resolve_codex_generation
from nexus.services.generation_intent import GenerationIntent, TextOutput

_RAW_TEXT = "raw runtime failure text must not cross the host boundary"
_RAW_DIAGNOSTIC = "raw runtime diagnostic must not cross the host boundary"


def test_failed_runtime_terminal_retains_only_the_bounded_host_diagnostic(
    tmp_path: Path,
) -> None:
    policy = generation_policy.operation_policy("metadata_enrichment")
    command = GenerationCommand(
        request_id=UUID(int=1),
        operation=MetadataEnrichmentOperation(revision=policy.revision),
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=GenerationIntent(
            instructions="extract metadata",
            input="bounded source",
            output=TextOutput(),
        ),
    )
    operation = resolve_codex_generation(
        command,
        working_directory=tmp_path,
        mcp_origin=None,
        tool_credential=None,
    )
    terminal = AgentTerminal(
        status="failed",
        failure=AgentFailure("backend_failed"),
        final_text=_RAW_TEXT,
        structured_output=None,
        session_ref=AgentSessionRef(
            schema_version="agent-session-ref.v1",
            backend="codex",
            transport="sdk",
            native_session_id="thread-redaction",
            profile_key="codex-personal",
            state_root_fingerprint="1" * 64,
            cwd_fingerprint="2" * 64,
        ),
        diagnostics=(_RAW_DIAGNOSTIC,),
    )

    wire = _terminal_to_wire(
        terminal,
        operation=operation,
        accepted_at="2026-08-25T12:34:56.123456Z",
        versions=RuntimeVersions(sdk="0.144.4", runtime="0.144.4"),
    )
    encoded = wire.model_dump_json()

    assert (
        wire.status == "failed"
        and wire.failure is not None
        and wire.failure.kind == "backend_failed"
        and wire.final_text == ""
        and wire.diagnostics
        == ("codex generation host turn_stream: runtime terminal backend_failed",)
        and _RAW_TEXT not in encoded
        and _RAW_DIAGNOSTIC not in encoded
    ), "runtime diagnostic content crossed a retention boundary"
