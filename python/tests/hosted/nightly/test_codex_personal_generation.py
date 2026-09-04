"""Bounded Codex target-set canary with redacted capability evidence.

The controller only enables this module on the enrolled subscription runner.
No provider API key, model output, prompt, tool grant, or diagnostic is ever
written to the evidence artifact.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import ipaddress
import json
import os
import socket
import stat
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import pytest
import uvicorn
from apps.codex_agent.confined_runtime import create_confined_runtime
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from llm_tools import WebSearchRequest, WebSearchResponse
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from provider_runtime import Present
from provider_runtime.agent_runtime import (
    AGENT_BACKEND_CONTRACT_REVISION,
    AgentModelCatalog,
    AgentPermissionRequest,
    AgentRuntimeConfig,
    AgentTerminal,
    AgentToolUse,
    CredentialRef,
    CredentialRejected,
    CredentialUnavailable,
)
from provider_runtime.registry import api_model_catalog
from pydantic import SecretStr

from nexus.schemas.llm import Ready, Selectable
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationCommandDraft,
    generation_command_from_draft,
)
from nexus.services.codex_generation_operations import (
    compose_codex_model_tool_plan_registry,
    resolve_codex_generation,
)
from nexus.services.generation_admission import FrozenHostEvidence
from nexus.services.generation_catalog import (
    GenerationCatalogService,
    readiness_snapshot,
    source_controlled_qualification_snapshot,
)
from nexus.services.generation_intent import (
    BearerToolGrant,
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
)
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    FrozenHostToolPlanSnapshot,
    FrozenScopePredicate,
    FrozenToolScope,
    ImmutablePromptPayloadRef,
    generation_fact_digest,
)
from nexus.services.tool_runtime.composition import compose_product_tool_runtime
from nexus.services.tool_runtime.profiles import TOOL_PLAN_DEFINITIONS_BY_ID

_BACKGROUND_CASES = (
    ("dossier_library", "LibraryDossierRead"),
    ("dossier_idea", "IdeaDossierRead"),
)
_MCP_HOST = "mcp.nexus.example.com"
_MCP_PATH = "/internal/agent-tools/mcp"
_MCP_PROTOCOL_VERSION = "2025-06-18"
_MCP_TOKEN = "hosted-nightly-read-only-token"
_MAX_PLAN_ELAPSED_SECONDS = 600
_MAX_PLAN_ELAPSED_MS = 600_000
_MAX_MCP_REQUEST_BYTES = 64 * 1024
_MAX_SUBSCRIPTION_TURNS = 9


@dataclass(frozen=True, slots=True)
class _HostedCase:
    receipt_kind: Literal["chat_target", "background"]
    target_key: str
    source_row_fingerprint: str
    operation: str
    reasoning: str
    capability_classes: tuple[str, ...]
    tool_plan_id: str
    command: GenerationCommand = field(repr=False)


@dataclass(frozen=True, slots=True)
class _FrozenCanary:
    catalog_definition_revision: str
    backend_contract_revision: str
    target_set: tuple[dict[str, object], ...]
    cases: tuple[_HostedCase, ...]


class _AvailableHostedWebSearch:
    """Admission-only availability peer; model calls go through the local MCP peer."""

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        del request
        return WebSearchResponse(
            results=(),
            provider="hosted-canary",
            provider_request_id=None,
            retrieved_at=datetime.now(UTC).isoformat(),
            attempts=1,
        )


@dataclass(slots=True)
class _McpState:
    tool_calls: int = 0
    methods: list[str] = field(default_factory=list)
    protocol_versions: set[str] = field(default_factory=set)
    session_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _McpPeer:
    server: uvicorn.Server
    thread: threading.Thread | None
    state: _McpState
    certificate: Path
    key: Path
    port: int = 0

    @property
    def origin(self) -> str:
        _require(self.port > 0, "MCP peer did not publish a listening port")
        return f"https://127.0.0.1:{self.port}{_MCP_PATH}"

    def close(self) -> None:
        self.server.should_exit = True
        _require(self.thread is not None, "MCP peer thread was not created")
        self.thread.join(timeout=10)
        self.certificate.unlink(missing_ok=True)
        self.key.unlink(missing_ok=True)


class _McpAuthApp:
    def __init__(self, manager: StreamableHTTPSessionManager, state: _McpState) -> None:
        self._manager = manager
        self._state = state

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if (
            scope.get("type") != "http"
            or scope.get("path") != _MCP_PATH
            or scope.get("method") != "POST"
        ):
            await _send_http_error(send, 404)
            return
        header_pairs = [
            (key.decode("latin1"), value.decode("latin1"))
            for key, value in scope.get("headers", [])
        ]
        headers = dict(header_pairs)
        if len(headers) != len(header_pairs):
            await _send_http_error(send, 400)
            return
        if headers.get("authorization") != f"Bearer {_MCP_TOKEN}":
            await _send_http_error(send, 401)
            return
        if (
            headers.get("content-type") != "application/json"
            or headers.get("accept") != "application/json, text/event-stream"
        ):
            await _send_http_error(send, 400)
            return
        if headers.get("mcp-session-id") is not None:
            self._state.session_ids.add(headers["mcp-session-id"])
            await _send_http_error(send, 400)
            return
        body = await _read_body(receive)
        try:
            wire = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            await _send_http_error(send, 400)
            return
        if not isinstance(wire, dict) or not isinstance(wire.get("method"), str):
            await _send_http_error(send, 400)
            return
        protocol_version = headers.get("mcp-protocol-version")
        if wire["method"] == "initialize":
            params = wire.get("params")
            requested = params.get("protocolVersion") if isinstance(params, dict) else None
            if requested != _MCP_PROTOCOL_VERSION or protocol_version not in {
                None,
                _MCP_PROTOCOL_VERSION,
            }:
                await _send_http_error(send, 400)
                return
        elif protocol_version != _MCP_PROTOCOL_VERSION:
            await _send_http_error(send, 400)
            return
        if protocol_version is not None:
            self._state.protocol_versions.add(protocol_version)

        delivered = False

        async def replay() -> dict[str, object]:
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def reject_session_response(message: dict[str, object]) -> None:
            if message.get("type") == "http.response.start":
                response_headers = message.get("headers")
                if isinstance(response_headers, list) and any(
                    isinstance(item, tuple)
                    and len(item) == 2
                    and item[0].lower() == b"mcp-session-id"
                    for item in response_headers
                ):
                    raise AssertionError("stateless MCP peer emitted a session identifier")
            await send(message)

        await self._manager.handle_request(scope, replay, reject_session_response)


async def _read_body(receive: Any) -> bytes:
    payload = bytearray()
    more = True
    while more:
        message = await receive()
        if message.get("type") != "http.request":
            raise RuntimeError("MCP peer request ended before its body")
        chunk = message.get("body", b"")
        if not isinstance(chunk, bytes) or len(payload) + len(chunk) > _MAX_MCP_REQUEST_BYTES:
            raise RuntimeError("MCP peer request exceeded its body contract")
        payload.extend(chunk)
        more = message.get("more_body") is True
    return bytes(payload)


async def _send_http_error(send: Any, status: int) -> None:
    await send({"type": "http.response.start", "status": status, "headers": []})
    await send({"type": "http.response.body", "body": b""})


def _list_tools(state: _McpState):
    async def list_tools(_context: Any, _params: Any) -> ListToolsResult:
        state.methods.append("tools/list")
        return ListToolsResult(
            tools=[
                Tool(
                    name=tool_id,
                    description=(
                        "Read one bounded proof resource."
                        if tool_id == "nexus.resource.read"
                        else "Hosted canary declaration; do not call this tool."
                    ),
                    inputSchema=_mcp_input_schema(tool_id),
                )
                for tool_id in _all_canary_tool_ids()
            ]
        )

    return list_tools


def _all_canary_tool_ids() -> tuple[str, ...]:
    return tuple(
        str(grant.id)
        for grant in TOOL_PLAN_DEFINITIONS_BY_ID["ChatReadAdditiveWrite"].profile.grants
    )


def _mcp_input_schema(tool_id: str) -> dict[str, object]:
    if tool_id == "nexus.resource.read":
        return {
            "type": "object",
            "properties": {"uri": {"type": "string"}},
            "required": ["uri"],
            "additionalProperties": False,
        }
    return {"type": "object", "additionalProperties": True}


def _call_tool(state: _McpState):
    async def call(_context: Any, params: Any) -> CallToolResult:
        state.methods.append("tools/call")
        state.tool_calls += 1
        if params.name != "nexus.resource.read":
            return CallToolResult(
                content=[TextContent(type="text", text="unknown tool")], isError=True
            )
        return CallToolResult(
            content=[TextContent(type="text", text="bounded hosted proof resource")],
            isError=False,
        )

    return call


def _write_peer_certificate(certificate: Path, key_path: Path) -> None:
    key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    now = datetime.now(UTC)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, _MCP_HOST)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName(_MCP_HOST),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    certificate.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)


@contextmanager
def _mcp_peer(root: Path) -> Iterator[_McpPeer]:
    state = root / "test-results" / "hosted-mcp-peer"
    state.mkdir(parents=True, exist_ok=True)
    certificate = state / "ca.pem"
    key = state / "server-key.pem"
    _write_peer_certificate(certificate, key)
    peer_state = _McpState()
    mcp_server = Server(
        "nexus-hosted-proof",
        version="1",
        on_list_tools=_list_tools(peer_state),
        on_call_tool=_call_tool(peer_state),
    )
    manager = StreamableHTTPSessionManager(
        mcp_server,
        json_response=True,
        stateless=True,
        security_settings=TransportSecuritySettings(
            allowed_hosts=["127.0.0.1:*"],
            allowed_origins=["https://127.0.0.1:*"],
        ),
    )
    app = _McpAuthApp(manager, peer_state)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    port = int(listener.getsockname()[1])
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            ssl_certfile=str(certificate),
            ssl_keyfile=str(key),
            log_level="critical",
            access_log=False,
            lifespan="off",
        )
    )
    peer = _McpPeer(server, None, peer_state, certificate, key, port)

    async def serve() -> None:
        try:
            async with manager.run():
                peer.thread = threading.current_thread()
                ready.set()
                await server.serve(sockets=[listener])
        finally:
            listener.close()

    ready = threading.Event()

    def run() -> None:
        asyncio.run(serve())

    thread = threading.Thread(target=run, daemon=True)
    peer.thread = thread
    thread.start()
    _require(ready.wait(timeout=10), "MCP peer did not become ready")
    try:
        yield peer
    finally:
        peer.close()
        state.rmdir()


def test_codex_personal_generation_canary_records_bounded_target_set() -> None:
    _require(os.environ.get("NEXUS_CODEX_HOSTED_CANARY") == "1", "Codex hosted canary is disabled")
    _require("OPENAI_API_KEY" not in os.environ, "Codex hosted canary received an API key")
    _require("CODEX_API_KEY" not in os.environ, "Codex hosted canary received an API key")
    _require("CODEX_HOME" not in os.environ, "Codex hosted canary received ambient Codex state")
    _require(
        os.environ.get("NEXUS_CODEX_HOSTED_PROFILE") == "codex-personal", "wrong hosted profile"
    )
    state_root = _owned_directory("NEXUS_CODEX_HOSTED_STATE_ROOT", empty=False)
    temporary_directory = _owned_directory(
        "NEXUS_CODEX_HOSTED_TEMPORARY_DIRECTORY",
        empty=True,
    )
    _require(
        temporary_directory == state_root.parent / "tmp",
        "hosted temporary directory differs from the confined runtime layout",
    )
    cwd = _owned_directory("NEXUS_CODEX_HOSTED_WORKING_DIRECTORY", empty=True)
    sdk_version = importlib.metadata.version("openai-codex")
    runtime_version = importlib.metadata.version("openai-codex-cli-bin")
    try:
        agent_catalog = asyncio.run(_read_authenticated_catalog(state_root))
    except (CredentialUnavailable, CredentialRejected):
        _write_readiness()
        return
    frozen = asyncio.run(_freeze_canary(agent_catalog))
    _require(
        len(frozen.cases) <= _MAX_SUBSCRIPTION_TURNS,
        "Codex hosted target set exceeded its subscription-turn ceiling",
    )

    with _mcp_peer(Path(__file__).parents[4]) as peer:
        results: list[dict[str, object]] = []
        registry = compose_codex_model_tool_plan_registry()
        for case in frozen.cases:
            resolved = resolve_codex_generation(
                case.command,
                working_directory=cwd,
                model_tool_registry=registry,
                mcp_origin="https://mcp.nexus.example.com/internal/agent-tools/mcp",
                tool_credential=CredentialRef(
                    kind="api_key_environment",
                    profile_key="codex-personal",
                    name="NEXUS_CODEX_HOSTED_MCP_TOKEN",
                ),
            )
            resolved = _bind_peer(resolved, peer)
            terminal, tool_events, elapsed_ms = _run_once(
                state_root,
                resolved,
                trust_certificate=peer.certificate,
            )
            _require(terminal.status == "succeeded", "Codex turn did not succeed")
            _require(terminal.failure is None, "Codex turn returned a failure")
            _require(isinstance(terminal.usage, Present), "Codex turn omitted usage")
            resolved_model = resolved.session.model_key
            resolved_effort = resolved.session.reasoning
            _require(
                f"CodexPersonal:{resolved_model}" == case.target_key,
                "resolved model drifted from the frozen target",
            )
            _require(resolved_effort == case.reasoning, "resolved reasoning drifted from admission")
            structured_output = terminal.structured_output
            if case.receipt_kind == "background":
                structured_output_valid = (
                    type(structured_output) is dict
                    and set(structured_output) == {"ok"}
                    and type(structured_output.get("ok")) is bool
                )
                _require(
                    structured_output_valid,
                    "strict JSON canary output violated its exact schema",
                )
            else:
                structured_output_valid = False
                _require(
                    structured_output is None,
                    "text canary unexpectedly returned structured output",
                )
            results.append(
                {
                    "receipt_kind": case.receipt_kind,
                    "target_key": case.target_key,
                    "source_row_fingerprint": case.source_row_fingerprint,
                    "operation": case.operation,
                    "reasoning": resolved_effort,
                    "capability_classes": list(case.capability_classes),
                    "tool_plan_id": case.tool_plan_id,
                    "tool_authority_revision": TOOL_PLAN_DEFINITIONS_BY_ID[
                        case.tool_plan_id
                    ].authority_revision,
                    "terminal_status": "succeeded",
                    "structured_output_valid": structured_output_valid,
                    "usage_present": True,
                    "sdk_version": sdk_version,
                    "runtime_version": runtime_version,
                    "declared_tool_count": len(
                        TOOL_PLAN_DEFINITIONS_BY_ID[case.tool_plan_id].profile.grants
                    ),
                    "tool_events": tool_events,
                    "elapsed_ms": elapsed_ms,
                    "permission_requests": 0,
                }
            )
        _require(
            peer.state.tool_calls == len(frozen.cases),
            "MCP peer did not receive exactly one tool call per turn",
        )
        _require(
            peer.state.methods
            == [method for _case in frozen.cases for method in ("tools/list", "tools/call")],
            "MCP sequence drifted",
        )
        _require(peer.state.protocol_versions == {_MCP_PROTOCOL_VERSION}, "MCP protocol drifted")
        _require(not peer.state.session_ids, "stateless MCP peer issued a session")
        _write_evidence(
            frozen,
            results,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )


async def _read_authenticated_catalog(state_root: Path) -> AgentModelCatalog:
    runtime = create_confined_runtime(AgentRuntimeConfig(state_root_base=state_root))
    try:
        return await runtime.model_catalog(
            "codex",
            CredentialRef(kind="local_account", profile_key="codex-personal"),
            transport="sdk",
        )
    finally:
        await runtime.close()


async def _freeze_canary(agent_catalog: AgentModelCatalog) -> _FrozenCanary:
    now = datetime.now(UTC)
    ready = Ready(last_checked=now)

    async def load_agent_catalog() -> AgentModelCatalog:
        return agent_catalog

    async def load_readiness():
        return readiness_snapshot(observed_at=now, routes={"CodexPersonal": ready})

    catalog_service = GenerationCatalogService(
        configured_api_providers=(),
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=load_agent_catalog,
        load_api_catalog=api_model_catalog,
        load_qualifications=source_controlled_qualification_snapshot,
        load_readiness=load_readiness,
        clock=lambda: now,
    )
    snapshot = await catalog_service.startup()
    _require(
        agent_catalog.backend_contract_revision == AGENT_BACKEND_CONTRACT_REVISION,
        "live Codex backend contract drifted",
    )
    expected_targets = {
        receipt.target_key: receipt.source_row_fingerprint
        for receipt in source_controlled_qualification_snapshot().targets
        if receipt.target_key.startswith("CodexPersonal:")
    }
    live_models = {f"CodexPersonal:{model.key}": model for model in agent_catalog.models}
    _require(set(live_models) == set(expected_targets), "live Codex target set drifted")
    target_set: list[dict[str, object]] = []
    for target_key in sorted(expected_targets):
        model = live_models[target_key]
        _require(
            model.row_fingerprint == expected_targets[target_key],
            "live Codex row fingerprint drifted",
        )
        reasoning = [item.key for item in model.reasoning]
        _require(reasoning and len(reasoning) == len(set(reasoning)), "reasoning set is invalid")
        target_set.append(
            {
                "target_key": target_key,
                "source_row_fingerprint": model.row_fingerprint,
                "reasoning": reasoning,
            }
        )

    service = GenerationService(
        catalog=catalog_service,
        policy=generation_policy.GENERATION_POLICY,
        tools=compose_product_tool_runtime(_AvailableHostedWebSearch()),
    )
    cases: list[_HostedCase] = []
    for target_key in sorted(expected_targets):
        model = live_models[target_key]
        selection = CodexPersonalSelection(
            route="CodexPersonal",
            model=model.key,
            reasoning=model.reasoning[0].key,
        )
        pair = snapshot.pair(selection)
        _require(
            pair is not None and isinstance(pair.state, Selectable), "target is not selectable"
        )
        intent = _canary_intent(strict=False)
        spec = service.freeze_chat_from_pair(
            catalog_definition_revision=snapshot.catalog.definition_revision,
            pair=pair,
            tool_authority="AdditiveWrites",
            scope=_canary_scope("chat"),
            intent=intent,
            prompt_template_revision=generation_policy.operation_revision("chat"),
            prompt_payload_ref=_prompt_ref("chat", target_key, intent),
        )
        cases.append(
            _case(
                index=len(cases),
                receipt_kind="chat_target",
                target_key=target_key,
                source_row_fingerprint=model.row_fingerprint,
                operation="chat",
                capability_classes=("text", "tools-continuation"),
                tool_plan_id="ChatReadAdditiveWrite",
                spec=spec,
                intent=intent,
            )
        )

    for operation, plan_id in _BACKGROUND_CASES:
        intent = _canary_intent(strict=True)
        workflow = generation_policy.background_operation_policy(operation).workflow
        host: FrozenHostEvidence | None = None
        if isinstance(workflow.host_tool_plan, generation_policy.ExactHostToolPlan):
            host = FrozenHostEvidence(
                plan=FrozenHostToolPlanSnapshot(
                    plan_id=workflow.host_tool_plan.plan_id,
                    authority_revision=workflow.host_tool_plan.authority_revision,
                    facts={"hosted_canary": True},
                ),
                evidence_revision=f"{operation}.hosted-canary.v1",
            )
        spec = await service.freeze_background(
            operation=operation,
            intent=intent,
            prompt_template_revision=generation_policy.operation_revision(operation),
            prompt_payload_ref=_prompt_ref(operation, operation, intent),
            scope=_canary_scope(operation),
            host=host,
        )
        cases.append(
            _case(
                index=len(cases),
                receipt_kind="background",
                target_key=f"CodexPersonal:{spec.selection.model}",
                source_row_fingerprint=spec.source_row_fingerprint,
                operation=operation,
                capability_classes=("strict-structured", "tools-continuation"),
                tool_plan_id=plan_id,
                spec=spec,
                intent=intent,
            )
        )
    return _FrozenCanary(
        catalog_definition_revision=snapshot.catalog.definition_revision,
        backend_contract_revision=agent_catalog.backend_contract_revision,
        target_set=tuple(target_set),
        cases=tuple(cases),
    )


def _case(
    *,
    index: int,
    receipt_kind: Literal["chat_target", "background"],
    target_key: str,
    source_row_fingerprint: str,
    operation: str,
    capability_classes: tuple[str, ...],
    tool_plan_id: str,
    spec: Any,
    intent: GenerationIntent,
) -> _HostedCase:
    draft = GenerationCommandDraft(request_id=UUID(int=index + 1), spec=spec, intent=intent)
    return _HostedCase(
        receipt_kind=receipt_kind,
        target_key=target_key,
        source_row_fingerprint=source_row_fingerprint,
        operation=operation,
        reasoning=spec.selection.reasoning,
        capability_classes=capability_classes,
        tool_plan_id=tool_plan_id,
        command=generation_command_from_draft(
            draft,
            tool_grant=BearerToolGrant(token=SecretStr("enrolled-hosted-canary-grant")),
        ),
    )


def _canary_intent(*, strict: bool) -> GenerationIntent:
    output: TextOutput | JsonSchemaOutput = TextOutput()
    if strict:
        output = JsonSchemaOutput(
            name="hosted_canary",
            schema={
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": False,
            },
        )
    return GenerationIntent(
        instructions=(
            "Call nexus.resource.read exactly once with uri nexus://hosted-canary/proof, "
            "then return only the admitted bounded output. Do not call any other tool."
        ),
        input="Read the hosted proof resource, then answer the canary contract.",
        output=output,
    )


def _prompt_ref(
    operation: str, identity: str, intent: GenerationIntent
) -> ImmutablePromptPayloadRef:
    return ImmutablePromptPayloadRef(
        owner_kind="hosted_canary",
        owner_id=f"{operation}:{identity}",
        revision=generation_policy.operation_revision(operation),
        payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
    )


def _canary_scope(operation: str) -> FrozenToolScope:
    return FrozenToolScope(
        admitted_refs=("nexus://hosted-canary/proof",),
        predicates=(FrozenScopePredicate(kind="HostedCanary", arguments={"operation": operation}),),
    )


def _bind_peer(operation: Any, peer: _McpPeer) -> Any:
    servers = tuple(replace(server, url=peer.origin) for server in operation.session.mcp_servers)
    policy = replace(
        operation.session.policy,
        environment=("NEXUS_CODEX_HOSTED_MCP_TOKEN", "SSL_CERT_FILE"),
    )
    session = replace(operation.session, mcp_servers=servers, policy=policy)
    return replace(operation, session=session)


def _run_once(
    state_root: Path,
    operation: Any,
    *,
    trust_certificate: Path | None = None,
) -> tuple[AgentTerminal, int, int]:
    async def run() -> tuple[AgentTerminal, int, int]:
        previous = {
            name: os.environ.get(name) for name in ("NEXUS_CODEX_HOSTED_MCP_TOKEN", "SSL_CERT_FILE")
        }
        os.environ["NEXUS_CODEX_HOSTED_MCP_TOKEN"] = f"Bearer {_MCP_TOKEN}"
        if trust_certificate is not None:
            os.environ["SSL_CERT_FILE"] = str(trust_certificate)
        runtime = create_confined_runtime(AgentRuntimeConfig(state_root_base=state_root))
        try:
            session = await runtime.open_session(operation.session)
            started = time.monotonic()
            try:
                # AgentRuntime's stream cancellation has a bounded interrupt/hard-close
                # path; this deadline initiates that path at the declared live-turn limit.
                async with asyncio.timeout(_MAX_PLAN_ELAPSED_SECONDS):
                    events = [event async for event in runtime.stream_turn(session, operation.turn)]
            except TimeoutError:
                pytest.fail("Codex plan exceeded elapsed ceiling", pytrace=False)
        finally:
            await runtime.close()
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        _require(
            not any(isinstance(event, AgentPermissionRequest) for event in events),
            "privileged permission event",
        )
        tool_events = len(
            {event.tool_call_id for event in events if isinstance(event, AgentToolUse)}
        )
        terminals = [event for event in events if isinstance(event, AgentTerminal)]
        _require(len(terminals) == 1, "Codex emitted more than one terminal")
        elapsed_ms = max(1, round((time.monotonic() - started) * 1000))
        _require(elapsed_ms <= _MAX_PLAN_ELAPSED_MS, "Codex plan exceeded elapsed ceiling")
        return terminals[0], tool_events, elapsed_ms

    return asyncio.run(run())


def _owned_directory(name: str, *, empty: bool) -> Path:
    path = Path(os.environ[name])
    _require(path.is_absolute() and path.is_dir(), f"{name} is not a directory")
    _require(path.resolve() == path, f"{name} is not canonical")
    _require(not path.is_relative_to(Path(__file__).parents[4].resolve()), "state is in workspace")
    metadata = path.stat()
    _require(
        metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) == 0o700,
        "state ownership/mode invalid",
    )
    _require(not empty or not tuple(path.iterdir()), f"{name} must be empty")
    return path


def _write_evidence(
    frozen: _FrozenCanary,
    results: list[dict[str, object]],
    *,
    sdk_version: str,
    runtime_version: str,
) -> None:
    path = Path(os.environ["NEXUS_CODEX_HOSTED_EVIDENCE_PATH"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tool_revisions = {
        plan_id: TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].authority_revision
        for plan_id in ("ChatReadAdditiveWrite", "LibraryDossierRead", "IdeaDossierRead")
    }
    payload = {
        "schema_version": "nexus-hosted-codex-canary.v4",
        "run_id": os.environ["NEXUS_TEST_RUN_ID"],
        "source_sha": os.environ["NEXUS_CODEX_HOSTED_SOURCE_SHA"],
        "policy_revision": generation_policy.POLICY_REVISION,
        "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
        "catalog_definition_revision": frozen.catalog_definition_revision,
        "backend_contract_revision": frozen.backend_contract_revision,
        "codex_sdk_version": sdk_version,
        "codex_cli_version": runtime_version,
        "qualification_scope": "codex_target_capability_set",
        "target_set": list(frozen.target_set),
        "tool_authority_revisions": tool_revisions,
        "subscription_turns": len(results),
        "results": results,
    }
    temporary = path.with_suffix(".partial")
    temporary.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def _write_readiness() -> None:
    path = Path(os.environ["NEXUS_CODEX_HOSTED_READINESS_PATH"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": "nexus-hosted-codex-readiness.v1",
                "run_id": os.environ["NEXUS_TEST_RUN_ID"],
                "status": "subscription_unavailable",
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        pytest.fail(message, pytrace=False)
