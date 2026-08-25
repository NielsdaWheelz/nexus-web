"""Dawn Write proof for a non-metadata durable generation owner."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
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
    claim_job,
    complete_job,
    enqueue_job,
    get_job,
)
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationUsage,
)
from nexus.services.dawn_write import generate_dawn_write
from nexus.services.durable_step_journal import Completed, read_step_states
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter

_LOCAL_DATE = date(2026, 8, 24)


class _SuccessfulDawnRuntime:
    def __init__(self) -> None:
        self.commands: list[GenerationCommand] = []

    async def health(self) -> GenerationHealth:
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        )

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        self.commands.append(command)

        async def frames() -> AsyncIterator[GenerationFrame]:
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
    runtime = _SuccessfulDawnRuntime()
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
                payload={"capacity_wait_index": 0},
                max_attempts=2,
            )
            db.commit()
            claimed = claim_job(
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
            assert isinstance(first, DawnWrite)
            assert first.id == runtime.commands[0].request_id
            assert runtime.commands[0].operation.kind == "dawn_write"

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
            assert len(runtime.commands) == 1
            assert db.scalar(select(LLMCall).where(LLMCall.id == first.id)) is ledger
            assert db.scalar(
                select(DawnWrite).where(
                    DawnWrite.user_id == user_id,
                    DawnWrite.local_date == _LOCAL_DATE,
                )
            ).id == first.id

            assert complete_job(db, job_id=job.id, worker_id=worker_id)
            db.commit()
    finally:
        set_rate_limiter(previous_limiter)
        clear_settings_cache()
