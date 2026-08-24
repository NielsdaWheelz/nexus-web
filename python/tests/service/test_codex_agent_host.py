"""Real UDS proof for the private Codex agent host and worker client."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import socket
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator, Mapping
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from apps.codex_agent import capacity_canary
from apps.codex_agent import health as codex_agent_health
from apps.codex_agent import host as codex_agent_host
from apps.codex_agent import main as codex_agent_main
from apps.codex_agent.auth_environment import reject_api_key_auth
from apps.codex_agent.capacity import CapacityPaths
from apps.codex_agent.host import RuntimeVersions, create_codex_agent_app
from apps.codex_agent.main import (
    _remove_proven_stale_socket,
    _validate_directories,
)
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from provider_runtime import Absent, Present, TokenUsage
from provider_runtime.agent_runtime import (
    AgentEvent,
    AgentNative,
    AgentSession,
    AgentSessionRef,
    AgentTerminal,
    AgentText,
    AgentToolUse,
    ApprovalHandler,
    ScriptedAgentRuntime,
    TurnNotStarted,
    TurnRequest,
    freeze_json_object,
    thaw_json_value,
)

from nexus.services.metadata_enrichment import metadata_enrichment_agent_definition
from nexus.services.native_agent_client import (
    CodexAgentClient,
    NativeAgentCapacityUnavailable,
    NativeAgentProtocolDefect,
    NativeAgentRequestRejected,
    NativeAgentTransportAmbiguous,
    NativeAgentUnavailable,
)
from nexus.services.native_agent_contract import NativeAgentHealth
from nexus.services.native_agent_operations import build_metadata_enrichment_command

REQUEST_ID = UUID("755a2de9-2bdc-5c57-a6a0-17a2407f14bb")
_REAL_ASYNCIO_TIMEOUT = asyncio.timeout
_VERSIONS = RuntimeVersions(sdk="0.144.4", runtime="0.144.4")
_LINUX_SUN_PATH_BYTES = 108


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-agent-host-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode("utf-8")) < _LINUX_SUN_PATH_BYTES
    return socket_path


@pytest.fixture
def short_run_directory() -> Iterator[Path]:
    """Provide a mode-correct control directory within AF_UNIX's path bound."""
    with TemporaryDirectory(prefix="nexus-agent-run-", dir=Path("/tmp").resolve()) as directory:
        path = Path(directory)
        path.chmod(0o770)
        yield path


def _capacity_paths(
    root: Path,
    *,
    mem_available_kib: int = 700_000,
    memory_current: int = 128 * 1024 * 1024,
    memory_max: str = str(384 * 1024 * 1024),
    some_avg10: str = "0.00",
    full_avg10: str = "0.00",
) -> CapacityPaths:
    capacity_root = root / "capacity"
    capacity_root.mkdir(exist_ok=True)
    meminfo = capacity_root / "meminfo"
    pressure = capacity_root / "memory.pressure"
    current = capacity_root / "memory.current"
    maximum = capacity_root / "memory.max"
    meminfo.write_text(
        f"MemTotal:       2000000 kB\nMemAvailable:    {mem_available_kib} kB\n",
        encoding="ascii",
    )
    pressure.write_text(
        f"some avg10={some_avg10} avg60=0.00 avg300=0.00 total=0\n"
        f"full avg10={full_avg10} avg60=0.00 avg300=0.00 total=0\n",
        encoding="ascii",
    )
    current.write_text(f"{memory_current}\n", encoding="ascii")
    maximum.write_text(f"{memory_max}\n", encoding="ascii")
    return CapacityPaths(
        meminfo=meminfo,
        memory_pressure=pressure,
        memory_current=current,
        memory_max=maximum,
    )


def _session_ref() -> AgentSessionRef:
    return AgentSessionRef(
        schema_version="agent-session-ref.v1",
        backend="codex",
        transport="sdk",
        native_session_id="thread-metadata-1",
        profile_key="codex-personal",
        state_root_fingerprint="1" * 64,
        cwd_fingerprint="2" * 64,
    )


def _terminal() -> AgentTerminal:
    return AgentTerminal(
        status="succeeded",
        failure=None,
        final_text='{"title":"Dune"}',
        structured_output=freeze_json_object(
            {
                "title": "Dune",
                "authors": ["Frank Herbert"],
                "publisher": None,
                "description": None,
                "published_date": "1965",
                "language": "en",
            }
        ),
        session_ref=_session_ref(),
        usage=Present(
            TokenUsage(
                input_tokens=80,
                output_tokens=20,
                total_tokens=100,
                reasoning_tokens=Present(5),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
    )


class _InspectingRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        report: multiprocessing.connection.Connection,
        server_holder: dict[str, uvicorn.Server],
    ) -> None:
        super().__init__(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=((AgentText("Dune"), _terminal()),),
        )
        self._report = report
        self._server_holder = server_holder

    async def close(self) -> None:
        await super().close()
        opened = self.calls[0].subject
        streamed = self.calls[1].subject
        assert not isinstance(opened, tuple)
        assert isinstance(streamed, tuple)
        turn = streamed[1]
        self._report.send(
            {
                "backend": opened.backend,
                "transport": opened.transport,
                "auth_kind": opened.auth.kind,
                "auth_profile": opened.auth.profile_key,
                "open": opened.open.kind,
                "model": opened.model,
                "reasoning": opened.reasoning.effort if opened.reasoning else None,
                "system": tuple(part.text for part in opened.system),
                "cwd": opened.cwd,
                "additional_dirs": opened.additional_dirs,
                "mcp_servers": opened.mcp_servers,
                "output_kind": opened.output.kind,
                "output_schema_json": _canonical_json(thaw_json_value(opened.output.schema)),
                "policy": {
                    "filesystem": opened.policy.filesystem,
                    "network": opened.policy.network,
                    "approval": opened.policy.approval,
                    "allowed_tools": opened.policy.allowed_tools,
                    "environment": opened.policy.environment,
                },
                "native_web_search": opened.native.web_search if opened.native else None,
                "native_builtin_tools": opened.native.builtin_tools if opened.native else None,
                "turn_input": tuple(part.text for part in turn.input),
                "turn_timeout_seconds": turn.timeout_seconds,
                "approvals_supplied": self.calls[1].approvals_supplied,
            }
        )
        self._server_holder["server"].should_exit = True


class _CloseFailingRuntime(ScriptedAgentRuntime):
    def __init__(self, server_holder: dict[str, uvicorn.Server]) -> None:
        super().__init__(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=((AgentText("must not become success"), _terminal()),),
        )
        self._server_holder = server_holder

    async def close(self) -> None:
        await super().close()
        self._server_holder["server"].should_exit = True
        raise RuntimeError("simulated cleanup failure")


class _TurnNotStartedRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        error: TurnNotStarted,
        server_holder: dict[str, uvicorn.Server],
    ) -> None:
        super().__init__(sessions=(AgentSession(_session_ref()),))
        self._error = error
        self._server_holder = server_holder

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: object | None = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals, cancel
        raise self._error
        yield  # pragma: no cover - preserves the async-iterator boundary

    async def close(self) -> None:
        await super().close()
        self._server_holder["server"].should_exit = True


class _BlockingRuntime(ScriptedAgentRuntime):
    def __init__(
        self,
        started: Any,
        release: Any,
    ) -> None:
        super().__init__(sessions=(AgentSession(_session_ref()),))
        self._started = started
        self._release = release

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: object | None = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals, cancel
        self._started.set()
        released = await asyncio.to_thread(self._release.wait, 5)
        if not released:
            raise RuntimeError("capacity concurrency proof did not release the admitted turn")
        yield _terminal()


class _DisconnectObservedRuntime(ScriptedAgentRuntime):
    """Block inside the native turn and report interruption and close timing."""

    def __init__(
        self,
        started: Any,
        interrupted: Any,
        close_started: Any,
        close_release: Any,
        close_finished: Any,
    ) -> None:
        super().__init__(sessions=(AgentSession(_session_ref()),))
        self._started = started
        self._interrupted = interrupted
        self._close_started = close_started
        self._close_release = close_release
        self._close_finished = close_finished

    async def stream_turn(
        self,
        session: AgentSession,
        request: TurnRequest,
        *,
        approvals: ApprovalHandler | None = None,
        cancel: object | None = None,
    ) -> AsyncIterator[AgentEvent]:
        del session, request, approvals, cancel
        self._started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self._interrupted.set()
            raise
        yield _terminal()  # pragma: no cover - the turn only ends by interruption

    async def close(self) -> None:
        self._close_started.set()
        # A real runtime close drains and reaps the native process tree; the slot must
        # stay held for the whole of it, so the proof holds the close open until it has
        # observed the host refusing a second turn.
        released = await asyncio.to_thread(self._close_release.wait, 10)
        await super().close()
        if released:
            self._close_finished.set()


def _run_disconnect_host(
    socket_path: str,
    cwd: str,
    capacity_root: str,
    runtime_marker: str,
    started: Any,
    interrupted: Any,
    close_started: Any,
    close_release: Any,
    close_finished: Any,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    paths = CapacityPaths(
        meminfo=Path(capacity_root) / "meminfo",
        memory_pressure=Path(capacity_root) / "memory.pressure",
        memory_current=Path(capacity_root) / "memory.current",
        memory_max=Path(capacity_root) / "memory.max",
    )

    def runtime_factory() -> ScriptedAgentRuntime:
        marker = Path(runtime_marker)
        count = int(marker.read_text(encoding="ascii")) + 1 if marker.exists() else 1
        marker.write_text(str(count), encoding="ascii")
        if count == 1:
            return _DisconnectObservedRuntime(
                started, interrupted, close_started, close_release, close_finished
            )
        return ScriptedAgentRuntime(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=((_terminal(),),),
        )

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=paths,
    )
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
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _maximal_terminal() -> AgentTerminal:
    """A succeeded terminal at every declared maximum of the metadata output schema."""

    output = {
        "title": "T" * 255,
        "authors": [f"Author {index:02d} " + "N" * 190 for index in range(20)],
        "publisher": "P" * 255,
        "description": "D" * 2000,
        "published_date": "1965-08-01",
        "language": "en",
    }
    return AgentTerminal(
        status="succeeded",
        failure=None,
        final_text=json.dumps(output),
        structured_output=freeze_json_object(output),
        session_ref=_session_ref(),
        usage=Present(
            TokenUsage(
                input_tokens=800,
                output_tokens=2_400,
                total_tokens=3_200,
                reasoning_tokens=Present(300),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
    )


def _flood_events(mode: str) -> tuple[AgentEvent, ...]:
    """Native event streams at the granularity the pinned Codex adapter really emits."""

    terminal = _maximal_terminal()
    if mode == "per-delta":
        # One reasoning delta and one agent-message delta per token, well past the
        # 1024-frame bound when relayed one-to-one.
        reasoning = tuple(
            AgentNative(native_type="item/reasoning/textDelta", payload=freeze_json_object({}))
            for _ in range(1_500)
        )
        text = tuple(AgentText(piece) for piece in _token_deltas(terminal.final_text))
        return (
            AgentNative(native_type="thread/started", payload=freeze_json_object({})),
            AgentNative(native_type="item/started", payload=freeze_json_object({})),
            *reasoning,
            AgentNative(native_type="item/completed", payload=freeze_json_object({})),
            AgentNative(native_type="item/started", payload=freeze_json_object({})),
            *text,
            AgentNative(native_type="item/completed", payload=freeze_json_object({})),
            terminal,
        )
    if mode == "alternating-natives":
        # A stream no coalescing can bound: the host must end it with the typed
        # bound terminal rather than author a stream the worker refuses.
        return (
            *(
                AgentNative(native_type=f"native/{index % 2}", payload=freeze_json_object({}))
                for index in range(4_000)
            ),
            terminal,
        )
    raise AssertionError(f"unknown flood mode {mode!r}")


def _token_deltas(text: str) -> list[str]:
    return [text[index : index + 3] for index in range(0, len(text), 3)]


def _run_flood_host(
    socket_path: str,
    cwd: str,
    mode: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    def runtime_factory() -> ScriptedAgentRuntime:
        return ScriptedAgentRuntime(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=(_flood_events(mode),),
        )

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
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
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_scripted_host(
    socket_path: str,
    cwd: str,
    report: multiprocessing.connection.Connection,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    holder: dict[str, uvicorn.Server] = {}

    def runtime_factory() -> ScriptedAgentRuntime:
        return _InspectingRuntime(report, holder)

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    holder["server"] = server
    try:
        listener.bind(socket_path)
        os.chmod(socket_path, 0o660)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_post_terminal_host(
    socket_path: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    app = FastAPI()
    holder: dict[str, uvicorn.Server] = {}

    @app.post("/v1/turns")
    async def turn() -> StreamingResponse:
        async def frames():
            terminal = {
                "schema_version": "nexus-agent-event.v1",
                "request_id": str(REQUEST_ID),
                "sequence": 0,
                "event": {
                    "kind": "terminal",
                    "status": "succeeded",
                    "failure": None,
                    "final_text": "{}",
                    "structured_output": {},
                    "session_ref": {
                        "schema_version": "agent-session-ref.v1",
                        "backend": "codex",
                        "transport": "sdk",
                        "native_session_id": "thread-metadata-1",
                        "profile_key": "codex-personal",
                        "state_root_fingerprint": "1" * 64,
                        "cwd_fingerprint": "2" * 64,
                    },
                    "usage": None,
                    "diagnostics": [],
                    "sdk_version": "0.144.4",
                    "runtime_version": "0.144.4",
                },
            }
            late = {
                "schema_version": "nexus-agent-event.v1",
                "request_id": str(REQUEST_ID),
                "sequence": 1,
                "event": {"kind": "text", "text": "late"},
            }
            yield json.dumps(terminal).encode() + b"\n"
            yield json.dumps(late).encode() + b"\n"
            holder["server"].should_exit = True

        return StreamingResponse(frames(), media_type="application/x-ndjson")

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    holder["server"] = server
    try:
        listener.bind(socket_path)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_stalling_http_host(
    socket_path: str,
    send_response_headers: bool,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(socket_path)
        listener.listen(1)
        ready.send("ready")
        connection, _address = listener.accept()
        with connection:
            request = bytearray()
            while b"\r\n\r\n" not in request:
                chunk = connection.recv(4_096)
                if not chunk:
                    return
                request.extend(chunk)
            if send_response_headers:
                connection.sendall(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/x-ndjson\r\n"
                    b"Transfer-Encoding: chunked\r\n"
                    b"Connection: close\r\n\r\n"
                )
            try:
                while connection.recv(4_096):
                    pass
            except ConnectionResetError:
                pass
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_policy_violation_host(
    socket_path: str,
    cwd: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    holder: dict[str, uvicorn.Server] = {}

    class PolicyViolationRuntime(ScriptedAgentRuntime):
        async def close(self) -> None:
            await super().close()
            holder["server"].should_exit = True

    def runtime_factory() -> ScriptedAgentRuntime:
        return PolicyViolationRuntime(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=(
                (
                    AgentToolUse(
                        "tool-1",
                        "commandExecution",
                        "started",
                        payload=freeze_json_object({"command": "must not cross the boundary"}),
                    ),
                    _terminal(),
                ),
            ),
        )

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    holder["server"] = server
    try:
        listener.bind(socket_path)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_close_failing_host(
    socket_path: str,
    cwd: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    holder: dict[str, uvicorn.Server] = {}

    def runtime_factory() -> ScriptedAgentRuntime:
        return _CloseFailingRuntime(holder)

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    holder["server"] = server
    try:
        listener.bind(socket_path)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_turn_not_started_host(
    socket_path: str,
    cwd: str,
    reason: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    holder: dict[str, uvicorn.Server] = {}
    if reason == "turn_timeout":
        error = TurnNotStarted("turn_timeout")
    elif reason == "cancelled":
        error = TurnNotStarted("cancelled")
    else:
        error = TurnNotStarted("cancelled")
        cast(Any, error).reason = reason

    def runtime_factory() -> ScriptedAgentRuntime:
        return _TurnNotStartedRuntime(error, holder)

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="off",
            timeout_graceful_shutdown=2,
        )
    )
    holder["server"] = server
    try:
        listener.bind(socket_path)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_capacity_host(
    socket_path: str,
    cwd: str,
    capacity_root: str,
    runtime_marker: str,
    started: Any | None,
    release: Any | None,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    paths = CapacityPaths(
        meminfo=Path(capacity_root) / "meminfo",
        memory_pressure=Path(capacity_root) / "memory.pressure",
        memory_current=Path(capacity_root) / "memory.current",
        memory_max=Path(capacity_root) / "memory.max",
    )

    def runtime_factory() -> ScriptedAgentRuntime:
        marker = Path(runtime_marker)
        count = int(marker.read_text(encoding="ascii")) + 1 if marker.exists() else 1
        marker.write_text(str(count), encoding="ascii")
        if started is not None and release is not None:
            return _BlockingRuntime(started, release)
        return ScriptedAgentRuntime(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=((_terminal(),),),
        )

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=paths,
    )
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
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _run_fixed_http_rejection_host(
    socket_path: str,
    status: int,
    content_type: str,
    body: bytes,
    ready: multiprocessing.connection.Connection,
) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(socket_path)
        listener.listen(1)
        ready.send("ready")
        connection, _address = listener.accept()
        with connection:
            request = bytearray()
            while b"\r\n\r\n" not in request:
                chunk = connection.recv(4_096)
                if not chunk:
                    return
                request.extend(chunk)
            connection.sendall(
                f"HTTP/1.1 {status} Rejected\r\n".encode("ascii")
                + f"Content-Type: {content_type}\r\n".encode("ascii")
                + f"Content-Length: {len(body)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + body
            )
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _start_owned_process(
    target: Any,
    args: tuple[object, ...],
) -> tuple[multiprocessing.Process, multiprocessing.connection.Connection]:
    parent, child = multiprocessing.Pipe(duplex=False)
    process = multiprocessing.get_context("fork").Process(target=target, args=(*args, child))
    process.start()
    child.close()
    assert parent.poll(5), f"UDS child {process.pid} did not report readiness"
    assert parent.recv() == "ready"
    return process, parent


def test_real_uds_host_binds_the_exact_metadata_policy_and_closes_after_terminal(
    tmp_path: Path,
) -> None:
    socket_path = _short_socket_path()
    report_parent, report_child = multiprocessing.Pipe(duplex=False)
    process, ready = _start_owned_process(
        _run_scripted_host,
        (str(socket_path), str(tmp_path), report_child),
    )
    report_child.close()
    try:
        command = build_metadata_enrichment_command(
            request_id=REQUEST_ID,
            input="Known metadata and bounded sample for Dune.",
        )
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "succeeded"
        assert terminal.structured_output["title"] == "Dune"
        assert terminal.session_ref is not None
        assert terminal.session_ref.profile_key == "codex-personal"
        assert terminal.usage is not None and terminal.usage.total_tokens == 100
        assert terminal.sdk_version == "0.144.4"
        assert terminal.runtime_version == "0.144.4"

        assert report_parent.poll(5), "host did not close its one-turn runtime"
        captured: Mapping[str, object] = report_parent.recv()
        system_prompt, output_schema = metadata_enrichment_agent_definition()
        assert captured == {
            "backend": "codex",
            "transport": "sdk",
            "auth_kind": "local_account",
            "auth_profile": "codex-personal",
            "open": "new",
            "model": "gpt-5.6-luna",
            "reasoning": "low",
            "system": (system_prompt,),
            "cwd": str(tmp_path),
            "additional_dirs": (),
            "mcp_servers": (),
            "output_kind": "json_schema",
            "output_schema_json": _canonical_json(output_schema),
            "policy": {
                "filesystem": "read_only",
                "network": "disabled",
                "approval": "deny",
                "allowed_tools": ("*",),
                "environment": (),
            },
            "native_web_search": False,
            "native_builtin_tools": "disabled",
            "turn_input": ("Known metadata and bounded sample for Dune.",),
            "turn_timeout_seconds": 120.0,
            "approvals_supplied": False,
        }
        process.join(5)
        assert process.exitcode == 0, f"host process did not exit cleanly: {process.exitcode}"
        assert not socket_path.exists(), "host process left its UDS path behind"
    finally:
        ready.close()
        report_parent.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


@pytest.mark.parametrize(
    ("mem_available_kib", "memory_current", "memory_max", "some_avg10", "full_avg10"),
    (
        pytest.param(
            524_287,
            128 * 1024 * 1024,
            str(384 * 1024 * 1024),
            "0.00",
            "0.00",
            id="insufficient-host-memory",
        ),
        pytest.param(
            700_000, 128 * 1024 * 1024, "max", "0.00", "0.00", id="unbounded-cgroup-memory"
        ),
        pytest.param(
            700_000, 128 * 1024 * 1024, "384MiB", "0.00", "0.00", id="malformed-cgroup-memory"
        ),
        pytest.param(
            700_000,
            128 * 1024 * 1024,
            str(384 * 1024 * 1024),
            "5.01",
            "0.00",
            id="some-memory-pressure",
        ),
        pytest.param(
            700_000,
            128 * 1024 * 1024,
            str(384 * 1024 * 1024),
            "0.00",
            "0.01",
            id="full-memory-pressure",
        ),
        pytest.param(
            700_000,
            384 * 1024 * 1024 + 1,
            str(384 * 1024 * 1024),
            "0.00",
            "0.00",
            id="negative-remaining-growth",
        ),
    ),
)
def test_host_refuses_non_admissible_capacity_before_runtime_construction(
    tmp_path: Path,
    mem_available_kib: int,
    memory_current: int,
    memory_max: str,
    some_avg10: str,
    full_avg10: str,
) -> None:
    socket_path = _short_socket_path()
    paths = _capacity_paths(
        tmp_path,
        mem_available_kib=mem_available_kib,
        memory_current=memory_current,
        memory_max=memory_max,
        some_avg10=some_avg10,
        full_avg10=full_avg10,
    )
    runtime_marker = tmp_path / "runtime-constructions"
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            None,
            None,
        ),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")

        async def observe_raw_rejection() -> tuple[int, str, bytes]:
            transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
            async with httpx.AsyncClient(transport=transport, timeout=2) as client:
                response = await client.post(
                    "http://nexus-codex/v1/turns",
                    headers={
                        "accept": "application/x-ndjson",
                        "content-type": "application/json",
                    },
                    content=command.model_dump_json(),
                )
            return response.status_code, response.headers["content-type"], response.content

        assert asyncio.run(observe_raw_rejection()) == (
            503,
            "application/json",
            b'{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}',
        ), "non-admissible capacity must be the exact 503 rejection before runtime construction"
        with pytest.raises(NativeAgentCapacityUnavailable):
            asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert not runtime_marker.exists(), "capacity refusal constructed AgentRuntime"
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_host_admits_exact_remaining_growth_plus_256_mib_boundary(tmp_path: Path) -> None:
    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path, mem_available_kib=524_288)
    runtime_marker = tmp_path / "runtime-constructions"
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            None,
            None,
        ),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "succeeded"
        assert runtime_marker.read_text(encoding="ascii") == "1"
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_busy_host_refuses_before_capacity_snapshot_and_never_waits_behind_http_200(
    tmp_path: Path,
) -> None:
    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path)
    runtime_marker = tmp_path / "runtime-constructions"
    context = multiprocessing.get_context("fork")
    started = context.Event()
    release = context.Event()
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            started,
            release,
        ),
    )

    async def exercise() -> None:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        admitted = asyncio.create_task(CodexAgentClient(socket_path).turn(command))
        assert await asyncio.to_thread(started.wait, 2), "first accepted turn never started"

        old_atime_ns = 1_000_000_000
        for path in (
            paths.meminfo,
            paths.memory_pressure,
            paths.memory_current,
            paths.memory_max,
        ):
            metadata = path.stat()
            os.utime(path, ns=(old_atime_ns, metadata.st_mtime_ns))

        try:
            with pytest.raises(NativeAgentCapacityUnavailable):
                await asyncio.wait_for(CodexAgentClient(socket_path).turn(command), timeout=0.5)
            assert runtime_marker.read_text(encoding="ascii") == "1"
            assert all(
                path.stat().st_atime_ns == old_atime_ns
                for path in (
                    paths.meminfo,
                    paths.memory_pressure,
                    paths.memory_current,
                    paths.memory_max,
                )
            ), "busy request read capacity files before refusing admission"
        finally:
            release.set()
        terminal = await asyncio.wait_for(admitted, timeout=2)
        assert terminal.status == "succeeded"

    try:
        asyncio.run(exercise())
    finally:
        release.set()
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_two_free_slot_arrivals_admit_exactly_one_without_queueing_the_other(
    tmp_path: Path,
) -> None:
    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path)
    runtime_marker = tmp_path / "runtime-constructions"
    context = multiprocessing.get_context("fork")
    started = context.Event()
    release = context.Event()
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            started,
            release,
        ),
    )

    async def exercise() -> None:
        gate = asyncio.Event()
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")

        async def arrive() -> str:
            await gate.wait()
            try:
                terminal = await CodexAgentClient(socket_path).turn(command)
            except NativeAgentCapacityUnavailable:
                return "capacity_unavailable"
            return terminal.status

        arrivals = (asyncio.create_task(arrive()), asyncio.create_task(arrive()))
        gate.set()
        assert await asyncio.to_thread(started.wait, 2), "neither concurrent arrival was admitted"
        try:
            completed, pending = await asyncio.wait(
                arrivals,
                timeout=0.5,
                return_when=asyncio.FIRST_COMPLETED,
            )
            assert len(completed) == 1 and len(pending) == 1, (
                "busy arrival waited behind the accepted HTTP 200"
            )
            refused = next(iter(completed)).result()
            assert refused == "capacity_unavailable"
            assert runtime_marker.read_text(encoding="ascii") == "1"
        finally:
            release.set()
        assert sorted(await asyncio.gather(*arrivals)) == ["capacity_unavailable", "succeeded"]

    try:
        asyncio.run(exercise())
    finally:
        release.set()
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


async def _raw_frames(socket_path: Path, command: object) -> list[dict[str, Any]]:
    """Read every NDJSON frame the host authored, without the client's own bounds."""

    transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
    frames: list[dict[str, Any]] = []
    async with httpx.AsyncClient(transport=transport, timeout=10) as client:
        async with client.stream(
            "POST",
            "http://nexus-codex/v1/turns",
            headers={"accept": "application/x-ndjson", "content-type": "application/json"},
            content=cast(Any, command).model_dump_json(),
        ) as response:
            assert response.status_code == 200
            async for line in response.aiter_lines():
                if line:
                    frames.append(json.loads(line))
    return frames


def test_host_coalesces_per_delta_events_so_a_maximal_output_fits_the_stream_bound(
    tmp_path: Path,
) -> None:
    """Spec §6: the host authors a bounded stream the worker can always accept.

    The pinned Codex adapter yields one event per reasoning and message delta;
    relayed one-to-one, an ordinary structured output at the schema maxima
    overruns the worker's 1024-frame bound and strands the media item as an
    uncertain turn. The real host must coalesce by construction.
    """
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_flood_host, (str(socket_path), str(tmp_path), "per-delta")
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "succeeded"
        assert terminal.structured_output == thaw_json_value(_maximal_terminal().structured_output)

        frames = asyncio.run(_raw_frames(socket_path, command))
        kinds = [frame["event"]["kind"] for frame in frames]
        assert kinds[-1] == "terminal"
        assert len(frames) <= 16, f"host relayed {len(frames)} frames for one turn"
        # thread/started, item/started, the collapsed reasoning run, item/completed,
        # item/started, item/completed: every distinct native transition, once.
        assert kinds.count("native") == 6, "consecutive reasoning deltas must collapse"
        assert (
            "".join(frame["event"]["text"] for frame in frames if frame["event"]["kind"] == "text")
            == _maximal_terminal().final_text
        ), "coalesced text must be the complete message"
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_host_ends_an_unboundable_stream_with_the_typed_bound_terminal(tmp_path: Path) -> None:
    """A stream no coalescing can bound is a known terminal, never a worker-side defect."""
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_flood_host, (str(socket_path), str(tmp_path), "alternating-natives")
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "failed"
        assert terminal.failure is not None and terminal.failure.kind == "output_limit_exceeded"
        assert terminal.diagnostics == (
            "codex agent host turn_stream: stream exceeded its frame bound",
        )
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_client_disconnect_after_acceptance_interrupts_turn_and_holds_slot_through_close(
    tmp_path: Path,
) -> None:
    """Spec §8: the sole slot is held through terminal emission and runtime close.

    A worker that dies after HTTP acceptance must not hand the host a second
    native process: the orphaned turn is interrupted, its runtime is closed, and
    only after that close completes may another turn be admitted into the same
    384 MiB cgroup.
    """
    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path)
    runtime_marker = tmp_path / "runtime-constructions"
    context = multiprocessing.get_context("fork")
    started = context.Event()
    interrupted = context.Event()
    close_started = context.Event()
    close_release = context.Event()
    close_finished = context.Event()
    process, ready = _start_owned_process(
        _run_disconnect_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            started,
            interrupted,
            close_started,
            close_release,
            close_finished,
        ),
    )

    async def exercise() -> None:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            async with client.stream(
                "POST",
                "http://nexus-codex/v1/turns",
                headers={
                    "accept": "application/x-ndjson",
                    "content-type": "application/json",
                },
                content=command.model_dump_json(),
            ) as response:
                assert response.status_code == 200
                assert await asyncio.to_thread(started.wait, 2), "accepted turn never started"
        # Leaving the stream context closed the accepted connection mid-turn.

        assert await asyncio.to_thread(interrupted.wait, 2), (
            "host did not interrupt the turn whose consumer disconnected"
        )
        assert await asyncio.to_thread(close_started.wait, 2), "host did not close the runtime"
        assert not close_finished.is_set()
        with pytest.raises(NativeAgentCapacityUnavailable):
            await CodexAgentClient(socket_path).turn(command)
        assert runtime_marker.read_text(encoding="ascii") == "1", (
            "host admitted a second turn while the interrupted runtime was still closing"
        )

        close_release.set()
        assert await asyncio.to_thread(close_finished.wait, 3), "runtime close never finished"
        terminal = await CodexAgentClient(socket_path).turn(command)
        assert terminal.status == "succeeded"
        assert runtime_marker.read_text(encoding="ascii") == "2"

    try:
        asyncio.run(exercise())
    finally:
        close_release.set()
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


@pytest.mark.parametrize(
    ("status", "content_type", "body", "expected_error"),
    (
        (
            503,
            "application/json",
            b'{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}',
            NativeAgentCapacityUnavailable,
        ),
        (
            503,
            "application/json",
            b'{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable","detail":"leak"}',
            NativeAgentRequestRejected,
        ),
        (
            503,
            "text/plain",
            b'{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}',
            NativeAgentRequestRejected,
        ),
        (
            502,
            "application/json",
            b'{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}',
            NativeAgentRequestRejected,
        ),
    ),
)
def test_client_recognizes_only_the_exact_pre_accept_capacity_response(
    tmp_path: Path,
    status: int,
    content_type: str,
    body: bytes,
    expected_error: type[Exception],
) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_fixed_http_rejection_host,
        (str(socket_path), status, content_type, body),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        with pytest.raises(expected_error):
            asyncio.run(CodexAgentClient(socket_path).turn(command))
        process.join(5)
        assert process.exitcode == 0
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_capacity_canary_emits_only_three_bounded_non_content_turn_facts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path)
    runtime_marker = tmp_path / "runtime-constructions"
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            None,
            None,
        ),
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("NEXUS_CODEX_AGENT_SOCKET", str(socket_path))
    try:
        assert capacity_canary.run() == 0
        output = capsys.readouterr().out
        assert json.loads(output) == {
            "schema_version": "nexus-codex-capacity-canary.v1",
            "status": "passed",
            "turns": [
                {
                    "phase": phase,
                    "terminal_status": "succeeded",
                    "failure_kind": None,
                    "usage_present": True,
                    "sdk_version": "0.144.4",
                    "runtime_version": "0.144.4",
                    "tool_event_count": 0,
                    "permission_event_count": 0,
                }
                for phase in ("cold", "warm_1", "warm_2")
            ],
        }
        assert runtime_marker.read_text(encoding="ascii") == "3"
        assert "Dune" not in output
        assert "Frank Herbert" not in output
        assert "thread-metadata" not in output
        assert "codex-personal" not in output
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_host_fails_closed_and_redacts_a_forbidden_tool_event(tmp_path: Path) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_policy_violation_host,
        (str(socket_path), str(tmp_path)),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "failed"
        assert terminal.failure is not None
        assert terminal.failure.kind == "policy_violation"
        assert terminal.structured_output is None
        assert terminal.diagnostics == ("codex agent host turn_stream: forbidden capability event",)
        process.join(5)
        assert process.exitcode == 0
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_host_normalizes_runtime_cleanup_failure_before_emitting_terminal(tmp_path: Path) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_close_failing_host,
        (str(socket_path), str(tmp_path)),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == "failed"
        assert terminal.failure is not None
        assert terminal.failure.kind == "runtime_defect"
        assert terminal.structured_output is None
        assert terminal.diagnostics == ("codex agent host runtime_close: RuntimeError",)
        process.join(5)
        assert process.exitcode == 0
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


@pytest.mark.parametrize(
    ("reason", "expected_status", "expected_failure", "expected_diagnostic"),
    (
        pytest.param(
            "turn_timeout",
            "failed",
            "turn_timeout",
            "codex agent host turn_stream: turn exceeded its catalog timeout",
            id="timeout",
        ),
        pytest.param(
            "cancelled",
            "cancelled",
            None,
            "codex agent host turn_stream: turn was cancelled before it started",
            id="cancelled",
        ),
        pytest.param(
            "future_reason",
            "failed",
            "runtime_defect",
            "codex agent host turn_stream: turn not started: future_reason",
            id="unknown",
        ),
    ),
)
def test_host_preserves_pre_start_stop_reason_as_a_closed_terminal(
    tmp_path: Path,
    reason: str,
    expected_status: str,
    expected_failure: str | None,
    expected_diagnostic: str,
) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_turn_not_started_host,
        (str(socket_path), str(tmp_path), reason),
    )
    try:
        command = build_metadata_enrichment_command(
            request_id=REQUEST_ID,
            input="bounded input",
        )
        terminal = asyncio.run(CodexAgentClient(socket_path).turn(command))
        assert terminal.status == expected_status, (
            f"pre-start {reason=} produced unexpected terminal status: {terminal}"
        )
        if expected_failure is None:
            assert terminal.failure is None, (
                f"pre-start {reason=} must not attach a failure to cancellation: {terminal}"
            )
        else:
            assert terminal.failure is not None, (
                f"pre-start {reason=} omitted its closed failure: {terminal}"
            )
            assert terminal.failure.kind == expected_failure, (
                f"pre-start {reason=} produced the wrong failure kind: {terminal}"
            )
        assert terminal.diagnostics == (expected_diagnostic,)
        assert terminal.structured_output is None
        process.join(5)
        assert process.exitcode == 0, (
            f"turn-not-started host did not exit cleanly for {reason=}: {process.exitcode}"
        )
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_client_refuses_a_frame_after_terminal_before_returning_success(
    tmp_path: Path,
) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(_run_post_terminal_host, (str(socket_path),))
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        with pytest.raises(NativeAgentProtocolDefect, match="after terminal"):
            asyncio.run(CodexAgentClient(socket_path).turn(command))
        process.join(5)
        assert process.exitcode == 0
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


@pytest.mark.parametrize(
    ("accepted", "expected_error"),
    (
        (False, NativeAgentUnavailable),
        (True, NativeAgentTransportAmbiguous),
    ),
)
def test_client_deadline_classifies_whether_the_host_accepted_the_request(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    accepted: bool,
    expected_error: type[Exception],
) -> None:
    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_stalling_http_host,
        (str(socket_path), accepted),
    )
    monkeypatch.setattr(
        asyncio,
        "timeout",
        lambda _seconds: _REAL_ASYNCIO_TIMEOUT(0.25),
    )
    try:
        command = build_metadata_enrichment_command(request_id=REQUEST_ID, input="bounded input")
        with pytest.raises(expected_error, match="deadline expired"):
            asyncio.run(CodexAgentClient(socket_path).turn(command))
        process.join(5)
        assert process.exitcode == 0
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_startup_recovers_only_a_proven_stale_socket(tmp_path: Path) -> None:
    stale_path = _short_socket_path()
    stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stale.bind(str(stale_path))
    stale.close()
    stale_identity = stale_path.stat()

    _remove_proven_stale_socket(stale_path)

    assert not stale_path.exists()
    assert stale_identity.st_ino > 0

    live_path = _short_socket_path()
    live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    live.bind(str(live_path))
    live.listen(1)
    try:
        live_identity = live_path.stat()
        with pytest.raises(RuntimeError, match="already listening"):
            _remove_proven_stale_socket(live_path)
        assert live_path.stat().st_ino == live_identity.st_ino
    finally:
        live.close()
        live_path.unlink()

    non_socket = tmp_path / "not-a-socket"
    non_socket.write_text("preserve me", encoding="utf-8")
    with pytest.raises(RuntimeError, match="absent or a Unix socket"):
        _remove_proven_stale_socket(non_socket)
    assert non_socket.read_text(encoding="utf-8") == "preserve me"


def test_startup_rejects_overbroad_or_symlinked_private_directories(tmp_path: Path) -> None:
    run_directory = tmp_path / "run"
    state_root = tmp_path / "state"
    working_directory = tmp_path / "work"
    run_directory.mkdir(mode=0o770)
    state_root.mkdir(mode=0o700)
    working_directory.mkdir(mode=0o700)
    os.chmod(run_directory, 0o770)
    os.chmod(state_root, 0o700)
    os.chmod(working_directory, 0o700)
    _validate_directories(run_directory / "agent.sock", state_root, working_directory)

    os.chmod(state_root, 0o755)
    with pytest.raises(RuntimeError, match="state root must have mode 0700"):
        _validate_directories(run_directory / "agent.sock", state_root, working_directory)
    os.chmod(state_root, 0o700)

    linked_state = tmp_path / "linked-state"
    linked_state.symlink_to(state_root, target_is_directory=True)
    with pytest.raises(RuntimeError, match="must not traverse symlinks"):
        _validate_directories(run_directory / "agent.sock", linked_state, working_directory)


def test_host_startup_rejects_run_volume_residue_before_sandbox_or_listener(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import codex_cli_bin

    run_directory = tmp_path / "run"
    state_root = tmp_path / "state"
    working_directory = tmp_path / "work"
    run_directory.mkdir(mode=0o770)
    state_root.mkdir(mode=0o700)
    working_directory.mkdir(mode=0o700)
    os.chmod(run_directory, 0o770)
    os.chmod(state_root, 0o700)
    os.chmod(working_directory, 0o700)
    residue = run_directory / "unexpected-residue"
    residue.write_text("must not share the control volume", encoding="utf-8")

    invocation = tmp_path / "unexpected-sandbox-invocation"
    fake_codex = tmp_path / "codex-residue-fixture"
    fake_codex.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib\n"
        "pathlib.Path(os.environ['UNEXPECTED_SANDBOX_INVOCATION']).write_text("
        "'invoked', encoding='utf-8')\n",
        encoding="utf-8",
    )
    fake_codex.chmod(0o700)
    monkeypatch.setattr(codex_cli_bin, "bundled_codex_path", lambda: fake_codex)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("NEXUS_CODEX_AGENT_SOCKET", str(run_directory / "agent.sock"))
    monkeypatch.setenv("NEXUS_CODEX_STATE_ROOT_BASE", str(state_root))
    monkeypatch.setenv("NEXUS_CODEX_WORKING_DIRECTORY", str(working_directory))
    monkeypatch.setenv("UNEXPECTED_SANDBOX_INVOCATION", str(invocation))

    with pytest.raises(RuntimeError, match="socket directory may contain only its socket"):
        asyncio.run(codex_agent_main.run())

    assert not invocation.exists()
    assert residue.read_text(encoding="utf-8") == "must not share the control volume"
    assert not (run_directory / "agent.sock").exists()


def test_startup_rejects_even_an_empty_inherited_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "")
    with pytest.raises(RuntimeError, match="must not be inherited"):
        reject_api_key_auth()


def test_host_startup_requires_sandbox_after_stale_socket_recovery(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    short_run_directory: Path,
) -> None:
    import codex_cli_bin

    run_directory = short_run_directory
    state_root = tmp_path / "state"
    working_directory = tmp_path / "work"
    state_root.mkdir(mode=0o700)
    working_directory.mkdir(mode=0o700)
    os.chmod(state_root, 0o700)
    os.chmod(working_directory, 0o700)
    socket_path = run_directory / "agent.sock"
    stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stale.bind(str(socket_path))
    stale.close()

    invocation_count = tmp_path / "sandbox-invocations"
    unexpected_args = tmp_path / "unexpected-codex-args"
    fake_codex = tmp_path / "codex-startup-fixture"
    fake_codex.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, sys\n"
        "socket_path = pathlib.Path(os.environ['NEXUS_CODEX_AGENT_SOCKET'])\n"
        "unexpected = pathlib.Path(os.environ['UNEXPECTED_CODEX_ARGS'])\n"
        "if sys.argv[1:] != ['sandbox', '--', '/usr/bin/true']:\n"
        "    unexpected.write_text('\\n'.join(sys.argv[1:]), encoding='utf-8')\n"
        "    raise SystemExit(92)\n"
        "if socket_path.exists():\n"
        "    raise SystemExit(93)\n"
        "counter = pathlib.Path(os.environ['SANDBOX_INVOCATION_COUNT'])\n"
        "count = int(counter.read_text(encoding='utf-8')) + 1 if counter.exists() else 1\n"
        "counter.write_text(str(count), encoding='utf-8')\n"
        "raise SystemExit(17)\n",
        encoding="utf-8",
    )
    fake_codex.chmod(0o700)
    monkeypatch.setattr(codex_cli_bin, "bundled_codex_path", lambda: fake_codex)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("NEXUS_CODEX_AGENT_SOCKET", str(socket_path))
    monkeypatch.setenv("NEXUS_CODEX_STATE_ROOT_BASE", str(state_root))
    monkeypatch.setenv("NEXUS_CODEX_WORKING_DIRECTORY", str(working_directory))
    monkeypatch.setenv("SANDBOX_INVOCATION_COUNT", str(invocation_count))
    monkeypatch.setenv("UNEXPECTED_CODEX_ARGS", str(unexpected_args))

    with pytest.raises(RuntimeError, match="sandbox readiness probe failed"):
        asyncio.run(codex_agent_main.run())

    assert invocation_count.read_text(encoding="utf-8") == "1"
    assert not unexpected_args.exists()
    assert not socket_path.exists()


def test_bundled_cli_wrappers_are_exact_and_reject_api_key_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import codex_cli_bin
    from apps.codex_agent import enroll, sandbox_health

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    fake_codex = tmp_path / "codex-fixture"
    fake_codex.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\n"
        "if failure := os.environ.get('CODEX_FIXTURE_FAILURE'):\n"
        "    raise SystemExit(int(failure))\n"
        "expected = os.environ['EXPECTED_CODEX_ARGUMENTS'].split('\\n')\n"
        "raise SystemExit(0 if sys.argv[1:] == expected else 91)\n",
        encoding="utf-8",
    )
    fake_codex.chmod(0o700)
    monkeypatch.setattr(codex_cli_bin, "bundled_codex_path", lambda: fake_codex)
    monkeypatch.setenv("EXPECTED_CODEX_ARGUMENTS", "sandbox\n--\n/usr/bin/true")
    sandbox_health.check()

    monkeypatch.setenv("CODEX_FIXTURE_FAILURE", "1")
    with pytest.raises(RuntimeError, match="readiness probe failed"):
        sandbox_health.check()
    monkeypatch.delenv("CODEX_FIXTURE_FAILURE")

    monkeypatch.setenv("CODEX_HOME", str((tmp_path / "codex-home").resolve()))
    monkeypatch.setenv("EXPECTED_CODEX_ARGUMENTS", "login\n--device-auth")
    login = multiprocessing.get_context("fork").Process(target=enroll.main)
    login.start()
    login.join(5)
    assert login.exitcode == 0, "enrollment must exec the bundled CLI with device auth"

    monkeypatch.setenv("OPENAI_API_KEY", "")
    with pytest.raises(RuntimeError, match="must not be inherited"):
        sandbox_health.check()
    with pytest.raises(RuntimeError, match="must not be inherited"):
        enroll.main()


@pytest.mark.parametrize(
    ("probe_exit", "inherited_api_key", "expected_returncode"),
    (
        pytest.param(17, False, 1, id="probe-nonzero"),
        pytest.param(0, False, 0, id="probe-success"),
        pytest.param(0, True, 1, id="api-key-present"),
    ),
)
def test_sandbox_health_cli_is_silent_on_every_path(
    tmp_path: Path,
    probe_exit: int,
    inherited_api_key: bool,
    expected_returncode: int,
) -> None:
    """Risk: host-readiness diagnostics leak internal or credential context."""

    fake_codex = tmp_path / "codex-sandbox-fixture"
    fake_codex.write_text(
        f"#!{sys.executable}\nraise SystemExit({probe_exit})\n",
        encoding="utf-8",
    )
    fake_codex.chmod(0o700)
    environment = dict(os.environ)
    environment.pop("OPENAI_API_KEY", None)
    if inherited_api_key:
        environment["OPENAI_API_KEY"] = "sk-test-must-never-print"
    environment["FAKE_CODEX_PATH"] = str(fake_codex)
    result = subprocess.run(
        (
            sys.executable,
            "-c",
            (
                "import os\n"
                "from pathlib import Path\n"
                "import codex_cli_bin\n"
                "codex_cli_bin.bundled_codex_path = "
                "lambda: Path(os.environ['FAKE_CODEX_PATH'])\n"
                "from apps.codex_agent import sandbox_health\n"
                "sandbox_health.main()\n"
            ),
        ),
        cwd=Path(__file__).parents[3],
        env=environment,
        capture_output=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == expected_returncode
    assert result.stdout == b""
    assert result.stderr == b""


def _refusing_runtime_factory() -> ScriptedAgentRuntime:
    raise AssertionError("request admission must not construct AgentRuntime")


def _run_admission_guard_host(
    socket_path: str,
    cwd: str,
    ready: multiprocessing.connection.Connection,
) -> None:
    """Serve the real host over UDS with a runtime factory that must never run."""

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    app = create_codex_agent_app(
        runtime_factory=_refusing_runtime_factory,
        working_directory=Path(cwd),
        versions=_VERSIONS,
        capacity_paths=_capacity_paths(Path(cwd)),
    )
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
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _uds_client(socket_path: Path) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(uds=str(socket_path)),
        base_url="http://nexus-codex",
        timeout=5,
    )


def test_host_serves_no_framework_docs_endpoints(tmp_path: Path) -> None:
    """Risk: FastAPI default docs expose the private operation surface."""

    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_admission_guard_host,
        (str(socket_path), str(tmp_path)),
    )

    async def observe() -> list[int]:
        async with _uds_client(socket_path) as client:
            return [
                (await client.get(path)).status_code
                for path in ("/docs", "/redoc", "/openapi.json")
            ]

    try:
        assert asyncio.run(observe()) == [404, 404, 404]
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_host_bounds_the_command_body_before_admission(tmp_path: Path) -> None:
    """Risk: an unbounded or undeclared body is buffered before rejection.

    The 256 KiB cap is the socket's transport-DoS guard, deliberately decoupled
    from the operation's decoded 32 KiB input bound (JSON escaping expands legal
    input), so the proof asserts against the host's own constant.
    """

    socket_path = _short_socket_path()
    process, ready = _start_owned_process(
        _run_admission_guard_host,
        (str(socket_path), str(tmp_path)),
    )
    headers = {"accept": "application/x-ndjson", "content-type": "application/json"}

    async def undeclared_body() -> AsyncIterator[bytes]:
        yield b"{}"

    async def observe() -> list[tuple[int, object]]:
        observed: list[tuple[int, object]] = []
        async with _uds_client(socket_path) as client:
            undeclared = await client.post(
                "/v1/turns",
                headers=headers,
                content=undeclared_body(),
            )
            observed.append((undeclared.status_code, undeclared.json()["detail"]))
            oversized = await client.post(
                "/v1/turns",
                headers=headers,
                content=b"x" * (codex_agent_host._MAX_COMMAND_BODY_BYTES + 1),
            )
            observed.append((oversized.status_code, oversized.json()["detail"]))
            malformed = await client.post("/v1/turns", headers=headers, content=b"{}")
            observed.append((malformed.status_code, malformed.json()["detail"]))
        return observed

    try:
        assert asyncio.run(observe()) == [
            (411, "content length is required"),
            (413, "command exceeds its byte bound"),
            (422, "command is not a valid native agent command"),
        ]
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_health_command_prints_the_exact_ready_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The release controller parses this stdout, so the real command must print it."""

    socket_path = _short_socket_path()
    paths = _capacity_paths(tmp_path)
    runtime_marker = tmp_path / "runtime-constructions"
    process, ready = _start_owned_process(
        _run_capacity_host,
        (
            str(socket_path),
            str(tmp_path),
            str(paths.meminfo.parent),
            str(runtime_marker),
            None,
            None,
        ),
    )
    monkeypatch.setenv("NEXUS_CODEX_AGENT_SOCKET", str(socket_path))
    try:
        codex_agent_health.main()
        output = capsys.readouterr().out
        assert output == NativeAgentHealth().model_dump_json() + "\n"
        assert json.loads(output) == {
            "schema_version": "nexus-agent-health.v1",
            "status": "ready",
            "backend": "codex",
            "transport": "sdk",
            "auth_profile": "codex-personal",
        }
    finally:
        ready.close()
        if process.is_alive():
            process.terminate()
            process.join(5)


def _canonical_json(value: object) -> str:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True
    )
