"""Dawn Write proof for a non-metadata durable generation owner."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import DawnWrite, Highlight, LLMCall, Media, MediaKind
from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    complete_job,
    enqueue_job,
    get_job,
)
from nexus.schemas.presence import Present
from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable
from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationCommand,
    GenerationCommandDraft,
    GenerationFrame,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationUsage,
)
from nexus.services.dawn_write import generate_dawn_write
from nexus.services.durable_step_journal import Completed, Prepared, read_step_states
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.tool_runtime.composition import compose_product_tool_runtime
from tests.testkit.codex_generation import (
    bind_test_codex_admission,
    compose_codex_execution_runtime,
)
from tests.testkit.queue_claims import claim_job_row

_LOCAL_DATE = date(2026, 8, 24)


class _SuccessfulDawnTransport:
    def __init__(self, caller_db: Session) -> None:
        self.caller_db = caller_db
        self.commands: list[GenerationCommand] = []
        self.transaction_entrypoints: list[str] = []

    def _observe_entry(self, entrypoint: str) -> None:
        assert not self.caller_db.in_transaction(), (
            f"Dawn caller transaction crossed the generation {entrypoint} boundary"
        )
        self.transaction_entrypoints.append(entrypoint)

    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]],
    ) -> AsyncIterator[GenerationFrame]:
        self._observe_entry("health")
        self._observe_entry("stream")

        async def frames() -> AsyncIterator[GenerationFrame]:
            command = await bind_test_codex_admission(draft, bind_admission)
            self.commands.append(command)
            yield GenerationFrame(
                request_id=command.request_id,
                sequence=0,
                event=GenerationTerminal(
                    status="succeeded",
                    failure=None,
                    final_text=(
                        "A durable passage stayed with the reader through yesterday.\n\n"
                        "The apparatus found one grounded overnight connection."
                    ),
                    structured_output=None,
                    session_ref=GenerationSessionRef(
                        schema_version="agent-session-ref.v1",
                        backend="codex",
                        transport="sdk",
                        native_session_id=f"thread-{command.request_id}",
                        profile_key="codex-personal",
                        state_root_fingerprint="1" * 64,
                        cwd_fingerprint="2" * 64,
                    ),
                    usage=GenerationUsage(
                        input_tokens=80,
                        output_tokens=20,
                        total_tokens=100,
                    ),
                    diagnostics=(),
                    accepted_at="2026-08-24T12:34:56.123456Z",
                    sdk_version="0.144.4",
                    runtime_version="0.144.4",
                ),
            )

        return frames()

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unexpected Dawn cancellation for {request_id}")


class _CapacityDawnTransport:
    def __init__(self) -> None:
        self.dispatches = 0

    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]],
    ) -> AsyncIterator[GenerationFrame]:
        _ = draft, bind_admission

        async def frames() -> AsyncIterator[GenerationFrame]:
            self.dispatches += 1
            raise CodexGenerationCapacityUnavailable("host capacity is occupied")
            yield GenerationFrame.model_construct()

        return frames()

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unexpected Dawn cancellation for {request_id}")


def test_dawn_write_terminal_journal_publishes_once_and_replays_without_dispatch(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DAWN_WRITE_ENABLED", "true")
    clear_settings_cache()
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    worker_id = f"dawn-proof-{uuid4()}"
    user_id = uuid4()
    media_id = uuid4()
    highlight_id = uuid4()
    try:
        from nexus.services.bootstrap import ensure_user_and_default_library

        with Session(engine, expire_on_commit=False) as db:
            ensure_user_and_default_library(
                db,
                user_id,
                f"dawn-proof-{user_id}@example.invalid",
            )
            db.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="A durable source",
                    created_by_user_id=user_id,
                )
            )
            db.flush()
            db.add(
                Highlight(
                    id=highlight_id,
                    user_id=user_id,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=media_id,
                    color="yellow",
                    exact="A durable passage",
                    prefix="",
                    suffix="",
                    created_at=datetime(2026, 8, 23, 12, tzinfo=UTC),
                )
            )
            job = enqueue_job(
                db,
                kind="dawn_write_job",
                payload={"proof": "dawn-write-journal"},
                max_attempts=2,
            )
            db.commit()
            claimed = claim_job_row(
                db,
                job_id=job.id,
                worker_id=worker_id,
                lease_seconds=900,
                heavy_kinds=(),
                allowed_kinds=("dawn_write_job",),
            )
            assert claimed is not None
            context = JobExecutionContext(
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Light",
                execution_id=claimed.execution_id,
            )
            db.commit()
            transport = _SuccessfulDawnTransport(db)
            runtime = compose_codex_execution_runtime(
                transport,
                tools=compose_product_tool_runtime(None),
            )

            first = asyncio.run(
                generate_dawn_write(
                    db,
                    user_id=user_id,
                    local_date=_LOCAL_DATE,
                    tz="UTC",
                    context=context,
                    runtime=runtime,
                )
            )
            assert isinstance(first, DawnWrite)
            assert first.id == transport.commands[0].request_id
            assert transport.commands[0].spec.operation == "dawn_write"
            assert transport.transaction_entrypoints == ["health", "stream"]

            persisted_job = get_job(db, job.id)
            assert persisted_job is not None
            states = read_step_states(persisted_job)
            matching_states = [
                state for state in states.values() if state.generation_id == first.id
            ]
            assert len(matching_states) == 1
            assert matching_states[0].dispatch_phase is Completed
            ledger = db.scalars(select(LLMCall).where(LLMCall.id == first.id)).one()
            assert (ledger.owner_kind, ledger.owner_id, ledger.outcome) == (
                "dawn_write",
                first.id,
                "Succeeded",
            )

            replay = asyncio.run(
                generate_dawn_write(
                    db,
                    user_id=user_id,
                    local_date=_LOCAL_DATE,
                    tz="UTC",
                    context=context,
                    runtime=runtime,
                )
            )
            assert isinstance(replay, DawnWrite)
            assert replay.id == first.id
            assert len(transport.commands) == 1
            assert db.scalar(select(LLMCall).where(LLMCall.id == first.id)) is ledger
            assert (
                db.scalar(
                    select(DawnWrite).where(
                        DawnWrite.user_id == user_id,
                        DawnWrite.local_date == _LOCAL_DATE,
                    )
                ).id
                == first.id
            )

            assert complete_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=context.attempt_no,
            )
            db.commit()
    finally:
        set_rate_limiter(previous_limiter)
        clear_settings_cache()


def test_dawn_write_no_signals_closes_preaccept_capacity_without_a_ledger(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Risk: a preaccept capacity replay fabricates model-call evidence."""

    monkeypatch.setenv("DAWN_WRITE_ENABLED", "true")
    clear_settings_cache()
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    user_id = uuid4()
    media_id = uuid4()
    highlight_id = uuid4()
    worker_id = f"dawn-cancellation-{uuid4()}"
    transport = _CapacityDawnTransport()
    runtime = compose_codex_execution_runtime(
        transport,
        tools=compose_product_tool_runtime(None),
    )
    try:
        from nexus.services.bootstrap import ensure_user_and_default_library

        with Session(engine, expire_on_commit=False) as db:
            ensure_user_and_default_library(
                db,
                user_id,
                f"dawn-cancellation-{user_id}@example.invalid",
            )
            db.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="A transient Dawn source",
                    created_by_user_id=user_id,
                )
            )
            db.flush()
            db.add(
                Highlight(
                    id=highlight_id,
                    user_id=user_id,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=media_id,
                    color="yellow",
                    exact="A signal that disappears before retry",
                    prefix="",
                    suffix="",
                    created_at=datetime(2026, 8, 23, 12, tzinfo=UTC),
                )
            )
            job = enqueue_job(
                db,
                kind="dawn_write_job",
                payload={"proof": "dawn-write-journal"},
                max_attempts=2,
            )
            db.commit()
            claimed = claim_job_row(
                db,
                job_id=job.id,
                worker_id=worker_id,
                lease_seconds=900,
                heavy_kinds=(),
                allowed_kinds=("dawn_write_job",),
            )
            assert claimed is not None
            context = JobExecutionContext(
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Light",
                execution_id=claimed.execution_id,
            )
            db.commit()

            first = asyncio.run(
                generate_dawn_write(
                    db,
                    user_id=user_id,
                    local_date=_LOCAL_DATE,
                    tz="UTC",
                    context=context,
                    runtime=runtime,
                )
            )
            assert isinstance(first, RescheduleRequested)
            prepared_job = get_job(db, job.id)
            assert prepared_job is not None
            prepared = next(iter(read_step_states(prepared_job).values()))
            assert prepared.dispatch_phase is Prepared
            db.delete(db.get_one(Highlight, highlight_id))
            db.commit()

            result = asyncio.run(
                generate_dawn_write(
                    db,
                    user_id=user_id,
                    local_date=_LOCAL_DATE,
                    tz="UTC",
                    context=context,
                    runtime=runtime,
                )
            )
            persisted_job = get_job(db, job.id)
            assert result is None
            assert transport.dispatches == 1
            assert persisted_job is not None
            completed = next(iter(read_step_states(persisted_job).values()))
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert json.loads(completed.terminal_result.value) == {
                "outcome": "skipped",
                "reason": "no_signals",
            }
            assert db.scalar(select(LLMCall).where(LLMCall.id == completed.generation_id)) is None
    finally:
        set_rate_limiter(previous_limiter)
        clear_settings_cache()
