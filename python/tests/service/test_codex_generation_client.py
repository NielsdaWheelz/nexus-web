"""Real-UDS proof for the strict frozen-spec Codex generation client."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import socket
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from pathlib import Path
from tempfile import gettempdir
from typing import Any
from uuid import UUID, uuid4

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import SecretStr

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
    GenerationCommandDraft,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
    generation_command_from_draft,
    generation_draft_fingerprint,
)
from nexus.services.generation_intent import BearerToolGrant
from nexus.services.tool_runtime.composition import freeze_tool_plan_snapshot
from tests.testkit.codex_generation import (
    codex_generation_draft,
    codex_model_tool_fixture,
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


def _command(mode: str) -> GenerationCommandDraft:
    return codex_generation_draft(
        request_id=_REQUEST_ID,
        operation="metadata_enrichment",
        instructions="Return the bounded result.",
        input_text=mode,
        model="gpt-5.6-luna",
        reasoning="low",
        turn_timeout_seconds=120,
    )


def _chat_draft(mode: str) -> GenerationCommandDraft:
    _registry, runtime = codex_model_tool_fixture()
    return codex_generation_draft(
        request_id=_REQUEST_ID,
        operation="chat",
        instructions="Return the bounded result.",
        input_text=mode,
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=900,
        model_tool_plan=freeze_tool_plan_snapshot(runtime.operations["ChatRead"]),
    )


def _health(*, runtime_version: str = _RUNTIME_VERSION) -> bytes:
    return (
        GenerationHealth(
            sdk_version=_SDK_VERSION,
            runtime_version=runtime_version,
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
    admission_modes = {
        generation_draft_fingerprint(_command(mode)): mode
        for mode in (
            "incremental",
            "sequence-gap",
            "after-terminal",
            "oversized-frame",
            "accepted-stream-loss",
            "capacity-exact",
            "capacity-content-type-near-miss",
            "capacity-body-near-miss",
        )
    }
    admission_modes[generation_draft_fingerprint(_chat_draft("accepted-capacity"))] = (
        "accepted-capacity"
    )

    @app.get("/health")
    async def health(request: Request) -> Response:
        report.send(("health", request.url.path))
        runtime_version = f"{_RUNTIME_VERSION}.drifted" if health_mismatch else _RUNTIME_VERSION
        return Response(_health(runtime_version=runtime_version), media_type="application/json")

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
                bound = payload["spec"]["bounds"]["stream"]["max_frame_bytes"]
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
        mode = admission_modes[admission_request.request_fingerprint]
        report.send(("admission", request.url.path, str(admission_request.request_id), mode))
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
        admission = GenerationAdmission(
            request_id=admission_request.request_id,
            admission_id=uuid4(),
            admitted_at=_ACCEPTED_AT,
            runtime_deadline_seconds=admission_request.turn_timeout_seconds,
        )
        admissions[str(admission.admission_id)] = admission
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
    return [frame async for frame in _bound_stream(client, _command(mode))]


def _bound_stream(
    client: CodexGenerationClient,
    draft: GenerationCommandDraft,
    admissions: list[GenerationAdmission] | None = None,
) -> AsyncGenerator[GenerationFrame]:
    async def bind_admission(admission: GenerationAdmission) -> GenerationCommand:
        if admissions is not None:
            admissions.append(admission)
        return generation_command_from_draft(draft, tool_grant=None)

    return client.stream(draft, bind_admission=bind_admission)


def _messages(connection: multiprocessing.connection.Connection) -> Iterator[tuple[Any, ...]]:
    while connection.poll():
        yield connection.recv()


def test_v3_client_preflights_and_classifies_only_strict_incremental_streams() -> None:
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
            assert health.sdk_version == _SDK_VERSION
            assert health.runtime_version == _RUNTIME_VERSION

            tool_free_admissions: list[GenerationAdmission] = []
            stream = _bound_stream(
                client,
                _command("incremental"),
                tool_free_admissions,
            ).__aiter__()
            first = await asyncio.wait_for(anext(stream), 2)
            assert first.sequence == 0
            assert isinstance(first.event, GenerationText)
            assert first.event.text == "first"
            assert len(tool_free_admissions) == 1, (
                "tool-free generation was dispatched before its durable admission binding"
            )
            # The peer flags frame zero after its write lands, so the client can
            # observe the frame first; wait for the flag instead of sampling it.
            assert first_frame_sent.wait(2), "peer never reported sending frame zero"
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
                async for frame in _bound_stream(client, _command("accepted-stream-loss")):
                    observed.append(frame)
            assert [frame.sequence for frame in observed] == [0]

            capacity_admissions: list[GenerationAdmission] = []
            with pytest.raises(CodexGenerationCapacityUnavailable):
                async for _frame_value in _bound_stream(
                    client,
                    _command("capacity-exact"),
                    capacity_admissions,
                ):
                    pass
            assert capacity_admissions == [], (
                "pre-admission capacity refusal must not arm durable model work"
            )
            for mode in (
                "capacity-content-type-near-miss",
                "capacity-body-near-miss",
            ):
                with pytest.raises(CodexGenerationRequestRejected):
                    await _drain(client, mode)

            chat_draft = _chat_draft("accepted-capacity")

            async def bind_admission(_admission: GenerationAdmission) -> GenerationCommand:
                return generation_command_from_draft(
                    chat_draft,
                    tool_grant=BearerToolGrant(
                        token=SecretStr(
                            "client-admission-proof-grant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        )
                    ),
                )

            with pytest.raises(CodexGenerationTransportAmbiguous):
                async for _frame_value in client.stream(
                    chat_draft,
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
        generation_modes = [item[2] for item in messages if item[0] == "generation"]
        assert generation_modes == [
            "incremental",
            "sequence-gap",
            "after-terminal",
            "oversized-frame",
            "accepted-stream-loss",
            "accepted-capacity",
        ]
        admission_modes = [item[3] for item in messages if item[0] == "admission"]
        assert admission_modes == [
            "incremental",
            "sequence-gap",
            "after-terminal",
            "oversized-frame",
            "accepted-stream-loss",
            "capacity-exact",
            "capacity-content-type-near-miss",
            "capacity-body-near-miss",
            "accepted-capacity",
        ]
        dispatch_order = [
            (item[0], item[3] if item[0] == "admission" else item[2])
            for item in messages
            if item[0] in {"admission", "generation"}
        ]
        assert dispatch_order == [
            ("admission", "incremental"),
            ("generation", "incremental"),
            ("admission", "sequence-gap"),
            ("generation", "sequence-gap"),
            ("admission", "after-terminal"),
            ("generation", "after-terminal"),
            ("admission", "oversized-frame"),
            ("generation", "oversized-frame"),
            ("admission", "accepted-stream-loss"),
            ("generation", "accepted-stream-loss"),
            ("admission", "capacity-exact"),
            ("admission", "capacity-content-type-near-miss"),
            ("admission", "capacity-body-near-miss"),
            ("admission", "accepted-capacity"),
            ("generation", "accepted-capacity"),
        ]
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
        with pytest.raises(CodexGenerationProtocolDefect, match="runtime identity"):
            asyncio.run(_drain(mismatch_client, "incremental"))
        assert tuple(_messages(mismatch_report)) == (("health", "/health"),)
    finally:
        mismatch_ready.close()
        mismatch_report.close()
        _stop_peer(mismatch_process, mismatch_stop)
