"""Real-UDS RED proof for v2 generation lowering and lifecycle ownership."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import socket
from collections.abc import AsyncIterator, Iterator, Mapping
from pathlib import Path
from tempfile import gettempdir
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from apps.codex_agent.capacity import CapacityPaths
from apps.codex_agent.host import RuntimeVersions, create_codex_agent_app
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

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationTerminal,
    GenerationToolUse,
)
from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

_VERSIONS = RuntimeVersions(sdk="0.144.4", runtime="0.144.4")
_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"
_MCP_SERVER_NAME = "nexus"
_TOOL_ALLOWLIST = tuple(str(entry.spec.id) for entry in CHAT_TOOL_DECLARATIONS)
_LINUX_SUN_PATH_BYTES = 108
_STRUCTURED_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-generation-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode()) < _LINUX_SUN_PATH_BYTES
    return socket_path


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
    maximum.write_text(f"{384 * 1024 * 1024}\n", encoding="ascii")
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
    if chat:
        operation: dict[str, object] = {
            "kind": "chat",
            "profile": "balanced",
            "revision": generation_policy.operation_revision("chat", profile="balanced"),
        }
    else:
        operation = {
            "kind": "metadata_enrichment",
            "revision": generation_policy.operation_revision("metadata_enrichment"),
        }
    output: dict[str, object]
    if structured:
        output = {
            "kind": "JsonSchema",
            "name": "answer",
            "schema": _STRUCTURED_SCHEMA,
            "strict": True,
        }
    else:
        output = {"kind": "Text"}
    payload: dict[str, object] = {
        "schema_version": "nexus-generation-command.v2",
        "request_id": str(_request_id(index)),
        "operation": operation,
        "policy_revision": generation_policy.POLICY_REVISION,
        "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
        "intent": {
            "instructions": f"instructions-{index}",
            "input": input_text,
            "output": output,
        },
    }
    if chat:
        payload["tool_grant"] = {"kind": "Bearer", "token": _grant(index)}
    return GenerationCommand.model_validate(payload)


def _wire_command(command: GenerationCommand) -> bytes:
    """Encode the sensitive UDS grant that the model deliberately excludes from dumps."""

    payload = command.model_dump(mode="json", exclude_none=True)
    if command.tool_grant is not None:
        payload["tool_grant"] = {
            "kind": "Bearer",
            "token": command.tool_grant.token.get_secret_value(),
        }
    return json.dumps(payload, separators=(",", ":")).encode()


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
    allowed_name = f"{_MCP_SERVER_NAME}/{_TOOL_ALLOWLIST[0]}"
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

    async def open_session(self, request: AgentSessionRequest) -> AgentSession:
        session = await super().open_session(request)
        self._opened = request
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
                "resolver_present": self._config.secret_resolver is not None,
                "resolver_matches": self._resolver_matches,
                "secret_absent_from_repr": _grant(self._index) not in f"{self._config!r}{opened!r}",
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
        "model": opened.model,
        "reasoning": opened.reasoning.effort if opened.reasoning else None,
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
    state_root: str,
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
    chat_network_attested: bool,
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
        return _InspectingRuntime(runtime_index, config, report)

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        state_root_base=Path(state_root),
        mcp_origin=_MCP_ORIGIN,
        chat_network_attested=chat_network_attested,
        versions=_VERSIONS,
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
    state_root: Path,
    capacity_root: Path,
    events: tuple[Any, ...],
    *,
    chat_network_attested: bool,
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
            str(state_root),
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
            chat_network_attested,
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
    response = await client.post(
        "http://nexus-codex/v2/generations",
        headers={
            "accept": "application/x-ndjson",
            "content-type": "application/json",
        },
        content=_wire_command(command),
    )
    return (
        response.status_code,
        response.headers.get("content-type", ""),
        response.content,
    )


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
        yield cast(Mapping[str, object], connection.recv())


def test_real_uds_v2_host_lowers_tools_confines_grants_and_owns_abort_slot(
    tmp_path: Path,
) -> None:
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
        with pytest.raises(ValueError, match="canonical public HTTPS"):
            create_codex_agent_app(
                runtime_factory=unreachable_runtime_factory,
                working_directory=tmp_path,
                state_root_base=tmp_path,
                versions=_VERSIONS,
                mcp_origin=invalid_origin,
                chat_network_attested=True,
            )

    unattested_root = tmp_path / "unattested"
    unattested_cwd = unattested_root / "empty-cwd"
    unattested_state = unattested_root / "state"
    unattested_root.mkdir()
    unattested_cwd.mkdir()
    unattested_state.mkdir()
    unattested_paths = _capacity_paths(unattested_root)
    unattested_events = tuple(context.Event() for _ in range(11))
    unattested_socket = _short_socket_path()
    unattested_process, unattested_report, unattested_ready = _start_host(
        unattested_socket,
        unattested_cwd,
        unattested_state,
        unattested_paths.meminfo.parent,
        unattested_events,
        chat_network_attested=False,
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
        assert not tuple(_messages(unattested_report)), "unattested ChatTools constructed a runtime"
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
    state_root = tmp_path / "state"
    cwd.mkdir()
    state_root.mkdir()
    paths = _capacity_paths(tmp_path)
    process, report, ready = _start_host(
        socket_path,
        cwd,
        state_root,
        paths.meminfo.parent,
        events,
        chat_network_attested=True,
    )

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
        10: _command(10, "hold-for-disconnect"),
        11: _command(11, "after-disconnect"),
    }
    observed: dict[int, tuple[GenerationFrame, ...]] = {}
    try:

        async def exercise() -> None:
            transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
            async with httpx.AsyncClient(transport=transport, timeout=5) as client:
                health_response = await client.get("http://nexus-codex/health")
                health = GenerationHealth.model_validate_json(health_response.content)
                assert health == GenerationHealth(
                    policy_revision=generation_policy.POLICY_REVISION,
                    sdk_version=_VERSIONS.sdk,
                    runtime_version=_VERSIONS.runtime,
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
                second_cancel = await client.post(cancel_url)
                assert (first_cancel.status_code, second_cancel.status_code) == (204, 204)
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
                assert _terminal(observed[6]).status == "cancelled"
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
                assert (await client.post(matching_url)).status_code == 204
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
                async with client.stream(
                    "POST",
                    "http://nexus-codex/v2/generations",
                    headers={
                        "accept": "application/x-ndjson",
                        "content-type": "application/json",
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
                disconnect_busy = await _post(client, commands[11])
                assert disconnect_busy[0] == 503
                assert not policy_close_finished.is_set()

                policy_close_release.set()
                assert await asyncio.to_thread(policy_close_finished.wait, 5)
                post_disconnect = await _post(client, commands[11])
                assert post_disconnect[0] == 200
                observed[11] = _frames(commands[11], post_disconnect[2])

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
        reports = tuple(_messages(report))
    finally:
        report.close()

    factory_indices = [entry["index"] for entry in reports if entry["kind"] == "factory"]
    assert factory_indices == list(range(1, 12)), "busy refusal constructed a runtime"
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

    synthesis = cast(Mapping[str, object], lowering[1]["request"])
    assert synthesis == {
        "backend": "codex",
        "transport": "sdk",
        "auth": ("local_account", "codex-personal", None),
        "open": "new",
        "model": "gpt-5.6-luna",
        "reasoning": "low",
        "system": ("instructions-1",),
        "developer": (),
        "cwd": str(cwd),
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
    assert lowering[1]["state_root_base"] == str(state_root)
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
        "system": ("instructions-2",),
        "developer": (),
        "cwd": str(cwd),
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
            "allowed_tools": _TOOL_ALLOWLIST,
            "denied_tools": (),
        },
    )
    assert lowering[2]["resolver_present"] is True
    assert lowering[2]["resolver_matches"] is True
    assert lowering[2]["secret_absent_from_repr"] is True
    assert lowering[2]["state_root_base"] == str(state_root)

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
    assert [event.name for event in allowed_events] == [
        f"{_MCP_SERVER_NAME}/{_TOOL_ALLOWLIST[0]}"
    ] * 2
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
