"""Lower one frozen no-tool Codex generation into its contained native request."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from provider_runtime.agent_runtime import (
    CodexCatalogSessionRequest,
    CodexNativeOptions,
    CredentialRef,
    JsonSchemaAgentOutput,
    NewSession,
    PermissionPolicy,
    TextAgentOutput,
    TextContent,
    TurnRequest,
    UnsupportedCapability,
)

from nexus.schemas.presence import Present
from nexus.services.codex_generation_contract import GenerationCommand
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    CodexPersonalSelection,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
)

AUTH_PROFILE = "codex-personal"


@dataclass(frozen=True, slots=True)
class ResolvedCodexGeneration:
    session: CodexCatalogSessionRequest
    turn: TurnRequest
    session_open_timeout_seconds: float
    runtime_close_timeout_seconds: float


def resolve_codex_generation(
    command: GenerationCommand, *, working_directory: Path
) -> ResolvedCodexGeneration:
    """Reject unsupported authority before constructing a native session."""

    spec = command.spec
    selection = spec.selection
    target = spec.resolved_dispatch_target
    if not isinstance(selection, CodexPersonalSelection) or not isinstance(
        target, CodexDispatchTargetSnapshot
    ):
        raise ValueError("Codex lowering requires a CodexPersonal GenerationSpec")
    if selection.model != target.model_key:
        raise ValueError("Codex selection and frozen dispatch target disagree")
    if isinstance(spec.model_tool_plan_snapshot, Present):
        raise UnsupportedCapability("Codex frozen MCP tools are unavailable")

    return ResolvedCodexGeneration(
        session=CodexCatalogSessionRequest(
            auth=CredentialRef(kind="local_account", profile_key=AUTH_PROFILE),
            open=NewSession(),
            cwd=str(working_directory),
            policy=PermissionPolicy(
                filesystem="read_only",
                network="disabled",
                approval="deny",
                allowed_tools=("*",),
            ),
            model_key=selection.model,
            reasoning=selection.reasoning,
            agent_definition_revision=target.agent_definition_revision,
            row_fingerprint=spec.source_row_fingerprint,
            system=(TextContent(command.intent.instructions),),
            developer=(),
            additional_dirs=(),
            mcp_servers=(),
            output=_output(command),
            native=CodexNativeOptions(web_search=False, builtin_tools="disabled"),
        ),
        turn=TurnRequest(
            input=(TextContent(command.intent.input),),
            timeout_seconds=float(spec.bounds.turn_timeout_seconds),
        ),
        session_open_timeout_seconds=float(spec.bounds.session_open_timeout_seconds),
        runtime_close_timeout_seconds=float(spec.bounds.runtime_close_timeout_seconds),
    )


def _output(command: GenerationCommand) -> TextAgentOutput | JsonSchemaAgentOutput:
    output = command.spec.output_contract
    if isinstance(output, TextOutputSnapshot):
        return TextAgentOutput()
    if isinstance(output, StrictJsonOutputSnapshot):
        return JsonSchemaAgentOutput(name=output.name, schema=output.json_schema)
    raise AssertionError("generation output union was not exhaustive")
