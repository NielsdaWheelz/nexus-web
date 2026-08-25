"""Priority proof for Chat's durable Codex execution boundary.

The deterministic peer is a protocol-valid external UDS process. Chat, the
queue, PostgreSQL ledger/journal, event fold, and reconnect projection are all
production owners; only the private Codex host response is controlled.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import multiprocessing
import os
import socketserver
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ChatRun, ChatRunEvent, LLMCall, Message
from nexus.db.session import create_session_factory
from nexus.jobs.queue import RescheduleRequested, get_job, lock_running_job_claim
from nexus.services import generation_policy
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.chat_runs import (
    CancelledChatExecution,
    FailedChatExecution,
    PublishedChatExecution,
    SkippedChatExecution,
    cancel_chat_run,
    execute_chat_run,
    get_chat_run,
)
from nexus.services.codex_generation_client import (
    CodexGenerationCapacityUnavailable,
    CodexGenerationClient,
)
from nexus.services.codex_generation_contract import (
    MAX_COMMAND_BODY_BYTES,
    GenerationCommand,
    GenerationFailure,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
    GenerationUsage,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.chat import create_entitled_chat
from tests.testkit.llm_tool_scenarios import claim_chat_tool_job

type TerminalMode = Literal["cancelled", "failed", "succeeded"]

_ACCEPTED_AT = "2026-08-25T12:34:56.123456Z"
_PARTIAL_TEXT = "Visible partial answer."
_LARGE_MULTIBYTE_TEXT = "λ" * 3_000
_SDK_VERSION = importlib.metadata.version("openai-codex")
_RUNTIME_VERSION = importlib.metadata.version("openai-codex-cli-bin")


@dataclass(frozen=True, slots=True)
class _GenerationPeer:
    socket_path: Path
    audit_path: Path
    process: multiprocessing.Process
    request_observed: Any
    release_response: Any


class _CapacityThenSuccessfulChatRuntime:
    """Controlled host boundary that observes the caller's transaction state."""

    def __init__(self, caller_db: Session) -> None:
        self.caller_db = caller_db
        self.commands: list[GenerationCommand] = []
        self.transaction_entrypoints: list[str] = []

    def _observe_entry(self, entrypoint: str) -> None:
        assert not self.caller_db.in_transaction(), (
            f"Chat caller transaction crossed the generation {entrypoint} boundary"
        )
        self.transaction_entrypoints.append(entrypoint)

    async def health(self) -> GenerationHealth:
        self._observe_entry("health")
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version=_SDK_VERSION,
            runtime_version=_RUNTIME_VERSION,
        )

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        self._observe_entry("stream")
        self.commands.append(command)

        async def frames() -> AsyncIterator[GenerationFrame]:
            if len(self.commands) == 1:
                raise CodexGenerationCapacityUnavailable("controlled capacity refusal")
            yield GenerationFrame(
                request_id=command.request_id,
                sequence=0,
                event=GenerationText(text=_PARTIAL_TEXT),
            )
            yield GenerationFrame(
                request_id=command.request_id,
                sequence=1,
                event=_terminal(command, "succeeded"),
            )

        return frames()

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unexpected Chat cancellation for {request_id}")


def _frame(command: GenerationCommand, sequence: int, event: object) -> bytes:
    return (
        GenerationFrame.model_validate(
            {
                "request_id": command.request_id,
                "sequence": sequence,
                "event": event,
            }
        ).model_dump_json()
        + "\n"
    ).encode("utf-8")


def _terminal(
    command: GenerationCommand,
    mode: TerminalMode,
    *,
    response_text: str = _PARTIAL_TEXT,
) -> GenerationTerminal:
    failure = GenerationFailure(kind="turn_timeout") if mode == "failed" else None
    succeeded = mode == "succeeded"
    return GenerationTerminal(
        status=mode,
        failure=failure,
        final_text=response_text if succeeded else "",
        structured_output=None,
        session_ref=(
            GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id=f"thread-{command.request_id}",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            )
            if succeeded
            else None
        ),
        usage=GenerationUsage(
            input_tokens=40,
            output_tokens=4,
            total_tokens=44,
            reasoning_tokens=1,
        ),
        diagnostics=() if succeeded else ("controlled terminal after partial output",),
        accepted_at=_ACCEPTED_AT,
        sdk_version=_SDK_VERSION,
        runtime_version=_RUNTIME_VERSION,
    )


def _run_generation_peer(
    socket_path: str,
    audit_path: str,
    mode: TerminalMode,
    ready: Connection,
    request_observed: Any,
    release_response: Any,
    response_text: str,
) -> None:
    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            request_line = self.rfile.readline()
            headers: dict[str, str] = {}
            while True:
                line = self.rfile.readline()
                if line in {b"\r\n", b"\n", b""}:
                    break
                try:
                    name, value = line.decode("ascii").split(":", 1)
                except (UnicodeDecodeError, ValueError):
                    self._respond(b"400 Bad Request", b"application/json", b"{}")
                    return
                headers[name.casefold()] = value.strip()
            content_length = int(headers.get("content-length", "0"))
            if content_length > MAX_COMMAND_BODY_BYTES:
                self._respond(b"413 Payload Too Large", b"application/json", b"{}")
                return
            body = self.rfile.read(content_length)

            if request_line == b"GET /health HTTP/1.1\r\n":
                health = GenerationHealth(
                    policy_revision=generation_policy.POLICY_REVISION,
                    sdk_version=_SDK_VERSION,
                    runtime_version=_RUNTIME_VERSION,
                )
                self._respond(
                    b"200 OK",
                    b"application/json",
                    health.model_dump_json().encode("utf-8"),
                )
                return

            if request_line.startswith(b"POST /v2/generations/") and request_line.endswith(
                b"/cancel HTTP/1.1\r\n"
            ):
                self._respond(b"204 No Content", b"application/json", b"")
                return

            if (
                request_line != b"POST /v2/generations HTTP/1.1\r\n"
                or headers.get("content-type") != "application/json"
            ):
                self._respond(b"400 Bad Request", b"application/json", b"{}")
                return
            command = GenerationCommand.model_validate_json(body)
            if command.operation.kind != "chat":
                self._respond(b"400 Bad Request", b"application/json", b"{}")
                return
            with Path(audit_path).open("a", encoding="utf-8") as audit:
                audit.write(json.dumps(json.loads(body), sort_keys=True) + "\n")
            request_observed.set()
            if not release_response.wait(30):
                return
            payload = b"".join(
                (
                    _frame(command, 0, GenerationText(text=response_text)),
                    _frame(command, 1, _terminal(command, mode, response_text=response_text)),
                )
            )
            self._respond(b"200 OK", b"application/x-ndjson", payload)

        def _respond(self, status: bytes, content_type: bytes, payload: bytes) -> None:
            self.wfile.write(
                b"HTTP/1.1 "
                + status
                + b"\r\nContent-Type: "
                + content_type
                + b"\r\n"
                + f"Content-Length: {len(payload)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + payload
            )
            self.wfile.flush()

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        allow_reuse_address = False
        daemon_threads = True

    target = Path(socket_path)
    os.chdir(target.parent)
    with Server(target.name, Handler) as server:
        ready.send("ready")
        server.serve_forever(poll_interval=0.01)


@contextmanager
def _generation_peer(
    mode: TerminalMode,
    *,
    gated: bool = False,
    response_text: str = _PARTIAL_TEXT,
) -> Iterator[_GenerationPeer]:
    token = uuid4().hex
    socket_path = Path("/tmp") / f"nexus-chat-{token}.sock"
    audit_path = Path("/tmp") / f"nexus-chat-{token}.jsonl"
    parent, child = multiprocessing.Pipe(duplex=False)
    process_context = multiprocessing.get_context("fork")
    request_observed = process_context.Event()
    release_response = process_context.Event()
    if not gated:
        release_response.set()
    process = process_context.Process(
        target=_run_generation_peer,
        args=(
            str(socket_path),
            str(audit_path),
            mode,
            child,
            request_observed,
            release_response,
            response_text,
        ),
    )
    process.start()
    child.close()
    try:
        assert parent.poll(5) and parent.recv() == "ready"
        yield _GenerationPeer(
            socket_path,
            audit_path,
            process,
            request_observed,
            release_response,
        )
    finally:
        release_response.set()
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(5)
        socket_path.unlink(missing_ok=True)
        audit_path.unlink(missing_ok=True)


def _audit_requests(peer: _GenerationPeer) -> list[dict[str, Any]]:
    if not peer.audit_path.exists():
        return []
    return [json.loads(line) for line in peer.audit_path.read_text().splitlines()]


def test_prepared_chat_capacity_replay_enters_runtime_without_a_caller_transaction(
    engine: Engine,
) -> None:
    """Risk: a Prepared Chat replay carries its implicit read transaction into UDS I/O."""

    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            chat = create_entitled_chat(db, content="Retry this exact prepared Chat turn.")
            context = claim_chat_tool_job(
                db,
                job_id=chat.job_id,
                worker_id="prepared-chat-transaction-boundary",
            )
            db.commit()
            job = get_job(db, chat.job_id)
            assert job is not None
            db.commit()
            runtime = _CapacityThenSuccessfulChatRuntime(db)

            first = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=runtime,
                    settings=get_settings(),
                )
            )
            assert isinstance(first, RescheduleRequested)

            replay_job = get_job(db, chat.job_id)
            assert replay_job is not None
            assert replay_job.payload["capacity_wait_index"] == 1
            db.commit()
            replay = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=replay_job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=runtime,
                    settings=get_settings(),
                )
            )

            assert isinstance(replay, PublishedChatExecution)
            assert len(runtime.commands) == 2
            assert runtime.commands[1].request_id == runtime.commands[0].request_id
            assert runtime.commands[1].intent == runtime.commands[0].intent
            assert runtime.transaction_entrypoints == [
                "health",
                "stream",
                "health",
                "stream",
            ]
    finally:
        set_rate_limiter(previous_limiter)


@pytest.mark.parametrize("mode", ["cancelled", "failed"])
def test_partial_text_survives_non_success_terminal_and_reconnect(
    engine: Engine,
    mode: TerminalMode,
) -> None:
    """A host terminal cannot erase already-visible assistant text."""

    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with _generation_peer(mode) as peer, Session(engine, expire_on_commit=False) as db:
            chat = create_entitled_chat(db, content="Give me a short answer.")
            context = claim_chat_tool_job(
                db,
                job_id=chat.job_id,
                worker_id=f"partial-{mode}",
            )
            db.commit()
            job = get_job(db, chat.job_id)
            assert job is not None

            result = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=CodexGenerationClient(peer.socket_path),
                    settings=get_settings(),
                )
            )
            expected_type = CancelledChatExecution if mode == "cancelled" else FailedChatExecution
            assert isinstance(result, expected_type)

            db.expire_all()
            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            message = db.get(Message, run.assistant_message_id)
            assert message is not None
            expected_status = "cancelled" if mode == "cancelled" else "error"
            expected_error = None if mode == "cancelled" else "timeout"
            assert (run.status, run.error_code, message.status, message.content) == (
                expected_status,
                expected_error,
                expected_status,
                _PARTIAL_TEXT,
            )

            events = list(
                db.scalars(
                    select(ChatRunEvent)
                    .where(ChatRunEvent.run_id == run.id)
                    .order_by(ChatRunEvent.seq)
                )
            )
            assert (
                "".join(
                    str(event.payload["text"])
                    for event in events
                    if event.event_type == "assistant_text_delta"
                )
                == _PARTIAL_TEXT
            )
            done = [event for event in events if event.event_type == "done"]
            assert len(done) == 1
            assert (done[0].payload["status"], done[0].payload["last_provider_event_seq"]) == (
                expected_status,
                1,
            )

            response = get_chat_run(db, viewer_id=chat.user_id, run_id=chat.run_id)
            assert (
                response.stream_state.assistant_current_text,
                response.stream_state.terminal,
                response.stream_state.reconnectable,
                response.stream_state.folded_event_seq,
                response.stream_state.last_event_seq,
            ) == (_PARTIAL_TEXT, True, False, done[0].seq, done[0].seq)

            terminal_job = get_job(db, chat.job_id)
            assert terminal_job is not None
            replay = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=terminal_job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=CodexGenerationClient(peer.socket_path),
                    settings=get_settings(),
                )
            )
            assert replay == SkippedChatExecution(reason="Terminal")
            assert len(_audit_requests(peer)) == 1
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatRunEvent)
                    .where(ChatRunEvent.run_id == run.id, ChatRunEvent.event_type == "done")
                )
                == 1
            )
    finally:
        set_rate_limiter(previous_limiter)


def test_cancel_after_host_acceptance_prevents_publication(engine: Engine) -> None:
    """A committed user cancel wins after host acceptance and before publication."""

    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with _generation_peer("succeeded", gated=True) as peer:
            with Session(engine) as setup_db:
                chat = create_entitled_chat(setup_db, content="Answer, unless I cancel.")
                context = claim_chat_tool_job(
                    setup_db,
                    job_id=chat.job_id,
                    worker_id="accepted-cancel",
                )
                setup_db.commit()

            def execute() -> object:
                # Production sessions retain ORM identities across commits. The
                # authoritative publication lock must refresh that cached run
                # after a concurrent Cancel commit.
                with Session(engine, expire_on_commit=False) as worker_db:
                    job = get_job(worker_db, chat.job_id)
                    assert job is not None
                    return asyncio.run(
                        execute_chat_run(
                            worker_db,
                            run_id=chat.run_id,
                            job=job,
                            execution_context=context,
                            session_factory=session_factory,
                            runtime=CodexGenerationClient(peer.socket_path),
                            settings=get_settings(),
                        )
                    )

            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(execute)
                assert peer.request_observed.wait(10), "Chat never crossed the host boundary"
                with Session(engine) as cancel_db:
                    cancelled = cancel_chat_run(
                        cancel_db,
                        viewer_id=chat.user_id,
                        run_id=chat.run_id,
                    )
                    assert cancelled.run.cancel_requested_at is not None
                peer.release_response.set()
                outcome = future.result(timeout=20)

            assert isinstance(outcome, CancelledChatExecution)
            with Session(engine) as oracle:
                run = oracle.get(ChatRun, chat.run_id)
                assert run is not None
                message = oracle.get(Message, run.assistant_message_id)
                assert message is not None
                events = list(
                    oracle.scalars(
                        select(ChatRunEvent)
                        .where(ChatRunEvent.run_id == run.id)
                        .order_by(ChatRunEvent.seq)
                    )
                )
                assert (run.status, message.status) == ("cancelled", "cancelled")
                assert [event.event_type for event in events].count("done") == 1
                assert all(event.event_type != "citation_index" for event in events)
                assert (
                    next(event for event in events if event.event_type == "done").payload["status"]
                    == "cancelled"
                )
                generation = oracle.scalar(select(LLMCall).where(LLMCall.owner_id == run.id))
                assert generation is not None
                assert (generation.outcome, generation.error_code) == ("Cancelled", None)
            assert len(_audit_requests(peer)) == 1
    finally:
        set_rate_limiter(previous_limiter)


def test_legal_multibyte_host_frame_is_split_inside_durable_sse_bounds(
    engine: Engine,
) -> None:
    """One legal host frame cannot escape the browser-facing text cadence."""

    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with (
            _generation_peer("succeeded", response_text=_LARGE_MULTIBYTE_TEXT) as peer,
            Session(engine, expire_on_commit=False) as db,
        ):
            chat = create_entitled_chat(db, content="Return one long multibyte answer.")
            context = claim_chat_tool_job(
                db,
                job_id=chat.job_id,
                worker_id="bounded-text-frame",
            )
            db.commit()
            job = get_job(db, chat.job_id)
            assert job is not None

            result = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=chat.run_id,
                    job=job,
                    execution_context=context,
                    session_factory=session_factory,
                    runtime=CodexGenerationClient(peer.socket_path),
                    settings=get_settings(),
                )
            )
            assert isinstance(result, PublishedChatExecution)

            db.expire_all()
            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            message = db.get(Message, run.assistant_message_id)
            assert message is not None
            deltas = [
                event
                for event in db.scalars(
                    select(ChatRunEvent)
                    .where(ChatRunEvent.run_id == run.id)
                    .order_by(ChatRunEvent.seq)
                )
                if event.event_type == "assistant_text_delta"
            ]
            assert len(deltas) > 1
            assert all(
                len(str(event.payload["text"])) <= 512
                and len(str(event.payload["text"]).encode("utf-8")) <= 2_048
                for event in deltas
            )
            assert all(
                (
                    event.payload["provider_event_seq_start"],
                    event.payload["provider_event_seq_end"],
                )
                == (0, 0)
                for event in deltas
            )
            assert "".join(str(event.payload["text"]) for event in deltas) == message.content
            assert message.content == _LARGE_MULTIBYTE_TEXT
            response = get_chat_run(db, viewer_id=chat.user_id, run_id=chat.run_id)
            assert response.stream_state.assistant_current_text == _LARGE_MULTIBYTE_TEXT
            assert response.stream_state.terminal is True
            assert len(_audit_requests(peer)) == 1
    finally:
        set_rate_limiter(previous_limiter)


def test_stream_event_locks_run_before_job_lease(engine: Engine) -> None:
    """Streaming and MCP admission share the global run-to-job lock order."""

    with Session(engine, expire_on_commit=False) as db:
        chat = create_entitled_chat(db, content="Prove the Chat lock order.")
        context = claim_chat_tool_job(
            db,
            job_id=chat.job_id,
            worker_id="stream-lock-order",
        )
        db.commit()
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        run_lock_observed: list[bool] = []

        def fence() -> None:
            with Session(engine) as oracle:
                try:
                    oracle.execute(
                        select(ChatRun).where(ChatRun.id == run.id).with_for_update(nowait=True)
                    ).scalar_one()
                except OperationalError as error:
                    assert getattr(error.orig, "sqlstate", None) == "55P03"
                    run_lock_observed.append(True)
                    oracle.rollback()
                else:
                    oracle.rollback()
                    raise AssertionError("stream lease fence ran before acquiring the Chat run")
            assert lock_running_job_claim(db, context=context)

        ChatRunEventEmitter(db, run, lease_fence=fence).assistant_activity(
            phase="thinking",
            provider_event_seq_start=0,
            provider_event_seq_end=0,
        )
        assert run_lock_observed == [True]
        event = db.scalar(
            select(ChatRunEvent).where(
                ChatRunEvent.run_id == run.id,
                ChatRunEvent.event_type == "assistant_activity",
            )
        )
        assert event is not None and event.payload["phase"] == "thinking"
