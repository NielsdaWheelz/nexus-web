"""Media Intelligence proofs for owner-side preaccept cancellation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    ContentChunk,
    ContentIndexState,
    EvidenceSpan,
    Media,
    MediaSummary,
    ProcessingStatus,
)
from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    claim_job,
    find_nonterminal_jobs_for_payload,
    get_job,
)
from nexus.schemas.presence import Present
from nexus.services import generation_policy
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    read_step_states,
    stable_generation_id,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_ledger import read_generation
from nexus.services.media_intelligence import ensure_media_unit, run_media_unit_build
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter


@dataclass(frozen=True, slots=True)
class _SeededBuild:
    media_id: UUID
    summary_id: UUID
    generation_id: UUID
    job: JobRow
    context: JobExecutionContext
    content_fingerprint: str


class _CapacityRuntime(ExecutionRuntime):
    def __init__(self) -> None:
        self.dispatches = 0

    async def health(self) -> GenerationHealth:
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        )

    async def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        self.dispatches += 1
        raise CodexGenerationCapacityUnavailable("test host is at capacity")
        if False:
            yield

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("preaccept capacity refusal cannot be cancelled")


class _NoDispatchRuntime(ExecutionRuntime):
    async def health(self) -> GenerationHealth:
        raise AssertionError("owner cancellation must precede host health and dispatch")

    async def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        raise AssertionError("owner cancellation must not dispatch")
        if False:
            yield

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("owner cancellation has no accepted turn to cancel")


class _AbortAtOwnerFenceRuntime(ExecutionRuntime):
    def __init__(self, engine: Engine, summary_id: UUID) -> None:
        self._engine = engine
        self._summary_id = summary_id
        self.dispatches = 0

    async def health(self) -> GenerationHealth:
        with Session(self._engine) as db:
            summary = db.get(MediaSummary, self._summary_id)
            assert summary is not None
            summary.status = "ready"
            db.commit()
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        )

    async def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        self.dispatches += 1
        raise AssertionError("an invalidated owner fence must prevent dispatch")
        if False:
            yield

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("an aborted dispatch has no accepted turn to cancel")


def _seed_build(engine: Engine) -> _SeededBuild:
    user_id = uuid4()
    media_id = uuid4()
    source_text = "A grounded passage retained across a capacity refusal."
    with Session(engine, expire_on_commit=False) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"media-preaccept-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind="web_article",
                title="Media preaccept cancellation proof",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        block = ContentBlock(
            owner_kind="media",
            owner_id=media_id,
            block_idx=0,
            block_kind="paragraph",
            canonical_text=source_text,
            extraction_confidence=1.0,
            source_start_offset=0,
            source_end_offset=len(source_text),
            heading_path=[],
            locator={},
            selector={},
            metadata_json={},
        )
        db.add(block)
        db.flush()
        evidence = EvidenceSpan(
            owner_kind="media",
            owner_id=media_id,
            start_block_id=block.id,
            end_block_id=block.id,
            start_block_offset=0,
            end_block_offset=len(source_text),
            span_text=source_text,
            selector={},
            citation_label="Media preaccept passage",
            resolver_kind="web",
        )
        db.add(evidence)
        db.flush()
        db.add(
            ContentChunk(
                owner_kind="media",
                owner_id=media_id,
                primary_evidence_span_id=evidence.id,
                chunk_idx=0,
                source_kind="web_article",
                chunk_text=source_text,
                token_count=9,
                heading_path=[],
                summary_locator={},
            )
        )
        db.add(
            ContentIndexState(
                owner_kind="media",
                owner_id=media_id,
                revision=1,
                status="ready",
                active_embedding_provider="test",
                active_embedding_model="test",
            )
        )
        db.commit()

        unit = ensure_media_unit(db, media_id=media_id)
        jobs = find_nonterminal_jobs_for_payload(
            db,
            kind="media_unit_build",
            expected_payload_match={
                "media_id": str(media_id),
                "content_fingerprint": unit.content_fingerprint,
            },
        )
        assert len(jobs) == 1
        claimed = claim_job(
            db,
            job_id=jobs[0].id,
            worker_id=f"media-preaccept-{media_id}",
            lease_seconds=450,
            heavy_kinds=(),
        )
        assert claimed is not None
        db.commit()
        generation_id = stable_generation_id(
            media_id,
            f"{unit.content_fingerprint}:synthesis",
        )
        return _SeededBuild(
            media_id=media_id,
            summary_id=unit.summary_id,
            generation_id=generation_id,
            job=claimed,
            context=JobExecutionContext(
                job_id=claimed.id,
                worker_id=f"media-preaccept-{media_id}",
                attempt_no=claimed.attempts,
                resource_class="Light",
            ),
            content_fingerprint=unit.content_fingerprint,
        )


def _restore_prepared(engine: Engine, seeded: _SeededBuild) -> None:
    capacity = _CapacityRuntime()
    with Session(engine) as db:
        result = asyncio.run(
            run_media_unit_build(
                db,
                media_id=seeded.media_id,
                content_fingerprint=seeded.content_fingerprint,
                ctx=seeded.context,
                runtime=capacity,
            )
        )
        assert isinstance(result, RescheduleRequested)
    assert capacity.dispatches == 1
    with Session(engine) as db:
        job = get_job(db, seeded.job.id)
        record = read_generation(db, generation_id=seeded.generation_id)
        assert job is not None
        assert read_step_states(job)["synthesis"].dispatch_phase is Prepared
        assert record is not None and record.outcome is None


def _mutate_owner_precondition(
    db: Session,
    *,
    seeded: _SeededBuild,
    case: str,
) -> None:
    match case:
        case "summary_missing":
            summary = db.get(MediaSummary, seeded.summary_id)
            assert summary is not None
            db.delete(summary)
        case "summary_superseded":
            summary = db.get(MediaSummary, seeded.summary_id)
            assert summary is not None
            summary.content_fingerprint = "f" * 64
        case "content_fingerprint_changed":
            chunk = db.scalar(
                select(ContentChunk).where(
                    ContentChunk.owner_kind == "media",
                    ContentChunk.owner_id == seeded.media_id,
                )
            )
            assert chunk is not None
            chunk.chunk_text = "changed content"
        case "summary_not_building":
            summary = db.get(MediaSummary, seeded.summary_id)
            assert summary is not None
            summary.status = "ready"
        case "no_owner":
            media = db.get(Media, seeded.media_id)
            assert media is not None
            media.created_by_user_id = None
        case "no_candidates":
            chunk = db.scalar(
                select(ContentChunk).where(
                    ContentChunk.owner_kind == "media",
                    ContentChunk.owner_id == seeded.media_id,
                )
            )
            assert chunk is not None
            chunk.primary_evidence_span_id = None
        case "request_fingerprint_changed":
            evidence = db.scalar(
                select(EvidenceSpan).where(
                    EvidenceSpan.owner_kind == "media",
                    EvidenceSpan.owner_id == seeded.media_id,
                )
            )
            assert evidence is not None
            evidence.span_text = "changed offered evidence"
        case "inflight_rejected":
            pass
        case _:
            raise AssertionError(f"unknown media cancellation case {case}")
    db.commit()


@pytest.mark.parametrize(
    ("case", "expected_result", "expected_memo_outcome"),
    [
        ("summary_missing", "ok", "skip"),
        ("summary_superseded", "ok", "skip"),
        ("content_fingerprint_changed", "ok", "skip"),
        ("summary_not_building", "ok", "skip"),
        ("no_owner", "failed", "failure"),
        ("no_candidates", "failed", "failure"),
        ("request_fingerprint_changed", "ok", "skip"),
        ("inflight_rejected", "failed", "failure"),
    ],
)
def test_prepared_media_owner_exit_cancels_retained_start_without_dispatch(
    engine: Engine,
    case: str,
    expected_result: Literal["ok", "failed"],
    expected_memo_outcome: Literal["skip", "failure"],
) -> None:
    """Risk: a capacity-restored media start remains open after an owner exit."""

    seeded = _seed_build(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(engine)))
    try:
        _restore_prepared(engine, seeded)
        with Session(engine) as db:
            _mutate_owner_precondition(db, seeded=seeded, case=case)
        if case == "inflight_rejected":
            set_rate_limiter(RateLimiter())

        with Session(engine) as db:
            result = asyncio.run(
                run_media_unit_build(
                    db,
                    media_id=seeded.media_id,
                    content_fingerprint=seeded.content_fingerprint,
                    ctx=seeded.context,
                    runtime=_NoDispatchRuntime(),
                )
            )
        assert result == expected_result

        with Session(engine) as db:
            job = get_job(db, seeded.job.id)
            record = read_generation(db, generation_id=seeded.generation_id)
            assert job is not None
            completed = read_step_states(job)["synthesis"]
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert record is not None
            assert (
                record.outcome,
                record.error_code,
                record.session_ref,
                record.accepted_at,
                record.sdk_version,
                record.runtime_version,
            ) == ("Cancelled", None, None, None, None, None)
            assert record.completed_at is not None
            assert json.loads(completed.terminal_result.value)["outcome"] == expected_memo_outcome
    finally:
        set_rate_limiter(previous_limiter)


def test_prepared_media_dispatch_abort_cancels_without_fabricating_host_terminal(
    engine: Engine,
) -> None:
    """Risk: an owner-fence abort strands the retained preaccept ledger start."""

    seeded = _seed_build(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(engine)))
    try:
        _restore_prepared(engine, seeded)
        runtime = _AbortAtOwnerFenceRuntime(engine, seeded.summary_id)
        with Session(engine) as db:
            result = asyncio.run(
                run_media_unit_build(
                    db,
                    media_id=seeded.media_id,
                    content_fingerprint=seeded.content_fingerprint,
                    ctx=seeded.context,
                    runtime=runtime,
                )
            )
        assert result == "ok"
        assert runtime.dispatches == 0

        with Session(engine) as db:
            job = get_job(db, seeded.job.id)
            record = read_generation(db, generation_id=seeded.generation_id)
            assert job is not None
            completed = read_step_states(job)["synthesis"]
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert json.loads(completed.terminal_result.value) == {
                "outcome": "skip",
                "reason": "dispatch_aborted",
            }
            assert record is not None
            assert record.outcome == "Cancelled"
            assert record.accepted_at is None
            assert record.session_ref is None
    finally:
        set_rate_limiter(previous_limiter)
