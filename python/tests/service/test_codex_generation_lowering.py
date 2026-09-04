"""Frozen catalog and model-tool lowering proof for Codex generations."""

from __future__ import annotations

from importlib.util import find_spec
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime.agent_runtime import (
        AgentToolUse,
        CodexCatalogSessionRequest,
        CredentialRef,
    )
    from provider_runtime.agent_runtime.tool_projection import (
        CanonicalMcpToolObservation,
        RejectedMcpToolObservation,
    )

    from nexus.schemas.presence import Absent, Present
    from nexus.services.codex_generation_operations import (
        MODEL_TOOL_MCP_SERVER_NAME,
        CodexModelToolPlanRegistry,
        model_tool_allowed_tools,
        resolve_codex_generation,
    )
    from nexus.services.tool_runtime.composition import (
        FrozenToolOperation,
        freeze_tool_plan_snapshot,
    )
    from tests.testkit.codex_generation import (
        codex_generation_command,
        codex_model_tool_fixture,
    )

_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"


def _registry() -> tuple[CodexModelToolPlanRegistry, FrozenToolOperation]:
    registry, runtime = codex_model_tool_fixture()
    return registry, runtime.operations["ChatRead"]


def test_frozen_spec_lowers_catalog_identity_and_exact_mcp_aliases(tmp_path: Path) -> None:
    """Risk: a worker re-resolves policy/model facts or publishes raw dotted tool ids."""

    assert _CUTOVER_PRESENT, "the frozen Codex generation lowering cutover is absent"
    registry, read_operation = _registry()
    synthesis_command = codex_generation_command(
        request_id=UUID(int=1),
        operation="metadata_enrichment",
        instructions="follow the bounded contract",
        input_text="bounded input",
        model="gpt-5.6-luna",
        reasoning="low",
        turn_timeout_seconds=120,
    )
    synthesis = resolve_codex_generation(
        synthesis_command,
        working_directory=tmp_path,
        model_tool_registry=registry,
        mcp_origin=None,
        tool_credential=None,
    )
    assert isinstance(synthesis.model_tool_plan_snapshot, Absent)
    assert synthesis.published_model_tools is None
    assert isinstance(synthesis.session, CodexCatalogSessionRequest)
    assert synthesis.session.model_key == "gpt-5.6-luna"
    assert synthesis.session.reasoning == "low"
    assert synthesis.session.agent_definition_revision == "2" * 64
    assert synthesis.session.row_fingerprint == "1" * 64
    assert synthesis.session.policy.filesystem == "read_only"
    assert synthesis.session.policy.network == "disabled"
    assert synthesis.session.mcp_servers == ()
    assert synthesis.session.native is not None
    assert synthesis.session.native.web_search is False
    assert synthesis.session.native.builtin_tools == "disabled"

    snapshot = freeze_tool_plan_snapshot(read_operation)
    chat_command = codex_generation_command(
        request_id=UUID(int=2),
        operation="chat",
        instructions="follow the bounded contract",
        input_text="bounded chat input",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=900,
        model_tool_plan=snapshot,
        tool_grant="run-scoped-test-grant",
    )
    tool_credential = CredentialRef(
        kind="secret_reference",
        profile_key="codex-personal",
        name="run-grant-reference",
    )
    chat = resolve_codex_generation(
        chat_command,
        working_directory=tmp_path,
        model_tool_registry=registry,
        mcp_origin=_MCP_ORIGIN,
        tool_credential=tool_credential,
    )
    assert isinstance(chat.model_tool_plan_snapshot, Present)
    assert chat.session.model_key == "gpt-5.6-terra"
    assert chat.session.reasoning == "medium"
    assert chat.session.policy.filesystem == "workspace_write"
    assert chat.session.policy.network == "unrestricted"
    assert chat.session.native is not None
    assert chat.session.native.web_search is False
    assert chat.session.native.builtin_tools == "disabled"
    assert len(chat.session.mcp_servers) == 1
    server = chat.session.mcp_servers[0]
    assert server.name == MODEL_TOOL_MCP_SERVER_NAME
    assert server.url == _MCP_ORIGIN
    assert server.required is True
    canonical_ids = model_tool_allowed_tools(snapshot)
    assert server.allowed_tools == tuple(tool.replace(".", "__") for tool in canonical_ids)
    assert server.denied_tools == ()
    assert chat.published_model_tools is not None
    observed = chat.published_model_tools.observe(
        AgentToolUse(
            tool_call_id="tool-1",
            name=f"{MODEL_TOOL_MCP_SERVER_NAME}/{server.allowed_tools[0]}",
            phase="completed",
            succeeded=True,
        )
    )
    assert isinstance(observed, CanonicalMcpToolObservation)
    assert str(observed.tool_id) == canonical_ids[0]
    rejected = chat.published_model_tools.observe(
        AgentToolUse(
            tool_call_id="tool-2",
            name=f"{MODEL_TOOL_MCP_SERVER_NAME}/nexus__admin__delete",
            phase="started",
        )
    )
    assert isinstance(rejected, RejectedMcpToolObservation)


def test_frozen_model_tool_snapshot_must_match_the_host_projection(tmp_path: Path) -> None:
    """Risk: a stale plan revision silently gains the host's current tool surface."""

    assert _CUTOVER_PRESENT, "the frozen Codex generation lowering cutover is absent"
    registry, read_operation = _registry()
    snapshot = freeze_tool_plan_snapshot(read_operation).model_copy(
        update={"plan_revision": "f" * 64}
    )
    command = codex_generation_command(
        request_id=UUID(int=3),
        operation="chat",
        instructions="follow the bounded contract",
        input_text="bounded chat input",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=900,
        model_tool_plan=snapshot,
        tool_grant="run-scoped-test-grant",
    )
    credential = CredentialRef(
        kind="secret_reference",
        profile_key="codex-personal",
        name="run-grant-reference",
    )
    try:
        resolve_codex_generation(
            command,
            working_directory=tmp_path,
            model_tool_registry=registry,
            mcp_origin=_MCP_ORIGIN,
            tool_credential=credential,
        )
    except ValueError as error:
        assert "unavailable" in str(error)
    else:
        raise AssertionError("stale frozen ModelTools revision reached Codex lowering")
