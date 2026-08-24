"""Closed metadata operation catalog for the private native-agent host."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

from provider_runtime.agent_runtime import (
    AgentSessionRequest,
    CodexNativeOptions,
    CredentialRef,
    JsonSchemaAgentOutput,
    NewSession,
    PermissionPolicy,
    ReasoningSpec,
    TextContent,
    TurnRequest,
)

from nexus.services.metadata_enrichment import metadata_enrichment_agent_definition
from nexus.services.native_agent_contract import (
    METADATA_ENRICHMENT_OPERATION_REVISION,
    MetadataEnrichmentOperation,
    NativeAgentCommand,
)

_MODEL = "gpt-5.6-luna"
_REASONING = "low"
_AUTH_PROFILE = "codex-personal"
_TURN_TIMEOUT_SECONDS = 120.0
_OUTPUT_NAME = "media_metadata_enrichment"
_FACTS_WORKING_DIRECTORY = Path("/var/empty/nexus-codex")

# The host bounds every phase of an accepted turn so the worker's transport deadline is a
# proven upper bound rather than a guess: a session open costs at most three sequential
# 30-second SDK operation bounds (client open, credential verify, thread start), the turn
# costs its catalog timeout, and a runtime close costs at most two drain-plus-settle
# rounds and the interruption calls between them. The transport deadline is that worst
# case plus one fixed margin for frame serialization and the socket round trip, so a turn
# that spends its whole budget still yields the distinct `turn_timeout` terminal instead
# of an ambiguous post-acceptance transport loss.
METADATA_ENRICHMENT_SESSION_OPEN_DEADLINE_SECONDS = 90.0
METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS = 30.0
_TRANSPORT_MARGIN_SECONDS = 15.0
METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS = (
    METADATA_ENRICHMENT_SESSION_OPEN_DEADLINE_SECONDS
    + _TURN_TIMEOUT_SECONDS
    + METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS
    + _TRANSPORT_MARGIN_SECONDS
)


@dataclass(frozen=True, slots=True)
class NativeAgentOperationFacts:
    operation: Literal["metadata_enrichment"]
    revision: str
    backend: Literal["codex"]
    transport: Literal["sdk"]
    auth_profile: Literal["codex-personal"]
    model: Literal["gpt-5.6-luna"]
    reasoning: Literal["low"]
    timeout_seconds: float
    transport_deadline_seconds: float
    system_prompt_fingerprint: str
    policy_fingerprint: str
    output_schema_fingerprint: str


@dataclass(frozen=True, slots=True)
class ResolvedNativeAgentOperation:
    session: AgentSessionRequest
    turn: TurnRequest


def build_metadata_enrichment_command(*, request_id: UUID, input: str) -> NativeAgentCommand:
    return NativeAgentCommand(
        request_id=request_id,
        operation=MetadataEnrichmentOperation(
            revision=METADATA_ENRICHMENT_OPERATION_REVISION,
            input=input,
        ),
    )


def metadata_enrichment_operation_facts() -> NativeAgentOperationFacts:
    system_prompt, output_schema = metadata_enrichment_agent_definition()
    session = _metadata_enrichment_session(
        system_prompt=system_prompt,
        output_schema=output_schema,
        working_directory=_FACTS_WORKING_DIRECTORY,
    )
    return _operation_facts(
        system_prompt=system_prompt,
        output_schema=output_schema,
        session=session,
    )


def _operation_facts(
    *,
    system_prompt: str,
    output_schema: dict[str, object],
    session: AgentSessionRequest,
) -> NativeAgentOperationFacts:
    return NativeAgentOperationFacts(
        operation="metadata_enrichment",
        revision=METADATA_ENRICHMENT_OPERATION_REVISION,
        backend="codex",
        transport="sdk",
        auth_profile=_AUTH_PROFILE,
        model=_MODEL,
        reasoning=_REASONING,
        timeout_seconds=_TURN_TIMEOUT_SECONDS,
        transport_deadline_seconds=METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS,
        system_prompt_fingerprint=_fingerprint(system_prompt),
        policy_fingerprint=_policy_fingerprint(session),
        output_schema_fingerprint=_fingerprint(output_schema),
    )


def native_agent_request_fingerprint(command: NativeAgentCommand) -> str:
    facts = metadata_enrichment_operation_facts()
    return _fingerprint(
        {
            "operation": command.operation.model_dump(mode="json"),
            "model": facts.model,
            "reasoning": facts.reasoning,
            "timeout_seconds": facts.timeout_seconds,
            "transport_deadline_seconds": facts.transport_deadline_seconds,
            "system_prompt_fingerprint": facts.system_prompt_fingerprint,
            "policy_fingerprint": facts.policy_fingerprint,
            "output_schema_fingerprint": facts.output_schema_fingerprint,
        }
    )


def resolve_native_agent_operation(
    command: NativeAgentCommand,
    *,
    working_directory: Path,
) -> ResolvedNativeAgentOperation:
    if command.operation.revision != METADATA_ENRICHMENT_OPERATION_REVISION:
        # justify-defect: a validated command cannot carry an uncatalogued revision.
        raise AssertionError("validated metadata operation revision drifted")
    system_prompt, output_schema = metadata_enrichment_agent_definition()
    return ResolvedNativeAgentOperation(
        session=_metadata_enrichment_session(
            system_prompt=system_prompt,
            output_schema=output_schema,
            working_directory=working_directory,
        ),
        turn=TurnRequest(
            input=(TextContent(command.operation.input),),
            timeout_seconds=_TURN_TIMEOUT_SECONDS,
        ),
    )


def _metadata_enrichment_session(
    *,
    system_prompt: str,
    output_schema: dict[str, object],
    working_directory: Path,
) -> AgentSessionRequest:
    return AgentSessionRequest(
        backend="codex",
        transport="sdk",
        auth=CredentialRef(kind="local_account", profile_key=_AUTH_PROFILE),
        open=NewSession(),
        cwd=str(working_directory),
        policy=PermissionPolicy(
            filesystem="read_only",
            network="disabled",
            approval="deny",
            allowed_tools=("*",),
        ),
        model=_MODEL,
        reasoning=ReasoningSpec(effort=_REASONING),
        system=(TextContent(system_prompt),),
        additional_dirs=(),
        mcp_servers=(),
        output=JsonSchemaAgentOutput(name=_OUTPUT_NAME, schema=output_schema),
        native=CodexNativeOptions(web_search=False, builtin_tools="disabled"),
    )


def _policy_fingerprint(session: AgentSessionRequest) -> str:
    policy = session.policy
    native = session.native
    if not isinstance(native, CodexNativeOptions):
        # justify-defect: the catalog builds the only session, always with Codex options.
        raise AssertionError("metadata operation must resolve Codex native options")
    return _fingerprint(
        {
            "filesystem": policy.filesystem,
            "network": policy.network,
            "network_allowlist": list(policy.network_allowlist),
            "approval": policy.approval,
            "allowed_tools": list(policy.allowed_tools),
            "denied_tools": list(policy.denied_tools),
            "environment": list(policy.environment),
            "unsafe_confirmation": policy.unsafe_confirmation,
            "additional_dirs": list(session.additional_dirs),
            "mcp_servers": list(session.mcp_servers),
            "native": {
                "builtin_tools": native.builtin_tools,
                "web_search": native.web_search,
            },
            "transport_deadline_seconds": METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS,
        }
    )


def _fingerprint(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


__all__ = [
    "METADATA_ENRICHMENT_OPERATION_REVISION",
    "METADATA_ENRICHMENT_RUNTIME_CLOSE_DEADLINE_SECONDS",
    "METADATA_ENRICHMENT_SESSION_OPEN_DEADLINE_SECONDS",
    "METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS",
    "NativeAgentOperationFacts",
    "ResolvedNativeAgentOperation",
    "build_metadata_enrichment_command",
    "metadata_enrichment_operation_facts",
    "native_agent_request_fingerprint",
    "resolve_native_agent_operation",
]
