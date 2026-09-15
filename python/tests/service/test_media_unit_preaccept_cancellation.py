"""Media Intelligence proofs for owner-side preaccept cancellation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
from importlib.util import find_spec
from typing import TYPE_CHECKING, Literal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

_CUTOVER_PRESENT = find_spec("nexus.services.codex_generation_contract") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.db.models import (
        ContentBlock,
        ContentChunk,
        ContentIndexState,
        EvidenceSpan,
        Media,
        MediaSummary,
        ProcessingStatus,
    )
    from nexus.jobs.queue import (
        JobExecutionContext,
        JobRow,
        RescheduleRequested,
        find_nonterminal_jobs_for_payload,
        get_job,
    )
    from nexus.schemas.presence import Present
    from nexus.services.bootstrap import ensure_user_and_default_library
    from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable
    from nexus.services.codex_generation_contract import (
        GenerationAdmission,
        GenerationCommand,
        GenerationCommandDraft,
        GenerationFrame,
    )
    from nexus.services.durable_step_journal import (
        Completed,
        Prepared,
        read_step_states,
        stable_generation_id,
    )
    from nexus.services.llm_ledger import read_generation
    from nexus.services.media_intelligence import ensure_media_unit, run_media_unit_build
    from nexus.services.tool_runtime.composition import compose_product_tool_runtime
    from tests.testkit.codex_generation import (
        bind_test_codex_admission,
        compose_codex_execution_runtime,
    )
    from tests.testkit.queue_claims import claim_job_row


def _require_cutover() -> None:
    assert _CUTOVER_PRESENT, "the durable Codex generation owner is absent"


@dataclass(frozen=True, slots=True)
class _SeededBuild:
    media_id: UUID
    summary_id: UUID
    generation_id: UUID
    job: JobRow
    context: JobExecutionContext
    content_fingerprint: str


class _CapacityTransport:
    def __init__(self) -> None:
        self.dispatches = 0

    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]],
    ) -> AsyncGenerator[GenerationFrame]:
        _ = draft, bind_admission

        async def frames() -> AsyncGenerator[GenerationFrame]:
            self.dispatches += 1
            raise CodexGenerationCapacityUnavailable("test host is at capacity")
            yield GenerationFrame.model_construct()

        return frames()

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("preaccept capacity refusal cannot be cancelled")


class _NoDispatchTransport:
    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]],
    ) -> AsyncGenerator[GenerationFrame]:
        del draft, bind_admission
        raise AssertionError("owner cancellation must precede host health and dispatch")

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("owner cancellation has no accepted turn to cancel")


class _AbortAtOwnerFenceTransport:
    def __init__(self, engine: Engine, summary_id: UUID) -> None:
        self._engine = engine
        self._summary_id = summary_id
        self.dispatches = 0

    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]],
    ) -> AsyncGenerator[GenerationFrame]:
        with Session(self._engine) as db:
            summary = db.get(MediaSummary, self._summary_id)
            assert summary is not None
            summary.status = "ready"
            db.commit()

        async def frames() -> AsyncGenerator[GenerationFrame]:
            await bind_test_codex_admission(draft, bind_admission)
            self.dispatches += 1
            raise AssertionError("an invalidated owner fence must prevent dispatch")
            yield GenerationFrame.model_construct()

        return frames()

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
        claimed = claim_job_row(
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
                execution_id=claimed.execution_id,
            ),
            content_fingerprint=unit.content_fingerprint,
        )


def _restore_prepared(engine: Engine, seeded: _SeededBuild) -> None:
    capacity = _CapacityTransport()
    with Session(engine) as db:
        result = asyncio.run(
            run_media_unit_build(
                db,
                media_id=seeded.media_id,
                content_fingerprint=seeded.content_fingerprint,
                ctx=seeded.context,
                runtime=compose_codex_execution_runtime(
                    capacity,
                    tools=compose_product_tool_runtime(None),
                ),
            )
        )
        assert isinstance(result, RescheduleRequested)
    assert capacity.dispatches == 1
    with Session(engine) as db:
        job = get_job(db, seeded.job.id)
        record = read_generation(db, generation_id=seeded.generation_id)
        assert job is not None
        assert read_step_states(job)["synthesis"].dispatch_phase is Prepared
        assert record is None


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
    ],
)
def test_prepared_media_owner_exit_closes_without_dispatch_or_ledger(
    engine: Engine,
    case: str,
    expected_result: Literal["ok", "failed"],
    expected_memo_outcome: Literal["skip", "failure"],
) -> None:
    """Risk: a capacity-restored admission fabricates model-call evidence."""

    _require_cutover()
    seeded = _seed_build(engine)
    _restore_prepared(engine, seeded)
    with Session(engine) as db:
        _mutate_owner_precondition(db, seeded=seeded, case=case)

    with Session(engine) as db:
        result = asyncio.run(
            run_media_unit_build(
                db,
                media_id=seeded.media_id,
                content_fingerprint=seeded.content_fingerprint,
                ctx=seeded.context,
                runtime=compose_codex_execution_runtime(
                    _NoDispatchTransport(),
                    tools=compose_product_tool_runtime(None),
                ),
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
        assert record is None
        assert json.loads(completed.terminal_result.value)["outcome"] == expected_memo_outcome


def test_prepared_media_dispatch_abort_closes_without_fabricating_a_ledger(
    engine: Engine,
) -> None:
    """Risk: an owner-fence abort fabricates an accepted model call."""

    _require_cutover()
    seeded = _seed_build(engine)
    _restore_prepared(engine, seeded)
    transport = _AbortAtOwnerFenceTransport(engine, seeded.summary_id)
    with Session(engine) as db:
        result = asyncio.run(
            run_media_unit_build(
                db,
                media_id=seeded.media_id,
                content_fingerprint=seeded.content_fingerprint,
                ctx=seeded.context,
                runtime=compose_codex_execution_runtime(
                    transport,
                    tools=compose_product_tool_runtime(None),
                ),
            )
        )
    assert result == "ok"
    assert transport.dispatches == 0

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
        assert record is None
