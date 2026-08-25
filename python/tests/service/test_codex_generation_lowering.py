"""Capability-lowering proof for the fixed Codex generation plans."""

from pathlib import Path
from uuid import UUID

from provider_runtime.agent_runtime import CredentialRef
from pydantic import SecretStr

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    MetadataEnrichmentOperation,
)
from nexus.services.codex_generation_operations import (
    CHAT_MCP_SERVER_NAME,
    chat_mcp_allowed_tools,
    resolve_codex_generation,
)
from nexus.services.generation_intent import BearerToolGrant, GenerationIntent, TextOutput

_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"


def _command(*, chat: bool) -> GenerationCommand:
    if chat:
        policy = generation_policy.chat_policy("balanced")
        operation = ChatOperation(profile="balanced", revision=policy.revision)
        grant = BearerToolGrant(token=SecretStr("run-scoped-test-grant"))
    else:
        policy = generation_policy.operation_policy("metadata_enrichment")
        operation = MetadataEnrichmentOperation(revision=policy.revision)
        grant = None
    return GenerationCommand(
        request_id=UUID(int=2 if chat else 1),
        operation=operation,
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=GenerationIntent(
            instructions="follow the bounded contract",
            input="bounded input",
            output=TextOutput(),
        ),
        tool_grant=grant,
    )


def test_operation_identity_lowers_to_one_exact_capability_and_tool_surface(
    tmp_path: Path,
) -> None:
    synthesis = resolve_codex_generation(
        _command(chat=False),
        working_directory=tmp_path,
        mcp_origin=None,
        tool_credential=None,
    )
    assert synthesis.capability == "Synthesis"
    assert synthesis.session.policy.filesystem == "read_only"
    assert synthesis.session.policy.network == "disabled"
    assert synthesis.session.mcp_servers == ()
    assert synthesis.session.native is not None
    assert synthesis.session.native.web_search is False
    assert synthesis.session.native.builtin_tools == "disabled"

    chat = resolve_codex_generation(
        _command(chat=True),
        working_directory=tmp_path,
        mcp_origin=_MCP_ORIGIN,
        tool_credential=CredentialRef(
            kind="secret_reference",
            profile_key="codex-personal",
            name="run-grant-reference",
        ),
    )
    assert chat.capability == "ChatTools", "ChatTools lowering lost its exact capability"
    assert chat.session.policy.filesystem == "workspace_write"
    assert chat.session.policy.network == "unrestricted"
    assert chat.session.native is not None
    assert chat.session.native.web_search is False
    assert chat.session.native.builtin_tools == "disabled"
    assert len(chat.session.mcp_servers) == 1
    server = chat.session.mcp_servers[0]
    assert server.name == CHAT_MCP_SERVER_NAME
    assert server.url == _MCP_ORIGIN
    assert server.required is True
    assert server.allowed_tools == chat_mcp_allowed_tools()
    assert server.denied_tools == ()
