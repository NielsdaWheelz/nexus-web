"""Canonical proof for the generation tool-plan transport boundary."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from typing import Any

import pytest
from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    HandlerSuccess,
    HostTable,
    Native,
    PolicyEpoch,
    ReplayPolicy,
    RunLimits,
    ToolBinding,
    ToolEffect,
    ToolId,
    canonical_json_bytes,
)
from provider_runtime.tool_adapter import CanonicalToolCall
from provider_runtime.types import CanonicalTool, ToolCall

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_READ_IDS = (
    "nexus.search",
    "nexus.resource.read",
    "nexus.document.search",
    "nexus.resource.inspect",
    "nexus.relations.list",
)
_WRITE_IDS = (
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)


async def _unused_handler(value: object, context: object) -> HandlerSuccess[dict[str, object]]:
    del value, context
    return HandlerSuccess(value={}, actual_attempts=0)


def _binding(
    spec: Any,
    *,
    replay_policy: ReplayPolicy,
) -> ToolBinding[Any, Any, Any]:
    return ToolBinding(
        spec=spec,
        execute=Available(_unused_handler),
        replay_policy=replay_policy,
        implementation_revision="test_generation_transport_projection.v1",
        policy_epoch=PolicyEpoch("generation-transport-proof-v1"),
        policy_inputs={"owner": "generation-transport-proof"},
    )


def _content_revision(facts: object) -> str:
    value = facts.json()
    assert isinstance(value, dict)
    revision = value.pop("authority_revision")
    assert isinstance(revision, str)
    assert _SHA256.fullmatch(revision)
    assert hashlib.sha256(canonical_json_bytes(value)).hexdigest() == revision
    return revision


def _provider_wire_bytes(tools: tuple[CanonicalTool, ...]) -> int:
    payload: list[dict[str, object]] = []
    for item in tools:
        name = item.name
        description = item.description
        parameters = item.parameters
        assert isinstance(name, str)
        assert isinstance(description, str)
        assert isinstance(parameters, Mapping)
        payload.append(
            {
                "description": description,
                "name": name,
                "parameters": dict(parameters),
            }
        )
    return len(canonical_json_bytes(payload))


def test_one_plan_lowers_to_both_transport_contracts() -> None:
    """One frozen plan owns API proposals, MCP observation, and no-tools absence."""

    from nexus.services.tool_runtime import profiles

    assert hasattr(profiles, "tool_plan_policy_facts"), (
        "operation-owned generation tool plans are not yet the authority"
    )

    from provider_runtime.agent_runtime import (
        AgentToolUse,
        CredentialRef,
        freeze_json_object,
    )
    from provider_runtime.agent_runtime.tool_projection import (
        CanonicalMcpToolObservation,
        RejectedMcpToolObservation,
    )

    from nexus.services.tool_runtime.composition import (
        compose_tool_runtime,
        freeze_tool_plan_snapshot,
        operation_presented_declarations,
        operation_tool_specs,
        project_codex_model_tools,
        project_provider_model_tools,
    )
    from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS

    assert not hasattr(profiles, "CHAT_TOOL_PROFILE")
    assert not hasattr(profiles, "CHAT_TOOL_PLAN")
    facts = profiles.tool_plan_policy_facts()
    assert tuple(item.plan_id for item in facts) == (
        "ChatRead",
        "ChatReadAdditiveWrite",
        "LibraryDossierRead",
        "IdeaDossierRead",
        "MetadataRead",
    )
    assert len({_content_revision(item) for item in facts}) == 5

    web_binding = _binding(WEB_SEARCH_SPEC, replay_policy=ReplayPolicy.BilledOnce)
    nexus_bindings = tuple(
        _binding(entry.spec, replay_policy=ReplayPolicy.ReDispatchable)
        for entry in NEXUS_TOOL_DECLARATIONS
    )
    runtime = compose_tool_runtime(web_binding, nexus_bindings=nexus_bindings)
    assert tuple(runtime.operations) == (
        "ChatRead",
        "ChatReadAdditiveWrite",
        "LibraryDossierRead",
        "IdeaDossierRead",
        "idea_dossier_research",
        "MetadataRead",
    )
    assert "chat" not in runtime.operations

    expected = {
        "ChatRead": (
            ("web.search", *_READ_IDS),
            RunLimits(64, 128, 4_194_304, 16_777_216, 1, 900.0),
            None,
        ),
        "ChatReadAdditiveWrite": (
            ("web.search", *_READ_IDS, *_WRITE_IDS),
            RunLimits(64, 128, 4_194_304, 16_777_216, 1, 900.0),
            8,
        ),
        "LibraryDossierRead": (
            _READ_IDS,
            RunLimits(16, 0, 262_144, 4_194_304, 1, 120.0),
            None,
        ),
        "IdeaDossierRead": (
            _READ_IDS,
            RunLimits(12, 0, 131_072, 2_097_152, 1, 120.0),
            None,
        ),
        "MetadataRead": (
            ("web.search", "web.read", "nexus.document.search", "nexus.resource.read"),
            RunLimits(8, 64, 262_144, 4_194_304, 1, 120.0),
            None,
        ),
    }
    for plan_id, (tool_ids, run_limits, max_live_writes) in expected.items():
        operation = runtime.operations[plan_id]
        assert isinstance(operation.plan.exposure, Native)
        assert tuple(str(grant.id) for grant in operation.profile.ordered_grants) == tool_ids
        assert operation.profile.run_limits == run_limits
        assert operation.definition.max_live_writes == max_live_writes
        assert _SHA256.fullmatch(operation.profile.profile_revision)
        assert _SHA256.fullmatch(operation.plan.plan_revision)
        specs = operation_tool_specs(operation)
        assert tuple(str(spec.id) for spec in specs) == tool_ids
        presented = operation_presented_declarations(operation)
        assert tuple(entry.spec for entry in presented) == specs
        assert all(entry.activity_label and entry.result_kind for entry in presented)
        write_start = len(tool_ids) - len(_WRITE_IDS)
        for index, spec in enumerate(specs):
            expected_effect = (
                ToolEffect.Write
                if max_live_writes is not None and index >= write_start
                else ToolEffect.Read
            )
            assert spec.effect is expected_effect
            grant = operation.profile.grant(spec.id)
            assert grant.limits == spec.limits
            assert grant.tool_contract_revision == spec.tool_contract_revision
        snapshot = freeze_tool_plan_snapshot(operation)
        assert snapshot.plan_id == plan_id
        assert snapshot.max_live_writes == max_live_writes
        assert snapshot.plan_revision == operation.plan.plan_revision
        assert snapshot.profile_revision == operation.profile.profile_revision

    research = runtime.operations["idea_dossier_research"]
    assert isinstance(research.plan.exposure, HostTable)
    assert tuple(str(grant.id) for grant in research.profile.ordered_grants) == ("web.search",)
    assert research.profile.run_limits == RunLimits(3, 6, 12_288, 98_304, 1, 60.0)

    chat_read = runtime.operations["ChatRead"]
    provider = project_provider_model_tools(chat_read)
    assert provider is not None, "Native model-tool plan lost its provider publication"
    expected_aliases = tuple(value.replace(".", "__") for value in expected["ChatRead"][0])
    assert tuple(tool.name for tool in provider.tools) == expected_aliases
    for tool, spec in zip(provider.tools, operation_tool_specs(chat_read), strict=True):
        assert tool.description == spec.documentation.text
        assert canonical_json_bytes(tool.parameters) == canonical_json_bytes(
            spec.input_schema.presentation
        )
    assert _provider_wire_bytes(provider.tools) <= 12_288

    proposal = provider.decode_tool_call(
        ToolCall(id="provider-call-1", name="nexus__search", arguments={"query": "Ada"})
    )
    assert isinstance(proposal, CanonicalToolCall)
    assert proposal.tool_id == ToolId("nexus.search")

    bearer = CredentialRef(
        kind="secret_reference",
        profile_key="nexus-generation-tools",
        name="attempt-bearer",
    )
    codex = project_codex_model_tools(
        chat_read,
        server_name="nexus",
        url="https://nexus.internal/internal/agent-tools/mcp",
        bearer=bearer,
    )
    assert codex is not None
    assert codex.server.allowed_tools == expected_aliases
    assert codex.server.header_refs[0].source is bearer
    observation = codex.observe(
        AgentToolUse(
            tool_call_id="mcp-call-1",
            name="nexus/nexus__search",
            phase="completed",
            payload=freeze_json_object({"isError": False}),
            succeeded=True,
        )
    )
    assert isinstance(observation, CanonicalMcpToolObservation)
    assert observation.tool_id == proposal.tool_id
    assert observation.tool_call_id != proposal.provider_call_id
    rejected_observation = codex.observe(
        AgentToolUse(
            tool_call_id="mcp-call-2",
            name="nexus/nexus__admin__delete",
            phase="started",
        )
    )
    assert isinstance(rejected_observation, RejectedMcpToolObservation)

    additive_provider = project_provider_model_tools(runtime.operations["ChatReadAdditiveWrite"])
    assert additive_provider is not None
    assert len(additive_provider.tools) == 11
    assert _provider_wire_bytes(additive_provider.tools) <= 12_288

    assert operation_tool_specs(None) == ()
    assert operation_presented_declarations(None) == ()
    assert project_provider_model_tools(None) is None
    assert project_codex_model_tools(None) is None
    with pytest.raises(ValueError, match="NoModelTools forbids MCP"):
        project_codex_model_tools(None, server_name="nexus")
    with pytest.raises(ValueError, match="Native"):
        project_provider_model_tools(research)
    with pytest.raises(ValueError, match="Native"):
        project_codex_model_tools(
            research,
            server_name="nexus",
            url="https://nexus.internal/internal/agent-tools/mcp",
            bearer=bearer,
        )
