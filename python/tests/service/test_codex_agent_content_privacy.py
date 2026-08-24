"""Content-retention proof across the real Codex host and metadata worker."""

from __future__ import annotations

import asyncio
import multiprocessing
import socket
from pathlib import Path
from uuid import UUID, uuid4

import uvicorn
from apps.codex_agent.capacity import CapacityPaths
from apps.codex_agent.host import RuntimeVersions, create_codex_agent_app
from provider_runtime import Absent
from provider_runtime.agent_runtime import (
    AgentFailure,
    AgentSession,
    AgentSessionRef,
    AgentTerminal,
    ScriptedAgentRuntime,
)
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import LibraryEntry, Media, ProcessingStatus
from nexus.jobs.queue import enqueue_job
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.native_agent_client import CodexAgentClient
from nexus.services.native_agent_operations import build_metadata_enrichment_command
from nexus_test_control import services as test_services
from tests.testkit.worker import controller_run, kill_and_forget_process, wait_for_job

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}
_DIAGNOSTIC_CONTENT = "private-document-sentence-e7a88f37 must never be retained"


def _session_ref() -> AgentSessionRef:
    return AgentSessionRef(
        schema_version="agent-session-ref.v1",
        backend="codex",
        transport="sdk",
        native_session_id="thread-content-privacy",
        profile_key="codex-personal",
        state_root_fingerprint="1" * 64,
        cwd_fingerprint="2" * 64,
    )


def _failed_terminal() -> AgentTerminal:
    return AgentTerminal(
        status="failed",
        failure=AgentFailure("backend_failed"),
        final_text=_DIAGNOSTIC_CONTENT,
        structured_output=None,
        session_ref=_session_ref(),
        usage=Absent(),
        diagnostics=(_DIAGNOSTIC_CONTENT,),
    )


def _run_host(
    socket_path: str,
    working_directory: str,
    capacity_root: str,
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
        return ScriptedAgentRuntime(
            sessions=(AgentSession(_session_ref()),),
            stream_scripts=((_failed_terminal(),),),
        )

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=Path(working_directory),
        versions=RuntimeVersions(sdk="0.144.4", runtime="0.144.4"),
        capacity_paths=paths,
    )
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="critical", lifespan="off", timeout_graceful_shutdown=2)
    )
    try:
        listener.bind(socket_path)
        listener.listen(16)
        ready.send("ready")
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()
        Path(socket_path).unlink(missing_ok=True)


def _start_host(
    tmp_path: Path,
) -> tuple[Path, multiprocessing.Process, multiprocessing.connection.Connection]:
    socket_path = tmp_path / "content-privacy.sock"
    assert len(str(socket_path).encode("utf-8")) < 108, "UDS path must fit sun_path"
    capacity_root = tmp_path / "capacity"
    capacity_root.mkdir()
    (capacity_root / "meminfo").write_text("MemAvailable: 700000 kB\n", encoding="ascii")
    (capacity_root / "memory.pressure").write_text(
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
        encoding="ascii",
    )
    (capacity_root / "memory.current").write_text("134217728\n", encoding="ascii")
    (capacity_root / "memory.max").write_text("402653184\n", encoding="ascii")
    parent, child = multiprocessing.Pipe(duplex=False)
    process = multiprocessing.get_context("fork").Process(
        target=_run_host,
        args=(str(socket_path), str(tmp_path), str(capacity_root), child),
    )
    process.start()
    child.close()
    assert parent.poll(5) and parent.recv() == "ready"
    return socket_path, process, parent


def _seed_metadata_job(engine: Engine) -> tuple[UUID, UUID]:
    media_id = uuid4()
    user_id = uuid4()
    with Session(engine) as db:
        library_id = ensure_user_and_default_library(
            db,
            user_id,
            f"content-privacy-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind="epub",
                title="private.epub",
                plain_text="A bounded content sample.",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        db.add(LibraryEntry(library_id=library_id, media_id=media_id, position=0))
        job = enqueue_job(
            db,
            kind="enrich_metadata",
            payload={
                "media_id": str(media_id),
                "request_id": "content-privacy-proof",
                "capacity_wait_index": 0,
            },
            max_attempts=2,
        )
        db.commit()
    return media_id, job.id


def test_provider_diagnostic_content_neither_crosses_the_host_nor_reaches_persistence(
    engine: Engine,
    tmp_path: Path,
) -> None:
    run = controller_run()
    socket_path, host, ready = _start_host(tmp_path)
    media_id, job_id = _seed_metadata_job(engine)
    worker: test_services.StartedProcess | None = None
    try:
        observed = asyncio.run(
            CodexAgentClient(socket_path).turn(
                build_metadata_enrichment_command(request_id=uuid4(), input="bounded input")
            )
        )
        worker = test_services.start_python_process(
            _REPO_ROOT,
            _TEST_ENV,
            run,
            "worker-background",
            overrides={
                "NEXUS_CODEX_AGENT_SOCKET": str(socket_path),
                "WORKER_POLL_INTERVAL_SECONDS": "0.1",
            },
        )
        wait_for_job(engine, job_id, status="succeeded", attempts=1)
    finally:
        if worker is not None:
            kill_and_forget_process(worker)
        ready.close()
        if host.is_alive():
            host.terminate()
        host.join(5)
        socket_path.unlink(missing_ok=True)

    with Session(engine) as db:
        audit_detail = db.scalar(
            text(
                "SELECT error_detail FROM agent_turns "
                "WHERE owner_kind = 'media_enrichment' AND owner_id = :media_id"
            ),
            {"media_id": media_id},
        )
        media = db.get(Media, media_id)
        assert media is not None
        retained = (
            observed.final_text,
            *observed.diagnostics,
            audit_detail,
            media.last_error_message,
        )

    assert all(_DIAGNOSTIC_CONTENT not in str(value) for value in retained), (
        "provider diagnostic content crossed a retention boundary"
    )
    # The host still owes its caller a diagnosable failure: it emits exactly its
    # own bounded phase diagnostic, never the upstream provider text.
    assert observed.diagnostics == (
        "codex agent host turn_stream: provider terminal failed: backend_failed",
    )
    assert observed.final_text == ""
