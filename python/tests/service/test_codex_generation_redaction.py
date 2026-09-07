"""Failure-retention proof for the Codex generation host boundary."""

from __future__ import annotations

from importlib.util import find_spec
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from apps.codex_agent.host import RuntimeVersions, _terminal_to_wire
    from provider_runtime.agent_runtime import AgentFailure, AgentSessionRef, AgentTerminal

    from nexus.services.codex_generation_operations import (
        CodexModelToolPlanRegistry,
        resolve_codex_generation,
    )
    from tests.testkit.codex_generation import codex_generation_command

_RAW_TEXT = "raw runtime failure text must not cross the host boundary"
_RAW_DIAGNOSTIC = "raw runtime diagnostic must not cross the host boundary"


def test_failed_runtime_terminal_retains_only_the_bounded_host_diagnostic(
    tmp_path: Path,
) -> None:
    assert _CUTOVER_PRESENT, "the bounded Codex generation host cutover is absent"
    command = codex_generation_command(
        request_id=UUID(int=1),
        operation="metadata_enrichment",
        instructions="extract metadata",
        input_text="bounded source",
        model="gpt-5.6-luna",
        reasoning="low",
        turn_timeout_seconds=120,
    )
    operation = resolve_codex_generation(
        command,
        working_directory=tmp_path,
        model_tool_registry=CodexModelToolPlanRegistry(()),
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
