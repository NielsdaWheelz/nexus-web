"""Host-owned lowering from app generation commands to pinned AgentRuntime types."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path

from provider_runtime.agent_runtime import (
    AgentOutputSpec,
    AgentSessionRequest,
    CodexNativeOptions,
    CredentialRef,
    HeaderReference,
    JsonSchemaAgentOutput,
    McpServerSpec,
    NewSession,
    PermissionPolicy,
    ReasoningSpec,
    TextAgentOutput,
    TextContent,
    TurnRequest,
    UnsafeConfirmation,
)

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    command_policy,
)
from nexus.services.generation_intent import JsonSchemaOutput, TextOutput

AUTH_PROFILE = "codex-personal"
CHAT_MCP_SERVER_NAME = "nexus"


@cache
def chat_mcp_allowed_tools() -> tuple[str, ...]:
    """Resolve the declaration-owned allowlist after application imports settle."""

    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

    return tuple(str(declaration.spec.id) for declaration in CHAT_TOOL_DECLARATIONS)


@dataclass(frozen=True, slots=True)
class ResolvedCodexGeneration:
    """The complete provider-runtime request resolved from operation identity alone."""

    capability: generation_policy.Capability
    session: AgentSessionRequest
    turn: TurnRequest
    runtime_close_timeout_seconds: float


def resolve_codex_generation(
    command: GenerationCommand,
    *,
    working_directory: Path,
    mcp_origin: str | None,
    tool_credential: CredentialRef | None,
) -> ResolvedCodexGeneration:
    """Re-resolve policy and lower request facts without trusting caller runtime choices."""

    policy = command_policy(command)
    if command.policy_revision != generation_policy.POLICY_REVISION:
        raise AssertionError("validated command policy revision drifted")
    if command.policy_fingerprint != generation_policy.policy_fingerprint():
        raise AssertionError("validated command policy fingerprint drifted")
    if command.operation.revision != policy.revision:
        raise AssertionError("validated command operation revision drifted")

    chat = isinstance(command.operation, ChatOperation)
    if chat:
        if mcp_origin is None or tool_credential is None:
            raise ValueError("ChatTools lowering requires host MCP configuration")
        filesystem = "workspace_write"
        network = "unrestricted"
        unsafe = UnsafeConfirmation(("network_unrestricted",))
        mcp_servers = (
            McpServerSpec(
                name=CHAT_MCP_SERVER_NAME,
                transport="streamable_http",
                url=mcp_origin,
                header_refs=(HeaderReference("Authorization", tool_credential),),
                required=True,
                allowed_tools=chat_mcp_allowed_tools(),
            ),
        )
    else:
        if tool_credential is not None:
            raise AssertionError("Synthesis lowering received a tool credential")
        filesystem = "read_only"
        network = "disabled"
        unsafe = None
        mcp_servers = ()

    return ResolvedCodexGeneration(
        capability=policy.capability,
        session=AgentSessionRequest(
            backend="codex",
            transport="sdk",
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
            model=policy.model,
            reasoning=ReasoningSpec(effort=policy.effort),
            system=(TextContent(command.intent.instructions),),
            developer=(),
            additional_dirs=(),
            mcp_servers=mcp_servers,
            output=_output(command),
            native=CodexNativeOptions(web_search=False, builtin_tools="disabled"),
        ),
        turn=TurnRequest(
            input=(TextContent(command.intent.input),),
            timeout_seconds=float(policy.turn_timeout_seconds),
        ),
        runtime_close_timeout_seconds=float(policy.runtime_close_timeout_seconds),
    )


def _output(command: GenerationCommand) -> AgentOutputSpec:
    output = command.intent.output
    if isinstance(output, TextOutput):
        return TextAgentOutput()
    if isinstance(output, JsonSchemaOutput):
        return JsonSchemaAgentOutput(name=output.name, schema=output.schema_)
    raise AssertionError("generation output union was not exhaustive")


__all__ = [
    "AUTH_PROFILE",
    "CHAT_MCP_SERVER_NAME",
    "ResolvedCodexGeneration",
    "chat_mcp_allowed_tools",
    "resolve_codex_generation",
]
