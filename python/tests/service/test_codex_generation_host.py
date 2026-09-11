"""Real-UDS RED proof for v2 generation lowering and lifecycle ownership."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import socket
import threading
from collections.abc import AsyncIterator, Iterator, Mapping
from datetime import UTC, datetime
from importlib.util import find_spec
from pathlib import Path
from tempfile import gettempdir
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from apps.codex_agent.capacity import CapacityPaths
from apps.codex_agent.host import (
    RuntimeVersions,
    create_codex_agent_app,
)
from provider_runtime.agent_runtime import (
    AgentEvent,
    AgentPermissionRequest,
    AgentRuntimeConfig,
    AgentSession,
    AgentSessionRef,
    AgentSessionRequest,
    AgentTerminal,
    AgentText,
    AgentToolUse,
    ApprovalHandler,
    ApprovalRequest,
    JsonSchemaAgentOutput,
    ScriptedAgentRuntime,
    TextAgentOutput,
    TurnRequest,
    freeze_json_object,
    thaw_json_value,
)

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from apps.codex_agent import health as codex_health
    from apps.codex_agent.host import close_runtime_before_release
    from provider_runtime import Absent as RuntimeAbsent
    from provider_runtime import Present as RuntimePresent
    from provider_runtime.agent_runtime import (
        AgentModelCatalog,
        AgentModelFacts,
        AgentReasoningFacts,
        CodexCatalogSessionRequest,
    )

    from nexus.services.codex_generation_contract import (
        GenerationAdmission,
        GenerationCommand,
        GenerationFrame,
        GenerationHealth,
        GenerationTerminal,
        GenerationToolUse,
        generation_admission_request,
        generation_command_draft,
    )
    from nexus.services.codex_generation_operations import (
        CodexModelToolPlanRegistry,
    )
    from nexus.services.tool_runtime.composition import (
        freeze_tool_plan_snapshot,
    )
    from tests.testkit.codex_generation import (
        codex_generation_command,
        codex_model_tool_fixture,
    )

_VERSIONS = RuntimeVersions(sdk="0.144.4", runtime="0.144.4")
_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"
_MCP_SERVER_NAME = "nexus"
_TOOL_ALLOWLIST = (
    "web.search",
    "nexus.search",
    "nexus.resource.read",
    "nexus.document.search",
    "nexus.resource.inspect",
    "nexus.relations.list",
)
_TOOL_WIRE_ALLOWLIST = tuple(tool.replace(".", "__") for tool in _TOOL_ALLOWLIST)
_LINUX_SUN_PATH_BYTES = 108
_STRUCTURED_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}
_ENROLLED_AUTH = b"test-private-chatgpt-auth"
_REFRESHED_AUTH = b"test-private-chatgpt-auth-refreshed-by-pinned-truncate-write"


def _agent_model_catalog() -> AgentModelCatalog:
    row_fingerprint = "1" * 64
    return AgentModelCatalog(
        backend_contract_revision="provider-runtime.agent-model-catalog.v1",
        definition_revision="2" * 64,
        native_revision=RuntimeAbsent(),
        observed_at=datetime(2026, 8, 31, 12, 0, tzinfo=UTC),
        models=(
            AgentModelFacts(
                key="gpt-5.6-terra",
                dispatch_model="gpt-5.6-terra",
                label="GPT-5.6 Terra",
                source_context_window=RuntimeAbsent(),
                source_max_output_tokens=RuntimeAbsent(),
                input_modalities=("text", "image"),
                reasoning=(
                    AgentReasoningFacts(
                        key="medium",
                        label="Balanced reasoning",
                        native_wire_value="medium",
                    ),
                ),
                source_default_reasoning=RuntimePresent("medium"),
                upgrade=RuntimeAbsent(),
                retirement=RuntimeAbsent(),
                row_fingerprint=row_fingerprint,
            ),
        ),
        diagnostics=(),
    )


def _model_tool_registry() -> CodexModelToolPlanRegistry:
    registry, _runtime = codex_model_tool_fixture()
    return registry


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-generation-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode()) < _LINUX_SUN_PATH_BYTES
    return socket_path


def _expected_health() -> dict[str, str]:
    return {
        "schema_version": "nexus-generation-health.v2",
        "status": "ready",
        "backend": "codex",
        "transport": "sdk",
        "auth_profile": "codex-personal",
        "command_schema_version": "nexus-generation-command.v3",
        "sdk_version": "0.144.4",
        "runtime_version": "0.144.4",
    }


def _health_body_response(body: bytes) -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\n"
        b"content-type: application/json\r\n"
        + f"content-length: {len(body)}\r\n".encode()
        + b"connection: close\r\n\r\n"
        + body
    )


def _health_response(payload: object) -> bytes:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return _health_body_response(body)


def test_container_health_probe_uses_one_bounded_low_dependency_uds_exchange() -> None:
    """Risk: Docker readiness imports a second full product graph into the host cgroup."""

    socket_path = _short_socket_path()
    ready = threading.Event()
    requests: list[bytes] = []
    server_errors: list[BaseException] = []

    def serve_once() -> None:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(socket_path))
                listener.listen(1)
                ready.set()
                connection, _address = listener.accept()
                with connection:
                    request = bytearray()
                    while b"\r\n\r\n" not in request:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise AssertionError("health probe closed before its HTTP request")
                        request.extend(chunk)
                        if len(request) > 4096:
                            raise AssertionError("health probe request exceeded its test bound")
                    requests.append(bytes(request))
                    response = _health_response(_expected_health())
                    connection.sendall(response[:31])
                    connection.sendall(response[31:])
        except BaseException as error:
            server_errors.append(error)
            ready.set()
        finally:
            socket_path.unlink(missing_ok=True)

    server = threading.Thread(target=serve_once)
    server.start()
    assert ready.wait(2)
    observed = codex_health.check(socket_path)
    server.join(2)

    assert not server.is_alive()
    assert server_errors == []
    assert observed == _expected_health()
    assert requests == [
        b"GET /health HTTP/1.1\r\n"
        b"Host: nexus-codex\r\n"
        b"Accept: application/json\r\n"
        b"Connection: close\r\n\r\n"
    ]


def test_container_health_probe_rejects_ambiguous_or_foreign_wire_identity() -> None:
    foreign = _expected_health()
    foreign["runtime_version"] = "foreign-runtime"
    with pytest.raises(RuntimeError, match="identity differs"):
        codex_health._parse_health_response(_health_response(foreign))

    valid = _health_response(_expected_health())
    ambiguous = valid.replace(
        b"content-length:",
        b"content-length: 1\r\ncontent-length:",
        1,
    )
    with pytest.raises(RuntimeError, match="headers are malformed"):
        codex_health._parse_health_response(ambiguous)

    duplicate_body = json.dumps(_expected_health(), sort_keys=True, separators=(",", ":"))
    duplicate_body = duplicate_body.replace(
        '"status":"ready"',
        '"status":"ready","status":"ready"',
    ).encode()
    with pytest.raises(RuntimeError, match="body is malformed"):
        codex_health._parse_health_response(_health_body_response(duplicate_body))

    invalid_header = valid.replace(b"connection: close", b"connection: close\x00", 1)
    with pytest.raises(RuntimeError, match="headers are malformed"):
        codex_health._parse_health_response(invalid_header)

    oversized = _health_response(_expected_health()) + b" " * (4 * 1024)
    with pytest.raises(RuntimeError, match="HTTP envelope is malformed"):
        codex_health._parse_health_response(oversized)


def _capacity_paths(root: Path) -> CapacityPaths:
    capacity_root = root / "capacity"
    capacity_root.mkdir()
    meminfo = capacity_root / "meminfo"
    pressure = capacity_root / "memory.pressure"
    current = capacity_root / "memory.current"
    maximum = capacity_root / "memory.max"
    meminfo.write_text(
        "MemTotal:       2000000 kB\nMemAvailable:     700000 kB\n",
        encoding="ascii",
    )
    pressure.write_text(
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
        encoding="ascii",
    )
    current.write_text(f"{128 * 1024 * 1024}\n", encoding="ascii")
    maximum.write_text(f"{448 * 1024 * 1024}\n", encoding="ascii")
    return CapacityPaths(
        meminfo=meminfo,
        memory_pressure=pressure,
        memory_current=current,
        memory_max=maximum,
    )


def _request_id(index: int) -> UUID:
    return UUID(int=index)


def _grant(index: int) -> str:
    return f"run-scoped-grant-{index}-must-not-leak"


def _command(
    index: int,
    input_text: str,
    *,
    chat: bool = False,
    structured: bool = False,
) -> GenerationCommand:
    model_tool_plan = (
        freeze_tool_plan_snapshot(codex_model_tool_fixture()[1].operations["ChatRead"])
        if chat
        else None
    )
    return codex_generation_command(
        request_id=_request_id(index),
        operation="chat" if chat else "metadata_enrichment",
        instructions=f"instructions-{index}",
        input_text=input_text,
        model="gpt-5.6-terra" if chat else "gpt-5.6-luna",
        reasoning="medium" if chat else "low",
        turn_timeout_seconds=900 if chat else 120,
        structured_schema=_STRUCTURED_SCHEMA if structured else None,
        model_tool_plan=model_tool_plan,
        tool_grant=_grant(index) if chat else None,
    )


def _wire_command(command: GenerationCommand) -> bytes:
    """Encode the sensitive UDS grant that the model deliberately excludes from dumps."""

    payload = command.model_dump(mode="json", exclude={"tool_grant"})
    if command.tool_grant is not None:
        payload["tool_grant"] = {
            "kind": "Bearer",
            "token": command.tool_grant.token.get_secret_value(),
        }
    return json.dumps(payload, separators=(",", ":")).encode()


def _generation_scope(
    body: bytes,
    *,
    admission_id: UUID | None = None,
) -> dict[str, Any]:
    headers = [
        (b"host", b"nexus-codex"),
        (b"accept", b"application/x-ndjson"),
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    if admission_id is not None:
        headers.append((b"nexus-generation-admission", str(admission_id).encode("ascii")))
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v2/generations",
        "raw_path": b"/v2/generations",
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 41234),
        "server": ("nexus-codex", 80),
        "state": {},
    }


def _session_ref(index: int) -> AgentSessionRef:
    return AgentSessionRef(
        schema_version="agent-session-ref.v1",
        backend="codex",
        transport="sdk",
        native_session_id=f"thread-{index}",
        profile_key="codex-personal",
        state_root_fingerprint="1" * 64,
        cwd_fingerprint="2" * 64,
    )


def _runtime_terminal(index: int, *, structured: bool = False) -> AgentTerminal:
    return AgentTerminal(
        status="succeeded",
        failure=None,
        final_text='{"answer":"ok"}' if structured else f"result-{index}",
        structured_output=freeze_json_object({"answer": "ok"}) if structured else None,
        session_ref=_session_ref(index),
    )


def _script(index: int) -> tuple[AgentEvent, ...]:
    allowed_name = f"{_MCP_SERVER_NAME}/{_TOOL_WIRE_ALLOWLIST[0]}"
    if index == 1:
        return (AgentText("ok"), _runtime_terminal(index, structured=True))
    if index == 2:
        return (
            AgentText("chat-text-is-relayed-per-event"),
            AgentToolUse("tool-2", allowed_name, "started"),
            AgentToolUse("tool-2", allowed_name, "completed", succeeded=True),
            _runtime_terminal(index),
        )
    if index == 3:
        return (
            AgentToolUse("tool-3", allowed_name, "started"),
            _runtime_terminal(index),
        )
    if index == 4:
        return (
            AgentPermissionRequest(
                ApprovalRequest(
                    operation="tool_use",
                    summary="permission must remain denied",
                    tool_name=_TOOL_ALLOWLIST[0],
                ),
                "deny",
            ),
            _runtime_terminal(index),
        )
    if index == 5:
        return (
            AgentToolUse("tool-5", "commandExecution", "started"),
            _runtime_terminal(index),
        )
    if index in (7, 9, 11):
        return (_runtime_terminal(index),)
    raise AssertionError(f"no deterministic runtime script for generation {index}")


class _InspectingRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        index: int,
        config: AgentRuntimeConfig,
        report: multiprocessing.connection.Connection,
    ) -> None:
        super().__init__(
            sessions=(AgentSession(_session_ref(index)),),
            stream_scripts=(_script(index),),
        )
        self._index = index
        self._config = config
        self._report = report
        self._opened: AgentSessionRequest | None = None
        self._resolver_name: str | None = None
        self._resolver_matches = False
        self._cwd_empty_on_open = False
        self._cwd_residue: Path | None = None
        self._runtime_auth_at_open: bytes | None = None
        self._durable_auth_after_open: bytes | None = None
        self._state_residue: Path | None = None

    async def open_session(self, request: AgentSessionRequest) -> AgentSession:
        session = await super().open_session(request)
        self._opened = request
        cwd = Path(request.cwd)
        self._cwd_empty_on_open = not any(cwd.iterdir())
        self._cwd_residue = cwd / "runtime-residue"
        self._cwd_residue.write_text(f"turn-{self._index}", encoding="utf-8")
        auth = self._config.state_root_base / "codex" / "codex-personal" / "auth.json"
        self._runtime_auth_at_open = auth.read_bytes()
        state_residue = self._config.state_root_base / "runtime-residue"
        state_residue.write_text(f"turn-{self._index}", encoding="utf-8")
        self._state_residue = state_residue
        if self._index == 1:
            # Pinned rust-v0.144.4 FileAuthStorage::save opens auth.json with
            # truncate/write/create, then write_all + flush. Reproduce that exact
            # persistence primitive rather than inventing an atomic replacement.
            with auth.open("wb") as refreshed:
                refreshed.write(_REFRESHED_AUTH)
                refreshed.flush()
        self._durable_auth_after_open = Path(auth.readlink()).read_bytes()
        if request.mcp_servers:
            server = request.mcp_servers[0]
            assert len(server.header_refs) == 1
            source = server.header_refs[0].source
            assert source.name is not None
            assert self._config.secret_resolver is not None
            resolved = await self._config.secret_resolver(source.name)
            self._resolver_name = source.name
            self._resolver_matches = resolved == f"Bearer {_grant(self._index)}"
        return session

    async def close(self) -> None:
        await super().close()
        opened = self._opened
        assert opened is not None
        streamed = self.calls[1].subject
        assert isinstance(streamed, tuple)
        turn = streamed[1]
        assert isinstance(turn, TurnRequest)
        self._report.send(
            {
                "kind": "lowering",
                "index": self._index,
                "request": _captured_request(
                    opened,
                    turn,
                    approvals_supplied=self.calls[1].approvals_supplied,
                    cancel_supplied=self.calls[1].cancel_supplied,
                ),
                "state_root_base": str(self._config.state_root_base),
                "runtime_auth_at_open": self._runtime_auth_at_open,
                "durable_auth_after_open": self._durable_auth_after_open,
                "runtime_auth_after_close": (
                    self._config.state_root_base / "codex" / "codex-personal" / "auth.json"
                ).read_bytes(),
                "runtime_auth_link_target": str(
                    (
                        self._config.state_root_base / "codex" / "codex-personal" / "auth.json"
                    ).readlink()
                ),
                "resolver_present": self._config.secret_resolver is not None,
                "resolver_matches": self._resolver_matches,
                "secret_absent_from_repr": _grant(self._index) not in f"{self._config!r}{opened!r}",
                "cwd_empty_on_open": self._cwd_empty_on_open,
                "cwd_residue_present_at_close": (
                    self._cwd_residue is not None and self._cwd_residue.is_file()
                ),
                "state_residue_present_at_close": (
                    self._state_residue is not None and self._state_residue.is_file()
                ),
            }
        )
        resolver = self._config.secret_resolver
        resolver_name = self._resolver_name
        if resolver is not None and resolver_name is not None:

            async def probe_after_host_cleanup() -> None:
                try:
                    await resolver(resolver_name)
                except Exception:
                    cleared = True
                else:
                    cleared = False
                self._report.send(
                    {"kind": "resolver_cleanup", "index": self._index, "cleared": cleared}
                )

            asyncio.create_task(probe_after_host_cleanup())


def _captured_request(
    opened: AgentSessionRequest,
    turn: TurnRequest,
    *,
    approvals_supplied: bool,
    cancel_supplied: bool,
) -> dict[str, object]:
    assert isinstance(opened, CodexCatalogSessionRequest)
    native = opened.native
    output: dict[str, object] = {"kind": opened.output.kind}
    if isinstance(opened.output, JsonSchemaAgentOutput):
        output.update(
            name=opened.output.name,
            schema=thaw_json_value(opened.output.schema),
        )
    assert isinstance(opened.output, JsonSchemaAgentOutput | TextAgentOutput)
    servers = tuple(
        {
            "name": server.name,
            "transport": server.transport,
            "command": server.command,
            "args": server.args,
            "url": server.url,
            "environment_refs": server.environment_refs,
            "headers": tuple(
                (
                    header.name,
                    header.source.kind,
                    header.source.profile_key,
                    header.source.name,
                )
                for header in server.header_refs
            ),
            "required": server.required,
            "allowed_tools": server.allowed_tools,
            "denied_tools": server.denied_tools,
        }
        for server in opened.mcp_servers
    )
    unsafe = opened.policy.unsafe_confirmation
    return {
        "backend": opened.backend,
        "transport": opened.transport,
        "auth": (opened.auth.kind, opened.auth.profile_key, opened.auth.name),
        "open": opened.open.kind,
        "model": opened.model_key,
        "reasoning": opened.reasoning,
        "agent_definition_revision": opened.agent_definition_revision,
        "row_fingerprint": opened.row_fingerprint,
        "system": tuple(part.text for part in opened.system),
        "developer": tuple(part.text for part in opened.developer),
        "cwd": opened.cwd,
        "additional_dirs": opened.additional_dirs,
        "policy": {
            "filesystem": opened.policy.filesystem,
            "network": opened.policy.network,
            "network_allowlist": opened.policy.network_allowlist,
            "approval": opened.policy.approval,
            "allowed_tools": opened.policy.allowed_tools,
            "denied_tools": opened.policy.denied_tools,
            "environment": opened.policy.environment,
            "unsafe": unsafe.acknowledged if unsafe is not None else None,
        },
        "mcp_servers": servers,
        "output": output,
        "native_web_search": native.web_search if native else None,
        "native_builtin_tools": native.builtin_tools if native else None,
        "turn_input": tuple(part.text for part in turn.input),
        "turn_policy": turn.policy,
        "turn_timeout_seconds": turn.timeout_seconds,
        "approvals_supplied": approvals_supplied,
        "cancel_supplied": cancel_supplied,
    }


class _InterruptRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        index: int,
        started: Any,
        interrupt_observed: Any,
        close_started: Any,
        close_release: Any,
        close_finished: Any,
    ) -> None:
        super().__init__(sessions=(AgentSession(_session_ref(index)),))
        self._index = index
        self._started = started
        self._interrupt_observed = interrupt_observed
        self._close_started = close_started
        self._close_release = close_release
        self._close_finished = close_finished

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: Any = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals
        assert cancel is not None, "v2 host must give AgentRuntime the request cancel signal"
        self._started.set()
        await cancel.wait()
        self._interrupt_observed.set()
        yield AgentTerminal(
            status="cancelled",
            failure=None,
            final_text="",
            structured_output=None,
            session_ref=_session_ref(self._index),
        )

    async def close(self) -> None:
        self._close_started.set()
        released = await asyncio.to_thread(self._close_release.wait, 10)
        assert released, "slot-ownership proof did not release runtime close"
        await super().close()
        self._close_finished.set()


class _DisconnectRuntime(_InterruptRuntime):
    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: Any = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals
        assert cancel is not None
        self._started.set()
        try:
            yield AgentText("accepted-before-disconnect")
            await asyncio.Future()
        finally:
            self._interrupt_observed.set()


class _ResponseStartFailureRuntime(ScriptedAgentRuntime):
    """Hold one admitted owner live while its ASGI response-start fails."""

    def __init__(self, started: asyncio.Event, closed: asyncio.Event) -> None:
        super().__init__(sessions=(AgentSession(_session_ref(30)),))
        self._started = started
        self._closed = closed

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: Any = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals, cancel
        self._started.set()
        yield AgentText("queued-before-response-start-failure")
        await asyncio.Future()

    async def close(self) -> None:
        await super().close()
        self._closed.set()


class _RepeatedCancellationCloseRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        started: asyncio.Event,
        release: asyncio.Event,
        cancelled: asyncio.Event,
        finished: asyncio.Event,
    ) -> None:
        super().__init__()
        self._started = started
        self._release = release
        self._cancelled = cancelled
        self._finished = finished

    async def close(self) -> None:
        self._started.set()
        try:
            await self._release.wait()
        except asyncio.CancelledError:
            self._cancelled.set()
            raise
        await super().close()
        self._finished.set()


class _CredentialIdentitySwapRuntime(ScriptedAgentRuntime):
    def __init__(self, config: AgentRuntimeConfig, credential_file: Path) -> None:
        super().__init__(
            sessions=(AgentSession(_session_ref(32)),),
            stream_scripts=((_runtime_terminal(32),),),
        )
        self._config = config
        self._credential_file = credential_file

    async def close(self) -> None:
        await super().close()
        runtime_auth = self._config.state_root_base / "codex" / "codex-personal" / "auth.json"
        assert runtime_auth.readlink() == self._credential_file
        replacement = self._credential_file.with_name("replacement-auth.json")
        replacement.write_bytes(b"invalid-rename-based-refresh")
        replacement.chmod(0o600)
        os.replace(replacement, self._credential_file)


class _CancelledFailingCloseRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        stream_started: asyncio.Event,
        close_started: asyncio.Event,
        close_release: asyncio.Event,
    ) -> None:
        super().__init__(sessions=(AgentSession(_session_ref(34)),))
        self._stream_started = stream_started
        self._close_started = close_started
        self._close_release = close_release

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: Any = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals, cancel
        self._stream_started.set()
        yield AgentText("accepted-before-failed-cancel-reap")
        await asyncio.Future()

    async def close(self) -> None:
        self._close_started.set()
        await self._close_release.wait()
        raise RuntimeError("synthetic native reap failure")


async def _serve_until_stopped(
    server: uvicorn.Server,
    listener: socket.socket,
    stop: Any,
) -> None:
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    await asyncio.to_thread(stop.wait)
    server.should_exit = True
    await serving


def _run_generation_host(
    socket_path: str,
    cwd: str,
    credential_file: str,
    capacity_root: str,
    started: Any,
    cancel_observed: Any,
    close_started: Any,
    close_release: Any,
    close_finished: Any,
    policy_started: Any,
    policy_observed: Any,
    policy_close_started: Any,
    policy_close_release: Any,
    policy_close_finished: Any,
    stop: Any,
    model_tool_network_attested: bool,
    report: multiprocessing.connection.Connection,
    ready: multiprocessing.connection.Connection,
) -> None:
    paths = CapacityPaths(
        meminfo=Path(capacity_root) / "meminfo",
        memory_pressure=Path(capacity_root) / "memory.pressure",
        memory_current=Path(capacity_root) / "memory.current",
        memory_max=Path(capacity_root) / "memory.max",
    )
    runtime_index = 0

    def runtime_factory(config: AgentRuntimeConfig) -> ScriptedAgentRuntime:
        nonlocal runtime_index
        runtime_index += 1
        report.send({"kind": "factory", "index": runtime_index})
        if runtime_index == 6:
            return _InterruptRuntime(
                6,
                started,
                cancel_observed,
                close_started,
                close_release,
                close_finished,
            )
        if runtime_index == 8:
            return _InterruptRuntime(
                8,
                policy_started,
                policy_observed,
                policy_close_started,
                policy_close_release,
                policy_close_finished,
            )
        if runtime_index == 10:
            return _DisconnectRuntime(
                10,
                policy_started,
                policy_observed,
                policy_close_started,
                policy_close_release,
                policy_close_finished,
            )
        if runtime_index == 12:
            return _InterruptRuntime(
                12,
                started,
                cancel_observed,
                close_started,
                close_release,
                close_finished,
            )
        return _InspectingRuntime(runtime_index, config, report)

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory_root=Path(cwd),
        credential_file=Path(credential_file),
        mcp_origin=_MCP_ORIGIN,
        model_tool_network_attested=model_tool_network_attested,
        versions=_VERSIONS,
        model_tool_registry=_model_tool_registry(),
        capacity_paths=paths,
    )
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    try:
        listener.bind(socket_path)
        os.chmod(socket_path, 0o660)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(_serve_until_stopped(server, listener, stop))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _start_host(
    socket_path: Path,
    cwd: Path,
    credential_file: Path,
    capacity_root: Path,
    events: tuple[Any, ...],
    *,
    model_tool_network_attested: bool,
) -> tuple[
    multiprocessing.Process,
    multiprocessing.connection.Connection,
    multiprocessing.connection.Connection,
]:
    context = multiprocessing.get_context("fork")
    (
        started,
        cancel_observed,
        close_started,
        close_release,
        close_finished,
        policy_started,
        policy_observed,
        policy_close_started,
        policy_close_release,
        policy_close_finished,
        stop,
    ) = events
    report_parent, report_child = context.Pipe(duplex=False)
    ready_parent, ready_child = context.Pipe(duplex=False)
    process = context.Process(
        target=_run_generation_host,
        args=(
            str(socket_path),
            str(cwd),
            str(credential_file),
            str(capacity_root),
            started,
            cancel_observed,
            close_started,
            close_release,
            close_finished,
            policy_started,
            policy_observed,
            policy_close_started,
            policy_close_release,
            policy_close_finished,
            stop,
            model_tool_network_attested,
            report_child,
            ready_child,
        ),
    )
    process.start()
    report_child.close()
    ready_child.close()
    assert ready_parent.poll(5), f"UDS generation host {process.pid} did not become ready"
    assert ready_parent.recv() == "ready"
    return process, report_parent, ready_parent


async def _post(
    client: httpx.AsyncClient,
    command: GenerationCommand,
) -> tuple[int, str, bytes]:
    headers = {
        "accept": "application/x-ndjson",
        "content-type": "application/json",
    }
    admission_response = await client.post(
        "http://nexus-codex/v2/generation-admissions",
        headers={"accept": "application/json", "content-type": "application/json"},
        content=generation_admission_request(generation_command_draft(command))
        .model_dump_json()
        .encode("utf-8"),
    )
    if admission_response.status_code != 200:
        return (
            admission_response.status_code,
            admission_response.headers.get("content-type", ""),
            admission_response.content,
        )
    admission = GenerationAdmission.model_validate_json(admission_response.content)
    headers["nexus-generation-admission"] = str(admission.admission_id)
    response = await client.post(
        "http://nexus-codex/v2/generations",
        headers=headers,
        content=_wire_command(command),
    )
    return (
        response.status_code,
        response.headers.get("content-type", ""),
        response.content,
    )


def test_authenticated_catalog_crosses_the_private_host_boundary(tmp_path: Path) -> None:
    """Risk: the API process must discover account-visible Codex targets without SDK access."""

    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir(mode=0o700)
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        runtime = ScriptedAgentRuntime(model_catalogs=(_agent_model_catalog(),))
        app = create_codex_agent_app(
            runtime_factory=lambda _config: runtime,
            working_directory_root=working_root,
            credential_file=credential_file,
            versions=_VERSIONS,
            model_tool_registry=CodexModelToolPlanRegistry(()),
            capacity_paths=_capacity_paths(tmp_path),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            timeout=5,
        ) as client:
            response = await client.get(
                "http://nexus-codex/v2/model-catalog",
                headers={"accept": "application/json"},
            )

        assert response.status_code == 200, (
            "the private host must expose the authenticated AgentRuntime catalog; "
            f"actual={response.status_code} body={response.text!r}"
        )
        payload = response.json()
        assert payload["definition_revision"] == "2" * 64
        assert payload["models"] == [
            {
                "key": "gpt-5.6-terra",
                "dispatch_model": "gpt-5.6-terra",
                "label": "GPT-5.6 Terra",
                "source_context_window": {"kind": "Absent"},
                "source_max_output_tokens": {"kind": "Absent"},
                "input_modalities": ["text", "image"],
                "reasoning": [
                    {
                        "key": "medium",
                        "label": "Balanced reasoning",
                        "native_wire_value": "medium",
                    }
                ],
                "source_default_reasoning": {
                    "kind": "Present",
                    "value": "medium",
                },
                "upgrade": {"kind": "Absent"},
                "retirement": {"kind": "Absent"},
                "row_fingerprint": "1" * 64,
            }
        ]
        call = runtime.calls[0]
        assert call.operation == "model_catalog"
        backend, transport, auth = cast(tuple[str, str, Any], call.subject)
        assert (backend, transport, auth.kind, auth.profile_key) == (
            "codex",
            "sdk",
            "local_account",
            "codex-personal",
        )

    asyncio.run(scenario())


def test_chat_admission_is_replay_stable_command_bound_and_consumed_once(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir()
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        command = _command(60, "admission-bound-chat", chat=True)
        other = _command(61, "different-chat", chat=True)
        app = create_codex_agent_app(
            runtime_factory=lambda _config: ScriptedAgentRuntime(
                sessions=(AgentSession(_session_ref(60)),),
                stream_scripts=((_runtime_terminal(60),),),
            ),
            working_directory_root=working_root,
            credential_file=credential_file,
            versions=_VERSIONS,
            model_tool_registry=_model_tool_registry(),
            mcp_origin=_MCP_ORIGIN,
            model_tool_network_attested=True,
            capacity_paths=_capacity_paths(tmp_path),
        )
        transport = httpx.ASGITransport(app=app)
        admission_headers = {
            "accept": "application/json",
            "content-type": "application/json",
        }
        generation_headers = {
            "accept": "application/x-ndjson",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            missing = await client.post(
                "http://nexus-codex/v2/generations",
                headers=generation_headers,
                content=_wire_command(command),
            )
            assert missing.status_code == 409

            admission_body = (
                generation_admission_request(generation_command_draft(command))
                .model_dump_json()
                .encode()
            )
            first = await client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers=admission_headers,
                content=admission_body,
            )
            replay = await client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers=admission_headers,
                content=admission_body,
            )
            admitted = GenerationAdmission.model_validate_json(first.content)
            assert replay.content == first.content
            assert admitted.request_id == command.request_id
            assert admitted.runtime_deadline_seconds == 900

            conflicting = await client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers=admission_headers,
                content=generation_admission_request(generation_command_draft(other))
                .model_dump_json()
                .encode(),
            )
            assert (conflicting.status_code, conflicting.content) == (
                503,
                b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}',
            )

            mismatched = await client.post(
                "http://nexus-codex/v2/generations",
                headers=generation_headers
                | {"nexus-generation-admission": str(admitted.admission_id)},
                content=_wire_command(other),
            )
            assert mismatched.status_code == 409

            replacement_response = await client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers=admission_headers,
                content=admission_body,
            )
            replacement = GenerationAdmission.model_validate_json(replacement_response.content)
            assert replacement.admission_id != admitted.admission_id
            accepted = await client.post(
                "http://nexus-codex/v2/generations",
                headers=generation_headers
                | {"nexus-generation-admission": str(replacement.admission_id)},
                content=_wire_command(command),
            )
            frames = _frames(command, accepted.content)
            assert accepted.status_code == 200
            assert _terminal(frames).accepted_at == replacement.admitted_at

            consumed = await client.post(
                "http://nexus-codex/v2/generations",
                headers=generation_headers
                | {"nexus-generation-admission": str(replacement.admission_id)},
                content=_wire_command(command),
            )
            assert consumed.status_code == 409
        assert not tuple(working_root.iterdir())

    asyncio.run(scenario())


def test_response_start_failure_reclaims_owner_slot_and_ephemeral_root(
    tmp_path: Path,
) -> None:
    """The response call owns cleanup even before its iterator is entered."""

    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir()
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        runtime_started = asyncio.Event()
        runtime_closed = asyncio.Event()
        runtime_index = 0

        def runtime_factory(_config: AgentRuntimeConfig) -> ScriptedAgentRuntime:
            nonlocal runtime_index
            runtime_index += 1
            if runtime_index == 1:
                return _ResponseStartFailureRuntime(runtime_started, runtime_closed)
            return ScriptedAgentRuntime(
                sessions=(AgentSession(_session_ref(31)),),
                stream_scripts=((_runtime_terminal(31),),),
            )

        app = create_codex_agent_app(
            runtime_factory=runtime_factory,
            working_directory_root=working_root,
            credential_file=credential_file,
            versions=_VERSIONS,
            model_tool_registry=_model_tool_registry(),
            capacity_paths=_capacity_paths(tmp_path),
        )
        command = _command(30, "response-start-failure")
        body = _wire_command(command)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            timeout=5,
        ) as admission_client:
            admission_response = await admission_client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers={"accept": "application/json", "content-type": "application/json"},
                content=generation_admission_request(generation_command_draft(command))
                .model_dump_json()
                .encode(),
            )
        admission = GenerationAdmission.model_validate_json(admission_response.content)
        scope = _generation_scope(body, admission_id=admission.admission_id)
        request_delivered = False
        never_disconnect = asyncio.Event()

        async def receive() -> dict[str, Any]:
            nonlocal request_delivered
            if not request_delivered:
                request_delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await never_disconnect.wait()
            raise AssertionError("unreachable")

        async def fail_response_start(message: dict[str, Any]) -> None:
            assert message["type"] == "http.response.start"
            await asyncio.wait_for(runtime_started.wait(), timeout=2)
            raise RuntimeError("synthetic response-start failure")

        with pytest.raises(RuntimeError, match="synthetic response-start failure"):
            await app(scope, receive, fail_response_start)

        assert runtime_closed.is_set()
        assert not tuple(working_root.iterdir())

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            status, media_type, response_body = await _post(
                client, _command(31, "after-response-start-failure")
            )
        assert (status, media_type.split(";", 1)[0]) == (
            200,
            "application/x-ndjson",
        )
        assert _terminal(_frames(_command(31, "unused"), response_body)).status == ("succeeded")
        assert runtime_index == 2
        assert not tuple(working_root.iterdir())

    asyncio.run(scenario())


def test_cancellation_before_owner_first_execution_reclaims_admission(
    tmp_path: Path,
) -> None:
    """The endpoint owns cleanup until the owner's first try statement executes."""

    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir()
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        runtime_count = 0

        def runtime_factory(_config: AgentRuntimeConfig) -> ScriptedAgentRuntime:
            nonlocal runtime_count
            runtime_count += 1
            return ScriptedAgentRuntime(
                sessions=(AgentSession(_session_ref(33)),),
                stream_scripts=((_runtime_terminal(33),),),
            )

        app = create_codex_agent_app(
            runtime_factory=runtime_factory,
            working_directory_root=working_root,
            credential_file=credential_file,
            versions=_VERSIONS,
            model_tool_registry=_model_tool_registry(),
            capacity_paths=_capacity_paths(tmp_path),
        )
        command = _command(30, "cancel-before-owner-first-execution")
        body = _wire_command(command)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            timeout=5,
        ) as admission_client:
            admission_response = await admission_client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers={"accept": "application/json", "content-type": "application/json"},
                content=generation_admission_request(generation_command_draft(command))
                .model_dump_json()
                .encode(),
            )
        admission = GenerationAdmission.model_validate_json(admission_response.content)
        body_consumed = asyncio.Event()

        async def receive() -> dict[str, Any]:
            body_consumed.set()
            return {"type": "http.request", "body": body, "more_body": False}

        async def unreachable_send(_message: dict[str, Any]) -> None:
            raise AssertionError("pre-start cancellation reached the response boundary")

        request = asyncio.create_task(
            app(
                _generation_scope(body, admission_id=admission.admission_id),
                receive,
                unreachable_send,
            )
        )
        await body_consumed.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request

        assert runtime_count == 0
        assert not tuple(working_root.iterdir())

        followup = _command(33, "after-pre-start-cancellation")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            status, media_type, response_body = await _post(client, followup)
        assert (status, media_type.split(";", 1)[0]) == (
            200,
            "application/x-ndjson",
        )
        assert _terminal(_frames(followup, response_body)).status == "succeeded"
        assert runtime_count == 1
        assert not tuple(working_root.iterdir())

    asyncio.run(scenario())


def test_repeated_cancellation_cannot_cut_short_the_bounded_runtime_close() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        close_cancelled = asyncio.Event()
        finished = asyncio.Event()
        runtime = _RepeatedCancellationCloseRuntime(
            started,
            release,
            close_cancelled,
            finished,
        )
        runtime_close_unproven = asyncio.Event()
        owner = asyncio.create_task(
            close_runtime_before_release(
                runtime,
                timeout_seconds=5,
                runtime_close_unproven=runtime_close_unproven,
            )
        )
        await asyncio.wait_for(started.wait(), timeout=1)

        repeated_cancellation_dispatched = asyncio.Event()

        def cancel_again() -> None:
            owner.cancel()
            repeated_cancellation_dispatched.set()

        owner.cancel()
        asyncio.get_running_loop().call_soon(cancel_again)
        await asyncio.wait_for(repeated_cancellation_dispatched.wait(), timeout=1)

        assert not owner.done()
        assert not close_cancelled.is_set()
        assert not finished.is_set()

        release.set()
        with pytest.raises(asyncio.CancelledError):
            await owner
        assert finished.is_set()
        assert not close_cancelled.is_set()
        assert not runtime_close_unproven.is_set()

    asyncio.run(scenario())


def test_failed_runtime_reap_during_cancellation_makes_host_unready(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir()
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        stream_started = asyncio.Event()
        close_started = asyncio.Event()
        close_release = asyncio.Event()
        runtime_count = 0

        def runtime_factory(_config: AgentRuntimeConfig) -> ScriptedAgentRuntime:
            nonlocal runtime_count
            runtime_count += 1
            return _CancelledFailingCloseRuntime(
                stream_started,
                close_started,
                close_release,
            )

        app = create_codex_agent_app(
            runtime_factory=runtime_factory,
            working_directory_root=working_root,
            credential_file=credential_file,
            mcp_origin=_MCP_ORIGIN,
            model_tool_network_attested=True,
            versions=_VERSIONS,
            model_tool_registry=_model_tool_registry(),
            capacity_paths=_capacity_paths(tmp_path),
        )
        command = _command(34, "cancel-while-runtime-close-fails", chat=True)
        body = _wire_command(command)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            admission_response = await client.post(
                "http://nexus-codex/v2/generation-admissions",
                headers={
                    "accept": "application/json",
                    "content-type": "application/json",
                },
                content=generation_admission_request(generation_command_draft(command))
                .model_dump_json()
                .encode(),
            )
        assert admission_response.status_code == 200
        admission = GenerationAdmission.model_validate_json(admission_response.content)
        request_delivered = False
        never_disconnect = asyncio.Event()
        first_body_sent = asyncio.Event()

        async def receive() -> dict[str, Any]:
            nonlocal request_delivered
            if not request_delivered:
                request_delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await never_disconnect.wait()
            raise AssertionError("unreachable")

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.body" and message.get("body"):
                first_body_sent.set()

        request = asyncio.create_task(
            app(
                _generation_scope(body, admission_id=admission.admission_id),
                receive,
                send,
            )
        )
        await asyncio.wait_for(stream_started.wait(), timeout=1)
        await asyncio.wait_for(first_body_sent.wait(), timeout=1)
        request.cancel()
        await asyncio.wait_for(close_started.wait(), timeout=1)
        request.cancel()
        close_release.set()
        with pytest.raises(asyncio.CancelledError):
            await request

        assert runtime_count == 1
        assert not tuple(working_root.iterdir())

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            health = await client.get("http://nexus-codex/health")
            rejected = await _post(client, _command(35, "after-unproven-reap"))
        assert health.status_code == 503
        assert rejected[0] == 503
        assert runtime_count == 1

    asyncio.run(scenario())


def test_credential_identity_failure_is_fatal_before_any_success_terminal(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        working_root = tmp_path / "runtime"
        working_root.mkdir()
        credential_file = tmp_path / "auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)

        def runtime_factory(config: AgentRuntimeConfig) -> ScriptedAgentRuntime:
            return _CredentialIdentitySwapRuntime(config, credential_file)

        app = create_codex_agent_app(
            runtime_factory=runtime_factory,
            working_directory_root=working_root,
            credential_file=credential_file,
            versions=_VERSIONS,
            model_tool_registry=_model_tool_registry(),
            capacity_paths=_capacity_paths(tmp_path),
        )
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        command = _command(32, "rename-credential-instead-of-in-place-refresh")
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            status, media_type, body = await _post(client, command)
            health = await client.get("http://nexus-codex/health")

        assert (status, media_type.split(";", 1)[0]) == (
            200,
            "application/x-ndjson",
        )
        terminal = _terminal(_frames(command, body))
        assert terminal.status == "failed"
        assert terminal.failure is not None
        assert terminal.failure.kind == "runtime_defect"
        assert health.status_code == 503
        assert not tuple(working_root.iterdir())

    asyncio.run(scenario())


def _frames(command: GenerationCommand, body: bytes) -> tuple[GenerationFrame, ...]:
    frames = tuple(GenerationFrame.model_validate_json(line) for line in body.splitlines())
    assert frames, f"generation {command.request_id} returned an empty stream"
    assert [frame.sequence for frame in frames] == list(range(len(frames)))
    assert all(frame.request_id == command.request_id for frame in frames)
    assert isinstance(frames[-1].event, GenerationTerminal)
    assert not any(isinstance(frame.event, GenerationTerminal) for frame in frames[:-1])
    return frames


def _terminal(frames: tuple[GenerationFrame, ...]) -> GenerationTerminal:
    terminal = frames[-1].event
    assert isinstance(terminal, GenerationTerminal)
    return terminal


def _messages(
    connection: multiprocessing.connection.Connection,
) -> Iterator[Mapping[str, object]]:
    while connection.poll():
        try:
            yield cast(Mapping[str, object], connection.recv())
        except EOFError:
            return


def test_real_uds_v2_host_lowers_tools_confines_grants_and_owns_abort_slot(
    tmp_path: Path,
) -> None:
    assert _CUTOVER_PRESENT, "the v2 route-neutral generation host cutover is absent"
    context = multiprocessing.get_context("fork")

    def unreachable_runtime_factory(
        _config: AgentRuntimeConfig,
    ) -> ScriptedAgentRuntime:
        raise AssertionError("invalid host configuration constructed a runtime")

    invalid_origins = (
        "https://MCP.nexus.example.com/internal/agent-tools/mcp",
        "https://mcp.nexus.example.com:443/internal/agent-tools/mcp",
        "https://user@mcp.nexus.example.com/internal/agent-tools/mcp",
        "https://mcp.nexus.example.com/internal/agent-tools/mcp?query=1",
        "https://mcp.nexus.example.com/internal/agent-tools/mcp#fragment",
        "https://mcp.nexus.example.com/other",
        "https://localhost/internal/agent-tools/mcp",
        "https://127.0.0.1/internal/agent-tools/mcp",
        "https://mcp.nexus.internal/internal/agent-tools/mcp",
    )
    for invalid_origin in invalid_origins:
        credential_file = tmp_path / "invalid-origin-auth.json"
        credential_file.write_bytes(_ENROLLED_AUTH)
        credential_file.chmod(0o600)
        with pytest.raises(ValueError, match="canonical public HTTPS"):
            create_codex_agent_app(
                runtime_factory=unreachable_runtime_factory,
                working_directory_root=tmp_path,
                credential_file=credential_file,
                versions=_VERSIONS,
                model_tool_registry=_model_tool_registry(),
                mcp_origin=invalid_origin,
                model_tool_network_attested=True,
            )

    version_gate_credential = tmp_path / "version-gate-auth.json"
    version_gate_credential.write_bytes(_ENROLLED_AUTH)
    version_gate_credential.chmod(0o600)
    with pytest.raises(ValueError, match="qualified only for pinned 0.144.4"):
        create_codex_agent_app(
            runtime_factory=unreachable_runtime_factory,
            working_directory_root=tmp_path,
            credential_file=version_gate_credential,
            versions=RuntimeVersions(sdk="0.144.5", runtime="0.144.4"),
            model_tool_registry=_model_tool_registry(),
        )

    unattested_root = tmp_path / "unattested"
    unattested_cwd = unattested_root / "empty-cwd"
    unattested_credential = unattested_root / "auth.json"
    unattested_root.mkdir()
    unattested_cwd.mkdir()
    unattested_credential.write_bytes(_ENROLLED_AUTH)
    unattested_credential.chmod(0o600)
    unattested_paths = _capacity_paths(unattested_root)
    unattested_events = tuple(context.Event() for _ in range(11))
    unattested_socket = _short_socket_path()
    unattested_process, unattested_report, unattested_ready = _start_host(
        unattested_socket,
        unattested_cwd,
        unattested_credential,
        unattested_paths.meminfo.parent,
        unattested_events,
        model_tool_network_attested=False,
    )
    try:

        async def refuse_unattested_chat() -> tuple[int, str, bytes]:
            transport = httpx.AsyncHTTPTransport(uds=str(unattested_socket))
            async with httpx.AsyncClient(transport=transport, timeout=5) as client:
                return await _post(client, _command(20, "unattested-chat", chat=True))

        rejection = asyncio.run(refuse_unattested_chat())
        assert rejection[0] == 422
    finally:
        unattested_events[-1].set()
        unattested_process.join(5)
        if unattested_process.is_alive():
            unattested_process.terminate()
            unattested_process.join(5)
        unattested_ready.close()
    try:
        assert unattested_process.exitcode == 0
        assert not tuple(_messages(unattested_report)), (
            "unattested ModelTools constructed a runtime"
        )
    finally:
        unattested_report.close()

    started = context.Event()
    cancel_observed = context.Event()
    close_started = context.Event()
    close_release = context.Event()
    close_finished = context.Event()
    policy_started = context.Event()
    policy_observed = context.Event()
    policy_close_started = context.Event()
    policy_close_release = context.Event()
    policy_close_finished = context.Event()
    stop = context.Event()
    events = (
        started,
        cancel_observed,
        close_started,
        close_release,
        close_finished,
        policy_started,
        policy_observed,
        policy_close_started,
        policy_close_release,
        policy_close_finished,
        stop,
    )
    socket_path = _short_socket_path()
    cwd = tmp_path / "empty-cwd"
    credential_file = tmp_path / "enrolled-auth.json"
    cwd.mkdir()
    credential_file.write_bytes(_ENROLLED_AUTH)
    credential_file.chmod(0o600)
    paths = _capacity_paths(tmp_path)
    process, report, ready = _start_host(
        socket_path,
        cwd,
        credential_file,
        paths.meminfo.parent,
        events,
        model_tool_network_attested=True,
    )
    reports: list[Mapping[str, object]] = []

    def collect_reports() -> None:
        while True:
            try:
                reports.append(cast(Mapping[str, object], report.recv()))
            except EOFError:
                return

    report_collector = threading.Thread(target=collect_reports)
    report_collector.start()

    commands = {
        1: _command(1, "synthesis", structured=True),
        2: _command(2, "chat-allowed", chat=True),
        3: _command(3, "synthesis-tool-forbidden"),
        4: _command(4, "chat-permission-forbidden", chat=True),
        5: _command(5, "chat-builtin-forbidden", chat=True),
        6: _command(6, "hold-for-cancel"),
        7: _command(7, "after-cancel"),
        8: _command(8, "hold-for-policy-violation", chat=True),
        9: _command(9, "after-policy-violation"),
        10: _command(10, "hold-for-disconnect", chat=True),
        11: _command(11, "after-disconnect"),
        13: _command(13, "pure-cancellation"),
    }
    observed: dict[int, tuple[GenerationFrame, ...]] = {}
    try:

        async def exercise() -> None:
            transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
            async with httpx.AsyncClient(transport=transport, timeout=5) as client:
                health_response = await client.get("http://nexus-codex/health")
                health = GenerationHealth.model_validate_json(health_response.content)
                assert health == GenerationHealth(
                    sdk_version=_VERSIONS.sdk,
                    runtime_version=_VERSIONS.runtime,
                )

                paths.memory_current.write_text(
                    f"{449 * 1024 * 1024}\n",
                    encoding="ascii",
                )
                capacity_refusal = await _post(client, _command(12, "capacity-refusal"))
                assert capacity_refusal == (
                    503,
                    "application/json",
                    b'{"schema_version":"nexus-generation-rejection.v2",'
                    b'"kind":"capacity_unavailable"}',
                ), (
                    "non-admissible capacity must be the exact 503 rejection before runtime construction"
                )
                paths.memory_current.write_text(
                    f"{128 * 1024 * 1024}\n",
                    encoding="ascii",
                )

                for index in range(1, 6):
                    command = commands[index]
                    wire = _wire_command(command)
                    assert _MCP_ORIGIN.encode() not in wire
                    status, content_type, body = await _post(client, command)
                    assert (status, content_type.split(";", 1)[0]) == (
                        200,
                        "application/x-ndjson",
                    )
                    if command.tool_grant is not None:
                        assert _grant(index).encode() not in body
                    observed[index] = _frames(command, body)

                async def consume_cancelled_turn() -> tuple[int, str, bytes]:
                    return await _post(client, commands[6])

                cancelled_turn = asyncio.create_task(consume_cancelled_turn())
                assert await asyncio.to_thread(started.wait, 5), "runtime did not start"
                cancel_url = f"http://nexus-codex/v2/generations/{_request_id(6)}/cancel"
                first_cancel = await client.post(cancel_url)
                policy_after_cancel_url = (
                    f"http://nexus-codex/v2/generations/{_request_id(6)}/policy-violation"
                )
                policy_after_cancel = await client.post(policy_after_cancel_url)
                assert (first_cancel.status_code, policy_after_cancel.status_code) == (204, 204)
                assert await asyncio.to_thread(cancel_observed.wait, 5)
                assert await asyncio.to_thread(close_started.wait, 5)

                busy = await _post(client, commands[7])
                assert busy == (
                    503,
                    "application/json",
                    b'{"schema_version":"nexus-generation-rejection.v2",'
                    b'"kind":"capacity_unavailable"}',
                )
                assert not close_finished.is_set()

                close_release.set()
                cancelled_status, cancelled_type, cancelled_body = await cancelled_turn
                assert (cancelled_status, cancelled_type.split(";", 1)[0]) == (
                    200,
                    "application/x-ndjson",
                )
                observed[6] = _frames(commands[6], cancelled_body)
                cancel_then_policy_terminal = _terminal(observed[6])
                assert cancel_then_policy_terminal.status == "failed"
                assert cancel_then_policy_terminal.failure is not None
                assert cancel_then_policy_terminal.failure.kind == "policy_violation"
                assert close_finished.is_set()

                admitted = await _post(client, commands[7])
                assert admitted[0] == 200
                observed[7] = _frames(commands[7], admitted[2])

                policy_turn = asyncio.create_task(_post(client, commands[8]))
                assert await asyncio.to_thread(policy_started.wait, 5)
                nonmatching_url = (
                    f"http://nexus-codex/v2/generations/{_request_id(999)}/policy-violation"
                )
                assert (await client.post(nonmatching_url)).status_code == 204
                assert not policy_observed.is_set()

                matching_url = (
                    f"http://nexus-codex/v2/generations/{_request_id(8)}/policy-violation"
                )
                assert (await client.post(matching_url)).status_code == 204
                cancel_after_policy_url = (
                    f"http://nexus-codex/v2/generations/{_request_id(8)}/cancel"
                )
                assert (await client.post(cancel_after_policy_url)).status_code == 204
                assert await asyncio.to_thread(policy_observed.wait, 5)
                assert await asyncio.to_thread(policy_close_started.wait, 5)

                policy_busy = await _post(client, commands[9])
                assert policy_busy == (
                    503,
                    "application/json",
                    b'{"schema_version":"nexus-generation-rejection.v2",'
                    b'"kind":"capacity_unavailable"}',
                )
                assert not policy_close_finished.is_set()

                policy_close_release.set()
                policy_status, policy_type, policy_body = await policy_turn
                assert (policy_status, policy_type.split(";", 1)[0]) == (
                    200,
                    "application/x-ndjson",
                )
                observed[8] = _frames(commands[8], policy_body)
                policy_terminal = _terminal(observed[8])
                assert policy_terminal.status == "failed"
                assert policy_terminal.failure is not None
                assert policy_terminal.failure.kind == "policy_violation"
                assert policy_close_finished.is_set()

                post_policy = await _post(client, commands[9])
                assert post_policy[0] == 200
                observed[9] = _frames(commands[9], post_policy[2])

                policy_started.clear()
                policy_observed.clear()
                policy_close_started.clear()
                policy_close_release.clear()
                policy_close_finished.clear()
                disconnect_admission_response = await client.post(
                    "http://nexus-codex/v2/generation-admissions",
                    headers={"accept": "application/json", "content-type": "application/json"},
                    content=generation_admission_request(generation_command_draft(commands[10]))
                    .model_dump_json()
                    .encode("utf-8"),
                )
                disconnect_admission = GenerationAdmission.model_validate_json(
                    disconnect_admission_response.content
                )
                async with client.stream(
                    "POST",
                    "http://nexus-codex/v2/generations",
                    headers={
                        "accept": "application/x-ndjson",
                        "content-type": "application/json",
                        "nexus-generation-admission": str(disconnect_admission.admission_id),
                    },
                    content=_wire_command(commands[10]),
                ) as disconnected:
                    assert disconnected.status_code == 200
                    first_line = await anext(disconnected.aiter_lines())
                    first_frame = GenerationFrame.model_validate_json(first_line)
                    assert first_frame.sequence == 0
                    assert await asyncio.to_thread(policy_started.wait, 5)

                assert await asyncio.to_thread(policy_observed.wait, 5)
                assert await asyncio.to_thread(policy_close_started.wait, 5)
                probe_transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
                async with httpx.AsyncClient(
                    transport=probe_transport,
                    timeout=5,
                ) as probe_client:
                    disconnect_busy = await _post(probe_client, commands[11])
                assert disconnect_busy[0] == 503
                assert not policy_close_finished.is_set()

                policy_close_release.set()
                assert await asyncio.to_thread(policy_close_finished.wait, 5)
                post_disconnect = await _post(client, commands[11])
                assert post_disconnect[0] == 200
                observed[11] = _frames(commands[11], post_disconnect[2])

                started.clear()
                cancel_observed.clear()
                close_started.clear()
                close_release.clear()
                close_finished.clear()
                pure_cancel_turn = asyncio.create_task(_post(client, commands[13]))
                assert await asyncio.to_thread(started.wait, 5)
                pure_cancel_url = f"http://nexus-codex/v2/generations/{_request_id(13)}/cancel"
                assert (await client.post(pure_cancel_url)).status_code == 204
                assert await asyncio.to_thread(cancel_observed.wait, 5)
                assert await asyncio.to_thread(close_started.wait, 5)
                close_release.set()
                pure_status, pure_type, pure_body = await pure_cancel_turn
                assert (pure_status, pure_type.split(";", 1)[0]) == (
                    200,
                    "application/x-ndjson",
                )
                observed[13] = _frames(commands[13], pure_body)
                assert _terminal(observed[13]).status == "cancelled"

        asyncio.run(exercise())
    finally:
        close_release.set()
        policy_close_release.set()
        stop.set()
        process.join(5)
        if process.is_alive():
            process.terminate()
            process.join(5)
        ready.close()
    try:
        assert process.exitcode == 0
        report_collector.join(5)
        assert not report_collector.is_alive(), "UDS host report pipe remained open"
    finally:
        report.close()

    factory_indices = [entry["index"] for entry in reports if entry["kind"] == "factory"]
    assert factory_indices == list(range(1, 13)), "busy refusal constructed a runtime"
    lowering = {
        cast(int, entry["index"]): cast(Mapping[str, object], entry)
        for entry in reports
        if entry["kind"] == "lowering"
    }
    cleanup = {
        cast(int, entry["index"]): cast(bool, entry["cleared"])
        for entry in reports
        if entry["kind"] == "resolver_cleanup"
    }
    assert cleanup == {2: True, 4: True, 5: True}

    lowered_cwds = {
        index: Path(cast(str, cast(Mapping[str, object], entry["request"])["cwd"]))
        for index, entry in lowering.items()
    }
    assert len(set(lowered_cwds.values())) == len(lowered_cwds)
    assert all(
        path.name == "workspace" and path.parent.parent == cwd for path in lowered_cwds.values()
    )
    assert all(not path.exists() for path in lowered_cwds.values())
    assert not any(cwd.iterdir()), "per-turn tmpfs residue survived runtime close"
    assert all(entry["cwd_empty_on_open"] is True for entry in lowering.values())
    assert all(entry["cwd_residue_present_at_close"] is True for entry in lowering.values())
    assert all(entry["state_residue_present_at_close"] is True for entry in lowering.values())
    assert lowering[1]["runtime_auth_at_open"] == _ENROLLED_AUTH
    assert lowering[1]["durable_auth_after_open"] == _REFRESHED_AUTH
    assert all(
        entry["runtime_auth_at_open"] == _REFRESHED_AUTH
        for index, entry in lowering.items()
        if index != 1
    ), "the pinned refresh write was not visible to the next turn"
    assert all(entry["runtime_auth_after_close"] == _REFRESHED_AUTH for entry in lowering.values())
    assert all(
        entry["runtime_auth_link_target"] == str(credential_file) for entry in lowering.values()
    )
    lowered_state_roots = {
        index: Path(cast(str, entry["state_root_base"])) for index, entry in lowering.items()
    }
    assert all(
        path == lowered_cwds[index].parent / "state" for index, path in lowered_state_roots.items()
    )
    assert all(not path.exists() for path in lowered_state_roots.values())
    assert all(not path.parent.exists() for path in lowered_cwds.values())
    assert credential_file.read_bytes() == _REFRESHED_AUTH

    synthesis = cast(Mapping[str, object], lowering[1]["request"])
    assert synthesis == {
        "backend": "codex",
        "transport": "sdk",
        "auth": ("local_account", "codex-personal", None),
        "open": "new",
        "model": "gpt-5.6-luna",
        "reasoning": "low",
        "agent_definition_revision": "2" * 64,
        "row_fingerprint": "1" * 64,
        "system": ("instructions-1",),
        "developer": (),
        "cwd": str(lowered_cwds[1]),
        "additional_dirs": (),
        "policy": {
            "filesystem": "read_only",
            "network": "disabled",
            "network_allowlist": (),
            "approval": "deny",
            "allowed_tools": ("*",),
            "denied_tools": (),
            "environment": (),
            "unsafe": None,
        },
        "mcp_servers": (),
        "output": {"kind": "json_schema", "name": "answer", "schema": _STRUCTURED_SCHEMA},
        "native_web_search": False,
        "native_builtin_tools": "disabled",
        "turn_input": ("synthesis",),
        "turn_policy": None,
        "turn_timeout_seconds": 120.0,
        "approvals_supplied": False,
        "cancel_supplied": True,
    }
    assert lowering[1]["state_root_base"] == str(lowered_state_roots[1])
    assert lowering[1]["resolver_present"] is False

    chat = cast(Mapping[str, object], lowering[2]["request"])
    mcp_servers = cast(tuple[Mapping[str, object], ...], chat["mcp_servers"])
    assert chat == {
        "backend": "codex",
        "transport": "sdk",
        "auth": ("local_account", "codex-personal", None),
        "open": "new",
        "model": "gpt-5.6-terra",
        "reasoning": "medium",
        "agent_definition_revision": "2" * 64,
        "row_fingerprint": "1" * 64,
        "system": ("instructions-2",),
        "developer": (),
        "cwd": str(lowered_cwds[2]),
        "additional_dirs": (),
        "policy": {
            "filesystem": "workspace_write",
            "network": "unrestricted",
            "network_allowlist": (),
            "approval": "deny",
            "allowed_tools": ("*",),
            "denied_tools": (),
            "environment": (),
            "unsafe": ("network_unrestricted",),
        },
        "mcp_servers": mcp_servers,
        "output": {"kind": "text"},
        "native_web_search": False,
        "native_builtin_tools": "disabled",
        "turn_input": ("chat-allowed",),
        "turn_policy": None,
        "turn_timeout_seconds": 900.0,
        "approvals_supplied": False,
        "cancel_supplied": True,
    }
    assert mcp_servers == (
        {
            "name": _MCP_SERVER_NAME,
            "transport": "streamable_http",
            "command": None,
            "args": (),
            "url": _MCP_ORIGIN,
            "environment_refs": (),
            "headers": (
                (
                    "Authorization",
                    "secret_reference",
                    "codex-personal",
                    cast(tuple[tuple[str, str, str, str], ...], mcp_servers[0]["headers"])[0][3],
                ),
            ),
            "required": True,
            "allowed_tools": _TOOL_WIRE_ALLOWLIST,
            "denied_tools": (),
        },
    )
    assert lowering[2]["resolver_present"] is True
    assert lowering[2]["resolver_matches"] is True
    assert lowering[2]["secret_absent_from_repr"] is True
    assert lowering[2]["state_root_base"] == str(lowered_state_roots[2])

    def reference_name(index: int) -> str:
        request = cast(Mapping[str, object], lowering[index]["request"])
        servers = cast(tuple[Mapping[str, object], ...], request["mcp_servers"])
        headers = cast(tuple[tuple[str, str, str, str], ...], servers[0]["headers"])
        return headers[0][3]

    reference_names = {reference_name(index) for index in (2, 4, 5)}
    assert len(reference_names) == 3

    assert [frame.event.kind for frame in observed[2]] == [
        "text",
        "tool_use",
        "tool_use",
        "terminal",
    ]
    allowed_events = [
        frame.event for frame in observed[2] if isinstance(frame.event, GenerationToolUse)
    ]
    assert [event.name for event in allowed_events] == [_TOOL_ALLOWLIST[0]] * 2
    assert _terminal(observed[2]).status == "succeeded"
    assert [frame.event.kind for frame in observed[3]] == ["tool_use", "terminal"]
    assert [frame.event.kind for frame in observed[4]] == [
        "permission_request",
        "terminal",
    ]
    assert [frame.event.kind for frame in observed[5]] == ["tool_use", "terminal"]
    for index in (3, 4, 5):
        terminal = _terminal(observed[index])
        assert terminal.status == "failed"
        assert terminal.failure is not None
        assert terminal.failure.kind == "policy_violation"
