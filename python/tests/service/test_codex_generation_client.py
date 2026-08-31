"""Real-UDS RED proof for the strict v2 Codex generation client."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import socket
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from tempfile import gettempdir
from typing import Any
from uuid import UUID, uuid4

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from nexus.services import generation_policy
from nexus.services.codex_generation_client import (
    CodexGenerationCapacityUnavailable,
    CodexGenerationClient,
    CodexGenerationProtocolDefect,
    CodexGenerationRequestRejected,
    CodexGenerationTransportAmbiguous,
    CodexGenerationUnavailable,
)
from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationAdmissionRequest,
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
)

_REQUEST_ID = UUID("755a2de9-2bdc-5c57-a6a0-17a2407f14bb")
_REJECTED_CONTROL_ID = UUID("4c80ea23-46b9-570b-bf5d-87f715edf95b")
_SDK_VERSION = "0.144.4"
_RUNTIME_VERSION = "0.144.4"
_LINUX_SUN_PATH_BYTES = 108
_EXACT_CAPACITY_REJECTION = (
    b'{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}'
)
_ACCEPTED_AT = "2026-08-24T12:34:56.123456Z"


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-generation-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode()) < _LINUX_SUN_PATH_BYTES
    return socket_path


def _command(mode: str) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "schema_version": "nexus-generation-command.v2",
            "request_id": str(_REQUEST_ID),
            "operation": {
                "kind": "metadata_enrichment",
                "revision": generation_policy.operation_revision("metadata_enrichment"),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": {
                "instructions": "Return the bounded result.",
                "input": mode,
                "output": {"kind": "Text"},
            },
        }
    )


def _chat_command(mode: str) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "schema_version": "nexus-generation-command.v2",
            "request_id": str(_REQUEST_ID),
            "operation": {
                "kind": "chat",
                "profile": "balanced",
                "revision": generation_policy.operation_revision("chat", profile="balanced"),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": {
                "instructions": "Return the bounded result.",
                "input": mode,
                "output": {"kind": "Text"},
            },
            "tool_grant": {
                "kind": "Bearer",
                "token": "client-admission-proof-grant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
        }
    )


def _health(*, policy_revision: str = generation_policy.POLICY_REVISION) -> bytes:
    return (
        GenerationHealth(
            policy_revision=policy_revision,
            sdk_version=_SDK_VERSION,
            runtime_version=_RUNTIME_VERSION,
        )
        .model_dump_json()
        .encode()
    )


def _frame(sequence: int, event: GenerationText | GenerationTerminal) -> bytes:
    return (
        GenerationFrame(
            request_id=_REQUEST_ID,
            sequence=sequence,
            event=event,
        ).model_dump_json()
        + "\n"
    ).encode()


def _terminal() -> GenerationTerminal:
    return GenerationTerminal(
        status="succeeded",
        failure=None,
        final_text="bounded result",
        structured_output=None,
        session_ref=GenerationSessionRef(
            schema_version="agent-session-ref.v1",
            backend="codex",
            transport="sdk",
            native_session_id="thread-client-proof",
            profile_key="codex-personal",
            state_root_fingerprint="1" * 64,
            cwd_fingerprint="2" * 64,
        ),
        usage=None,
        diagnostics=(),
        accepted_at="2026-08-24T12:34:56.123456Z",
        sdk_version=_SDK_VERSION,
        runtime_version=_RUNTIME_VERSION,
    )


async def _serve_until_stopped(
    server: uvicorn.Server,
    listener: socket.socket,
    stop: Any,
) -> None:
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    await asyncio.to_thread(stop.wait)
    server.should_exit = True
    await serving


def _run_protocol_peer(
    socket_path: str,
    health_mismatch: bool,
    first_frame_sent: Any,
    release_stream: Any,
    stop: Any,
    report: multiprocessing.connection.Connection,
    ready: multiprocessing.connection.Connection,
) -> None:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    admissions: dict[str, GenerationAdmission] = {}

    @app.get("/health")
    async def health(request: Request) -> Response:
        report.send(("health", request.url.path))
        revision = (
            f"{generation_policy.POLICY_REVISION}.drifted"
            if health_mismatch
            else generation_policy.POLICY_REVISION
        )
        return Response(_health(policy_revision=revision), media_type="application/json")

    @app.post("/v2/generations")
    async def generate(request: Request) -> Response:
        payload = json.loads(await request.body())
        mode = payload["intent"]["input"]
        report.send(("generation", request.url.path, mode))
        if mode == "accepted-capacity":
            admission_id = request.headers.get("nexus-generation-admission")
            if admission_id is None or admission_id not in admissions:
                return Response(status_code=409)
            return Response(
                _EXACT_CAPACITY_REJECTION,
                status_code=503,
                media_type="application/json",
            )
        if mode == "capacity-exact":
            return Response(
                _EXACT_CAPACITY_REJECTION,
                status_code=503,
                media_type="application/json",
            )
        if mode == "capacity-content-type-near-miss":
            return Response(
                _EXACT_CAPACITY_REJECTION,
                status_code=503,
                headers={"content-type": "application/json; charset=utf-8"},
            )
        if mode == "capacity-body-near-miss":
            return Response(
                _EXACT_CAPACITY_REJECTION + b"\n",
                status_code=503,
                media_type="application/json",
            )

        async def frames() -> AsyncIterator[bytes]:
            if mode == "incremental":
                yield _frame(0, GenerationText(text="first"))
                first_frame_sent.set()
                released = await asyncio.to_thread(release_stream.wait, 5)
                if released:
                    yield _frame(1, GenerationText(text="second"))
                    yield _frame(2, _terminal())
                return
            if mode == "sequence-gap":
                yield _frame(1, GenerationText(text="gap"))
                return
            if mode == "after-terminal":
                yield _frame(0, _terminal())
                yield _frame(1, GenerationText(text="late"))
                return
            if mode == "oversized-frame":
                bound = generation_policy.operation_policy(
                    "metadata_enrichment"
                ).stream.max_frame_bytes
                yield _frame(0, GenerationText(text="x" * (bound + 1)))
                return
            if mode == "accepted-stream-loss":
                yield _frame(0, GenerationText(text="accepted"))
                return
            raise AssertionError(f"unknown protocol-peer mode {mode!r}")

        return StreamingResponse(frames(), media_type="application/x-ndjson")

    @app.post("/v2/generation-admissions")
    async def admit(request: Request) -> Response:
        admission_request = GenerationAdmissionRequest.model_validate_json(await request.body())
        admission = GenerationAdmission(
            request_id=admission_request.request_id,
            admission_id=uuid4(),
            admitted_at=_ACCEPTED_AT,
            runtime_deadline_seconds=generation_policy.CHAT_ADMISSION_RUNTIME_SECONDS,
        )
        admissions[str(admission.admission_id)] = admission
        report.send(("admission", request.url.path, str(admission_request.request_id)))
        return Response(
            admission.model_dump_json().encode(),
            media_type="application/json",
        )

    @app.post("/v2/generations/{request_id}/cancel")
    async def cancel(request_id: str, request: Request) -> Response:
        report.send(("cancel", request.url.path, request_id, len(await request.body())))
        return Response(status_code=204)

    @app.post("/v2/generations/{request_id}/policy-violation")
    async def policy_violation(request_id: str, request: Request) -> Response:
        report.send(("policy_violation", request.url.path, request_id, len(await request.body())))
        if request_id == str(_REJECTED_CONTROL_ID):
            return Response(status_code=409)
        return Response(status_code=204)

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


def _start_peer(
    *, health_mismatch: bool = False
) -> tuple[
    Path,
    multiprocessing.Process,
    multiprocessing.connection.Connection,
    multiprocessing.connection.Connection,
    Any,
    Any,
    Any,
]:
    context = multiprocessing.get_context("fork")
    socket_path = _short_socket_path()
    first_frame_sent = context.Event()
    release_stream = context.Event()
    stop = context.Event()
    report_parent, report_child = context.Pipe(duplex=False)
    ready_parent, ready_child = context.Pipe(duplex=False)
    process = context.Process(
        target=_run_protocol_peer,
        args=(
            str(socket_path),
            health_mismatch,
            first_frame_sent,
            release_stream,
            stop,
            report_child,
            ready_child,
        ),
    )
    process.start()
    report_child.close()
    ready_child.close()
    assert ready_parent.poll(5), f"UDS protocol peer {process.pid} did not become ready"
    assert ready_parent.recv() == "ready"
    return (
        socket_path,
        process,
        report_parent,
        ready_parent,
        first_frame_sent,
        release_stream,
        stop,
    )


def _stop_peer(process: multiprocessing.Process, stop: Any) -> None:
    stop.set()
    process.join(5)
    if process.is_alive():
        process.terminate()
        process.join(5)
    assert process.exitcode == 0


async def _drain(client: CodexGenerationClient, mode: str) -> list[GenerationFrame]:
    return [frame async for frame in client.stream(_command(mode))]


def _messages(connection: multiprocessing.connection.Connection) -> Iterator[tuple[Any, ...]]:
    while connection.poll():
        yield connection.recv()


def test_v2_client_preflights_and_classifies_only_strict_incremental_streams() -> None:
    (
        socket_path,
        process,
        report,
        ready,
        first_frame_sent,
        release_stream,
        stop,
    ) = _start_peer()
    try:
        client = CodexGenerationClient(socket_path)

        async def exercise() -> None:
            health = await client.health()
            assert health.policy_revision == generation_policy.POLICY_REVISION

            stream = client.stream(_command("incremental")).__aiter__()
            first = await asyncio.wait_for(anext(stream), 2)
            assert first.sequence == 0
            assert isinstance(first.event, GenerationText)
            assert first.event.text == "first"
            assert first_frame_sent.is_set()
            assert not release_stream.is_set(), "client buffered instead of yielding frame zero"
            release_stream.set()
            remainder = [frame async for frame in stream]
            assert [frame.sequence for frame in remainder] == [1, 2]
            assert isinstance(remainder[-1].event, GenerationTerminal)

            for mode in ("sequence-gap", "after-terminal", "oversized-frame"):
                with pytest.raises(CodexGenerationProtocolDefect):
                    await _drain(client, mode)

            observed: list[GenerationFrame] = []
            with pytest.raises(CodexGenerationTransportAmbiguous):
                async for frame in client.stream(_command("accepted-stream-loss")):
                    observed.append(frame)
            assert [frame.sequence for frame in observed] == [0]

            with pytest.raises(CodexGenerationCapacityUnavailable):
                await _drain(client, "capacity-exact")
            for mode in (
                "capacity-content-type-near-miss",
                "capacity-body-near-miss",
            ):
                with pytest.raises(CodexGenerationRequestRejected):
                    await _drain(client, mode)

            chat_command = _chat_command("accepted-capacity")

            async def bind_admission(_admission: GenerationAdmission) -> GenerationCommand:
                return chat_command

            with pytest.raises(CodexGenerationTransportAmbiguous):
                async for _frame_value in client.stream(
                    chat_command,
                    bind_admission=bind_admission,
                ):
                    pass

            await client.cancel(_REQUEST_ID)
            await client.cancel(_REQUEST_ID)
            await client.policy_violation(_REQUEST_ID)
            with pytest.raises(CodexGenerationRequestRejected):
                await client.policy_violation(_REJECTED_CONTROL_ID)

        asyncio.run(exercise())
        messages = tuple(_messages(report))
        generation_paths = [item[1] for item in messages if item[0] == "generation"]
        assert generation_paths == ["/v2/generations"] * 9
        admission_paths = [item[1] for item in messages if item[0] == "admission"]
        assert admission_paths == ["/v2/generation-admissions"]
        cancel_paths = [item[1] for item in messages if item[0] == "cancel"]
        assert cancel_paths == [f"/v2/generations/{_REQUEST_ID}/cancel"] * 2
        policy_controls = [item for item in messages if item[0] == "policy_violation"]
        assert policy_controls == [
            (
                "policy_violation",
                f"/v2/generations/{_REQUEST_ID}/policy-violation",
                str(_REQUEST_ID),
                0,
            ),
            (
                "policy_violation",
                f"/v2/generations/{_REJECTED_CONTROL_ID}/policy-violation",
                str(_REJECTED_CONTROL_ID),
                0,
            ),
        ]
    finally:
        ready.close()
        report.close()
        _stop_peer(process, stop)

    with pytest.raises(CodexGenerationUnavailable):
        asyncio.run(client.policy_violation(_REQUEST_ID))

    (
        mismatch_path,
        mismatch_process,
        mismatch_report,
        mismatch_ready,
        _first_frame_sent,
        _release_stream,
        mismatch_stop,
    ) = _start_peer(health_mismatch=True)
    try:
        mismatch_client = CodexGenerationClient(mismatch_path)
        with pytest.raises(CodexGenerationProtocolDefect, match="policy"):
            asyncio.run(_drain(mismatch_client, "incremental"))
        assert tuple(_messages(mismatch_report)) == (("health", "/health"),)
    finally:
        mismatch_ready.close()
        mismatch_report.close()
        _stop_peer(mismatch_process, mismatch_stop)
