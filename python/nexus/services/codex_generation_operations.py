"""Frozen Codex transport lowering with no process-policy reads."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType

from llm_tools import Native
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
    UnsafeConfirmation,
)
from provider_runtime.agent_runtime.tool_projection import PublishedMcpTools

from nexus.schemas.presence import Presence, Present
from nexus.services.codex_generation_contract import GenerationCommand
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
)
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    compose_projection_tool_runtime,
    freeze_tool_plan_snapshot,
    project_codex_model_tools,
)
from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

AUTH_PROFILE = "codex-personal"
MODEL_TOOL_MCP_SERVER_NAME = "nexus"


def model_tool_allowed_tools(snapshot: FrozenToolPlanSnapshot) -> tuple[str, ...]:
    """Return canonical Nexus tool ids; wire aliases stay inside llm-calling."""

    return tuple(grant.id for grant in snapshot.grants)


@dataclass(frozen=True, slots=True)
class CodexModelToolPlanRegistry:
    """Resolve a frozen plan only when the process-owned projection is identical."""

    operations: tuple[FrozenToolOperation, ...]
    _by_revision: Mapping[str, FrozenToolOperation] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        indexed: dict[str, FrozenToolOperation] = {}
        for operation in self.operations:
            if not isinstance(operation.plan.exposure, Native):
                raise ValueError("Codex plan registry accepts only Native model-tool plans")
            revision = operation.plan.plan_revision
            if revision in indexed:
                raise ValueError("Codex plan registry revisions must be unique")
            indexed[revision] = operation
        object.__setattr__(self, "_by_revision", MappingProxyType(indexed))

    def publish(
        self,
        snapshot: FrozenToolPlanSnapshot,
        *,
        mcp_origin: str,
        tool_credential: CredentialRef,
    ) -> PublishedMcpTools:
        try:
            operation = self._by_revision[snapshot.plan_revision]
        except KeyError as error:
            raise ValueError("frozen ModelTools plan is unavailable to the Codex host") from error
        if freeze_tool_plan_snapshot(operation) != snapshot:
            raise ValueError("Codex host tool projection differs from the frozen plan")
        published = project_codex_model_tools(
            operation,
            server_name=MODEL_TOOL_MCP_SERVER_NAME,
            url=mcp_origin,
            bearer=tool_credential,
        )
        if published is None:
            raise AssertionError("Native ModelTools projection unexpectedly returned no tools")
        return published


def compose_codex_model_tool_plan_registry() -> CodexModelToolPlanRegistry:
    """Build the credential-free host projection of every Native Nexus plan."""

    runtime = compose_projection_tool_runtime()
    return CodexModelToolPlanRegistry(
        tuple(
            operation
            for operation in runtime.operations.values()
            if isinstance(operation.plan.exposure, Native)
        )
    )


@dataclass(frozen=True, slots=True)
class ResolvedCodexGeneration:
    """The complete AgentRuntime request projected from one frozen spec."""

    model_tool_plan_snapshot: Presence[FrozenToolPlanSnapshot]
    published_model_tools: PublishedMcpTools | None
    session: CodexCatalogSessionRequest
    turn: TurnRequest
    session_open_timeout_seconds: float
    runtime_close_timeout_seconds: float


def resolve_codex_generation(
    command: GenerationCommand,
    *,
    working_directory: Path,
    model_tool_registry: CodexModelToolPlanRegistry,
    mcp_origin: str | None,
    tool_credential: CredentialRef | None,
) -> ResolvedCodexGeneration:
    """Lower exact frozen facts; never consult current generation policy."""

    spec = command.spec
    selection = spec.selection
    target = spec.resolved_dispatch_target
    if not isinstance(selection, CodexPersonalSelection) or not isinstance(
        target, CodexDispatchTargetSnapshot
    ):
        raise ValueError("Codex lowering requires a CodexPersonal GenerationSpec")
    if selection.model != target.model_key:
        raise ValueError("Codex selection and frozen dispatch target disagree")

    plan_presence = spec.model_tool_plan_snapshot
    published: PublishedMcpTools | None
    if isinstance(plan_presence, Present):
        if mcp_origin is None or tool_credential is None:
            raise ValueError("ModelTools lowering requires host MCP configuration")
        published = model_tool_registry.publish(
            plan_presence.value,
            mcp_origin=mcp_origin,
            tool_credential=tool_credential,
        )
        filesystem = "workspace_write"
        network = "unrestricted"
        unsafe = UnsafeConfirmation(("network_unrestricted",))
        mcp_servers = (published.server,)
    else:
        if tool_credential is not None:
            raise ValueError("NoModelTools lowering received a tool credential")
        published = None
        filesystem = "read_only"
        network = "disabled"
        unsafe = None
        mcp_servers = ()

    return ResolvedCodexGeneration(
        model_tool_plan_snapshot=plan_presence,
        published_model_tools=published,
        session=CodexCatalogSessionRequest(
            auth=CredentialRef(kind="local_account", profile_key=AUTH_PROFILE),
            open=NewSession(),
            cwd=str(working_directory),
            policy=PermissionPolicy(
                filesystem=filesystem,
                network=network,
                approval="deny",
                allowed_tools=("*",),
                unsafe_confirmation=unsafe,
            ),
            model_key=selection.model,
            reasoning=selection.reasoning,
            agent_definition_revision=target.agent_definition_revision,
            row_fingerprint=spec.source_row_fingerprint,
            system=(TextContent(command.intent.instructions),),
            developer=(),
            additional_dirs=(),
            mcp_servers=mcp_servers,
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


__all__ = [
    "AUTH_PROFILE",
    "MODEL_TOOL_MCP_SERVER_NAME",
    "CodexModelToolPlanRegistry",
    "ResolvedCodexGeneration",
    "compose_codex_model_tool_plan_registry",
    "model_tool_allowed_tools",
    "resolve_codex_generation",
]
