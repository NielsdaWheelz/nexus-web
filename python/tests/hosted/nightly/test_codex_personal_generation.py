"""Four-plan Codex subscription canary with bounded, redacted evidence.

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
from typing import Any
from uuid import UUID

import pytest
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from provider_runtime import Present
from provider_runtime.agent_runtime import (
    AgentPermissionRequest,
    AgentRuntime,
    AgentRuntimeConfig,
    AgentTerminal,
    AgentToolUse,
    CredentialRef,
)
from pydantic import SecretStr

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    ChatOperation,
    DossierLibraryOperation,
    GenerationCommand,
    MetadataEnrichmentOperation,
    OracleOperation,
)
from nexus.services.codex_generation_operations import resolve_codex_generation
from nexus.services.generation_intent import (
    BearerToolGrant,
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
)

_PLANS = (
    ("routine", "gpt-5.6-luna", "low", "text", MetadataEnrichmentOperation),
    ("standard", "gpt-5.6-terra", "medium", "json", OracleOperation),
    ("thorough", "gpt-5.6-terra", "high", "text", DossierLibraryOperation),
    ("deep", "gpt-5.6-sol", "high", "mcp-read", ChatOperation),
)
_MCP_HOST = "mcp.nexus.example.com"
_MCP_PATH = "/internal/agent-tools/mcp"
_MCP_PROTOCOL_VERSION = "2025-06-18"
_MCP_TOKEN = "hosted-nightly-read-only-token"
_MAX_PLAN_ELAPSED_MS = 600_000


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
        if scope.get("type") != "http" or scope.get("path") != _MCP_PATH:
            await _send_http_error(send, 404)
            return
        headers = {
            key.decode("latin1"): value.decode("latin1")
            for key, value in scope.get("headers", [])
        }
        if headers.get("authorization") != f"Bearer {_MCP_TOKEN}":
            await _send_http_error(send, 401)
            return
        protocol_version = headers.get("mcp-protocol-version")
        if protocol_version is not None:
            self._state.protocol_versions.add(protocol_version)
            if protocol_version != _MCP_PROTOCOL_VERSION:
                await _send_http_error(send, 400)
                return
        session_id = headers.get("mcp-session-id")
        if session_id is not None:
            self._state.session_ids.add(session_id)
        await self._manager.handle_request(scope, receive, send)


async def _send_http_error(send: Any, status: int) -> None:
    await send({"type": "http.response.start", "status": status, "headers": []})
    await send({"type": "http.response.body", "body": b""})


def _list_tools(state: _McpState):
    async def list_tools(_context: Any, _params: Any) -> ListToolsResult:
        state.methods.append("tools/list")
        return ListToolsResult(
            tools=[
                Tool(
                    name="nexus.resource.read",
                    description="Read one bounded proof resource.",
                    inputSchema={
                        "type": "object",
                        "properties": {"uri": {"type": "string"}},
                        "required": ["uri"],
                    },
                )
            ]
        )

    return list_tools


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
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
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
    peer = _McpPeer(server, None, peer_state, certificate, key)

    async def serve() -> None:
        async with manager.run():
            peer.thread = threading.current_thread()
            serving = asyncio.create_task(server.serve())
            for _ in range(100):
                if server.started:
                    peer.port = port
                    ready.set()
                    break
                await asyncio.sleep(0.01)
            else:
                raise RuntimeError("MCP peer did not bind exactly one socket")
            await serving

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


def test_codex_personal_generation_canary_records_exact_four_plan_pairs() -> None:
    _require(os.environ.get("NEXUS_CODEX_HOSTED_CANARY") == "1", "Codex hosted canary is disabled")
    _require("OPENAI_API_KEY" not in os.environ, "Codex hosted canary received an API key")
    _require("CODEX_HOME" not in os.environ, "Codex hosted canary received ambient Codex state")
    _require(
        os.environ.get("NEXUS_CODEX_HOSTED_PROFILE") == "codex-personal", "wrong hosted profile"
    )
    state_root = _owned_directory("NEXUS_CODEX_HOSTED_STATE_ROOT", empty=False)
    cwd = _owned_directory("NEXUS_CODEX_HOSTED_WORKING_DIRECTORY", empty=True)

    with _mcp_peer(Path(__file__).parents[4]) as peer:
        results: list[dict[str, object]] = []
        for index, (plan_id, model, effort, shape, operation_type) in enumerate(_PLANS):
            command = _command(index, operation_type, shape)
            resolved = resolve_codex_generation(
                command,
                working_directory=cwd,
                mcp_origin=(
                    "https://mcp.nexus.example.com/internal/agent-tools/mcp"
                    if shape == "mcp-read"
                    else None
                ),
                tool_credential=(
                    CredentialRef(
                        kind="api_key_environment",
                        profile_key="codex-personal",
                        name="NEXUS_CODEX_HOSTED_MCP_TOKEN",
                    )
                    if shape == "mcp-read"
                    else None
                ),
            )
            if shape == "mcp-read":
                resolved = _bind_peer(resolved, peer)
            terminal, tool_events, elapsed_ms = _run_once(
                state_root,
                resolved,
                trust_certificate=peer.certificate if shape == "mcp-read" else None,
            )
            _require(terminal.status == "succeeded", "Codex turn did not succeed")
            _require(terminal.failure is None, "Codex turn returned a failure")
            usage = terminal.usage
            _require(isinstance(usage, Present), "Codex turn omitted usage")
            usage_value = usage.value
            resolved_model = resolved.session.model
            resolved_effort = resolved.session.reasoning.effort
            _require(resolved_model == model, "resolved model drifted from the plan")
            _require(resolved_effort == effort, "resolved reasoning drifted from the plan")
            structured_output_valid = terminal.structured_output is not None
            _require(
                structured_output_valid is (shape == "json"),
                "resolved output shape drifted from the plan",
            )
            results.append(
                {
                    "plan_id": plan_id,
                    "plan_revision": generation_policy.POLICY_REVISION,
                    "model": resolved_model,
                    "reasoning": resolved_effort,
                    "backend": "codex",
                    "transport": "sdk",
                    "auth_profile": "codex-personal",
                    "terminal_status": "succeeded",
                    "structured_output_valid": structured_output_valid,
                    "session_ref_schema_version": "agent-session-ref.v1",
                    "usage": {
                        "input_tokens": usage_value.input_tokens,
                        "output_tokens": usage_value.output_tokens,
                        "total_tokens": usage_value.total_tokens,
                    },
                    "sdk_version": importlib.metadata.version("openai-codex"),
                    "runtime_version": importlib.metadata.version("openai-codex-cli-bin"),
                    "tool_events": tool_events,
                    "elapsed_ms": elapsed_ms,
                    "permission_requests": 0,
                }
            )
        _require(peer.state.tool_calls >= 1, "MCP peer received no tool call")
        _require(peer.state.methods == ["tools/list", "tools/call"], "MCP sequence drifted")
        _require(peer.state.protocol_versions == {_MCP_PROTOCOL_VERSION}, "MCP protocol drifted")
        _require(not peer.state.session_ids, "stateless MCP peer issued a session")
        _write_evidence(results)


def _command(index: int, operation_type: type[Any], shape: str) -> GenerationCommand:
    operation_name = {
        MetadataEnrichmentOperation: "metadata_enrichment",
        OracleOperation: "oracle",
        DossierLibraryOperation: "dossier_library",
        ChatOperation: "chat",
    }[operation_type]
    policy = (
        generation_policy.chat_policy("deep")
        if operation_type is ChatOperation
        else generation_policy.operation_policy(operation_name)
    )
    if operation_type is ChatOperation:
        operation: Any = ChatOperation(kind="chat", profile="deep", revision=policy.revision)
    else:
        operation = operation_type(kind=operation_name, revision=policy.revision)
    output = TextOutput()
    if shape == "json":
        output = JsonSchemaOutput(
            name="canary",
            schema={
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": False,
            },
        )
    return GenerationCommand(
        request_id=UUID(int=index + 1),
        operation=operation,
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=GenerationIntent(
            instructions=(
                "Use the admitted Nexus resource.read tool once, then return a bounded result."
                if operation_type is ChatOperation
                else "Return a bounded canary result."
            ),
            input=(
                "Read the hosted proof resource before replying."
                if operation_type is ChatOperation
                else "Reply with a short result."
            ),
            output=output,
        ),
        tool_grant=BearerToolGrant(token=SecretStr("enrolled-read-only-grant"))
        if operation_type is ChatOperation
        else None,
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
        started = time.monotonic()
        previous = {
            name: os.environ.get(name)
            for name in ("NEXUS_CODEX_HOSTED_MCP_TOKEN", "SSL_CERT_FILE")
        }
        os.environ["NEXUS_CODEX_HOSTED_MCP_TOKEN"] = _MCP_TOKEN
        if trust_certificate is not None:
            os.environ["SSL_CERT_FILE"] = str(trust_certificate)
        runtime = AgentRuntime(AgentRuntimeConfig(state_root_base=state_root))
        try:
            session = await runtime.open_session(operation.session)
            events = [event async for event in runtime.stream_turn(session, operation.turn)]
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


def _write_evidence(results: list[dict[str, object]]) -> None:
    path = Path(os.environ["NEXUS_CODEX_HOSTED_EVIDENCE_PATH"])
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": "nexus-hosted-codex-canary.v2",
        "run_id": os.environ["NEXUS_TEST_RUN_ID"],
        "subscription_turns": 4,
        "results": results,
    }
    temporary = path.with_suffix(".partial")
    temporary.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def _require(condition: bool, message: str) -> None:
    if not condition:
        pytest.fail(message, pytrace=False)
