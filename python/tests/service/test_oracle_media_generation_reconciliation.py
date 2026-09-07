"""Owner proofs for Media Intelligence and Oracle generation repair."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from typing import Never
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    ContentChunk,
    ContentIndexState,
    EvidenceSpan,
    Media,
    ProcessingStatus,
)
from nexus.db.session import create_session_factory
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    claim_job,
    fail_job,
    get_job,
    update_running_job_payload,
)
from nexus.schemas.oracle import oracle_done_payload
from nexus.schemas.presence import Present, absent, present
from nexus.services import media_intelligence as media_intelligence_service
from nexus.services import run_kit
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.codex_generation_contract import (
    GenerationCommandDraft,
    GenerationFrame,
    GenerationSessionRef,
    GenerationTerminal,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ProveNotDispatched,
    StepReplayState,
    Uncertain,
    checkpoint_step_state,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_intent import GenerationIntent, JsonSchemaOutput
from nexus.services.generation_spec import (
    GenerationOperation,
    GenerationSpec,
    GenerationSpecFacts,
    StrictJsonOutputSnapshot,
    generation_fact_digest,
)
from nexus.services.llm_execution import AttachReconciledGenerationTerminal
from nexus.services.llm_ledger import (
    LlmCallOwner,
    read_generation,
    read_model_turns,
)
from nexus.services.media_intelligence import (
    ensure_media_unit,
    reconcile_uncertain_media_unit,
)
from nexus.services.oracle import (
    create_reading,
    execute_reading,
    reconcile_uncertain_oracle_reading,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.codex_generation import (
    codex_generation_draft,
    stage_uncertain_codex_generation,
)
from tests.testkit.unreachable_state import set_pending_job_max_attempts


@dataclass(frozen=True, slots=True)
class _MediaBuild:
    media_id: UUID
    summary_id: UUID
    evidence_span_id: UUID
    content_fingerprint: str
    job: JobRow
    context: JobExecutionContext


class _NeverExecutionRuntime:
    def __init__(self) -> None:
        self.dispatches = 0

    @property
    def continuation_cipher(self) -> Never:
        raise AssertionError("pre-dispatch terminalization reached continuation authority")

    @property
    def admission(self) -> Never:
        raise AssertionError("pre-dispatch terminalization reached generation admission")

    async def execute(self, execution: object) -> Never:
        del execution
        self.dispatches += 1
        raise AssertionError("pre-dispatch terminalization reached backend execution")


def _draft(
    generation_id: UUID,
    *,
    operation: GenerationOperation,
    intent: GenerationIntent | None = None,
) -> GenerationCommandDraft:
    seed = codex_generation_draft(
        request_id=generation_id,
        operation=operation,
        instructions=(intent.instructions if intent is not None else "Return one bounded result."),
        input_text=(intent.input if intent is not None else "operator reconciliation proof"),
        model="gpt-5.6-terra",
        reasoning="high",
        turn_timeout_seconds=180,
        structured_schema=(
            intent.output.schema_
            if intent is not None and isinstance(intent.output, JsonSchemaOutput)
            else None
        ),
    )
    if intent is None:
        return seed
    if not isinstance(intent.output, JsonSchemaOutput):
        raise AssertionError("exact reconciliation fixture expected structured output")
    output_contract = StrictJsonOutputSnapshot(
        name=intent.output.name,
        schema=intent.output.schema_,
    )
    facts: dict[str, object] = {
        name: getattr(seed.spec, name) for name in GenerationSpecFacts.model_fields
    }
    facts.update(
        prompt_payload_ref=seed.spec.prompt_payload_ref.model_copy(
            update={"payload_digest": generation_fact_digest(intent.model_dump(mode="json"))}
        ),
        instructions_digest=hashlib.sha256(intent.instructions.encode()).hexdigest(),
        input_digest=hashlib.sha256(intent.input.encode()).hexdigest(),
        output_contract=output_contract,
        output_contract_fingerprint=generation_fact_digest(
            output_contract.model_dump(mode="json", by_alias=True)
        ),
    )
    return GenerationCommandDraft(
        request_id=generation_id,
        spec=GenerationSpec.freeze(facts),
        intent=intent,
    )


def _claim_exact_job(
    db: Session,
    job_id: UUID,
    *,
    worker_id: str,
) -> tuple[JobRow, JobExecutionContext]:
    set_pending_job_max_attempts(db, job_id=job_id, max_attempts=1)
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=450,
        heavy_kinds=(),
    )
    assert claimed is not None
    return claimed, JobExecutionContext(
        job_id=claimed.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Light",
    )


def _seed_media_build(engine: Engine) -> _MediaBuild:
    user_id = uuid4()
    media_id = uuid4()
    source_text = "A durable passage offered to Media Intelligence."
    with Session(engine, expire_on_commit=False) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"media-reconciliation-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind="web_article",
                title="Media reconciliation proof",
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
            citation_label="Media reconciliation passage",
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
                token_count=8,
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
        job_id = UUID(
            str(
                db.execute(
                    text(
                        "SELECT id FROM background_jobs "
                        "WHERE kind = 'media_unit_build' AND dedupe_key = :dedupe_key"
                    ),
                    {"dedupe_key": (f"media_unit_build:{media_id}:{unit.content_fingerprint}")},
                ).scalar_one()
            )
        )
        job, context = _claim_exact_job(
            db,
            job_id,
            worker_id="media-reconciliation-first",
        )
        db.commit()
        return _MediaBuild(
            media_id=media_id,
            summary_id=unit.summary_id,
            evidence_span_id=evidence.id,
            content_fingerprint=unit.content_fingerprint,
            job=job,
            context=context,
        )


def _media_terminal_frame(generation_id: UUID) -> GenerationFrame:
    return GenerationFrame(
        request_id=generation_id,
        sequence=0,
        event=GenerationTerminal(
            status="succeeded",
            failure=None,
            final_text="",
            structured_output={
                "summary_md": "Recovered media summary.",
                "claims": [
                    {
                        "claim_text": "The passage was durably recovered.",
                        "candidate_index": 0,
                    }
                ],
            },
            session_ref=GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id="thread-reconciled-media-unit",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            ),
            usage=None,
            diagnostics=(),
            accepted_at="2026-08-24T12:34:56.123456Z",
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        ),
    )


def _raw_terminal_attachment(
    frame: GenerationFrame,
    *,
    latency_ms: int,
) -> AttachReconciledGenerationTerminal:
    raw_stream = (frame.model_dump_json() + "\n").encode("utf-8")
    return AttachReconciledGenerationTerminal(
        raw_stream=raw_stream,
        raw_stream_sha256=hashlib.sha256(raw_stream).hexdigest(),
        latency_ms=latency_ms,
    )


def test_media_terminal_attachment_atomically_terminalizes_ledger_and_same_job(
    engine: Engine,
) -> None:
    """Risk: encoded domain output repairs the journal without the billed ledger fact."""

    seeded = _seed_media_build(engine)
    with Session(engine) as db:
        job = get_job(db, seeded.job.id)
        assert job is not None
        candidates = media_intelligence_service._load_candidates(
            db,
            media_id=seeded.media_id,
        )
        intent = media_intelligence_service._media_unit_intent(
            user_content=media_intelligence_service._build_media_unit_user_content(candidates)
        )
        generation_id = stable_generation_id(
            seeded.media_id,
            f"{seeded.content_fingerprint}:synthesis",
        )
        draft = _draft(generation_id, operation="media_summary", intent=intent)
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        )
        payload = payload_with_step_state(
            {
                **job.payload,
                "generation_admissions": {
                    "synthesis": {
                        "spec": draft.spec.model_dump(mode="json", by_alias=True),
                        "intent": draft.intent.model_dump(mode="json", by_alias=True),
                    }
                },
            },
            step_path="synthesis",
            state=uncertain,
        )
        assert update_running_job_payload(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            attempt_no=seeded.context.attempt_no,
            payload=payload,
        )
        stage_uncertain_codex_generation(
            db,
            owner=LlmCallOwner(kind="media_summary", id=seeded.summary_id),
            draft=draft,
        )
        assert (
            fail_job(
                db,
                job_id=seeded.job.id,
                worker_id=seeded.context.worker_id,
                attempt_no=seeded.context.attempt_no,
                error_code="E_RECONCILIATION_REQUIRED",
                error_message="accepted Media Intelligence generation is ambiguous",
                retry_delays_seconds=(0,),
            )
            == "dead"
        )
        db.commit()

        reconcile_uncertain_media_unit(
            db,
            media_id=seeded.media_id,
            content_fingerprint=seeded.content_fingerprint,
            resolution=_raw_terminal_attachment(
                _media_terminal_frame(generation_id),
                latency_ms=1_234,
            ),
        )

        repaired = get_job(db, seeded.job.id)
        record = read_generation(db, generation_id=generation_id)
        turns = read_model_turns(db, generation_id=generation_id)
        assert repaired is not None and repaired.status == "pending"
        assert repaired.id == seeded.job.id
        completed = read_step_states(repaired)["synthesis"]
        assert completed.dispatch_phase is Completed
        assert isinstance(completed.terminal_result, Present)
        assert json.loads(completed.terminal_result.value) == {
            "claims": [
                {
                    "claim_text": "The passage was durably recovered.",
                    "evidence_span_id": str(seeded.evidence_span_id),
                    "ordinal": 0,
                }
            ],
            "outcome": "success",
            "summary_md": "Recovered media summary.",
        }
        assert record is not None
        assert record.owner == LlmCallOwner(kind="media_summary", id=seeded.summary_id)
        assert record.outcome == "Succeeded"
        assert len(turns) == 1
        assert turns[0].accepted_at is not None
        assert turns[0].terminal is not None
        evidence = turns[0].terminal["evidence"]
        assert isinstance(evidence, dict)
        assert evidence["sdk_version"] == "0.144.4"
        ledger_xmin, child_xmin, job_xmin = db.execute(
            text(
                "SELECT "
                "(SELECT xmin::text FROM llm_calls WHERE id = :generation_id), "
                "(SELECT xmin::text FROM llm_model_turns "
                " WHERE generation_id = :generation_id), "
                "(SELECT xmin::text FROM background_jobs WHERE id = :job_id)"
            ),
            {"generation_id": generation_id, "job_id": seeded.job.id},
        ).one()
        assert ledger_xmin == child_xmin == job_xmin


def test_media_unit_build_yields_to_user_blocking_background_work(
    engine: Engine,
) -> None:
    """Risk: derived synthesis backlog delays a newly published source ingest."""

    seeded = _seed_media_build(engine)

    assert seeded.job.priority == 200


def test_oracle_prove_not_dispatched_requeues_only_the_same_job_without_input_requery(
    engine: Engine,
) -> None:
    """Risk: Oracle re-runs mutable retrieval or fabricates a terminal during repair."""

    user_id = uuid4()
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(engine)))
    try:
        with Session(engine, expire_on_commit=False) as db:
            ensure_user_and_default_library(
                db,
                user_id,
                f"oracle-reconciliation-{user_id}@example.invalid",
            )
            reading = create_reading(
                db,
                viewer_id=user_id,
                question="What remains when dispatch is proven absent?",
            )
            job_id = UUID(
                str(
                    db.execute(
                        text(
                            "SELECT id FROM background_jobs "
                            "WHERE kind = 'oracle_reading_generate' "
                            "AND payload ->> 'reading_id' = :reading_id"
                        ),
                        {"reading_id": str(reading.id)},
                    ).scalar_one()
                )
            )
            job, context = _claim_exact_job(
                db,
                job_id,
                worker_id="oracle-reconciliation-first",
            )
            generation_id = stable_generation_id(reading.id, "synthesis")
            draft = _draft(generation_id, operation="oracle")
            state = StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Uncertain,
                request_fingerprint=present(draft.spec.fingerprint),
                terminal_result=absent(),
            )
            stage_uncertain_codex_generation(
                db,
                owner=LlmCallOwner(kind="oracle_reading", id=reading.id),
                draft=draft,
            )
            assert checkpoint_step_state(
                db,
                ctx=context,
                job=job,
                step_path="synthesis",
                state=state,
            )
            db.commit()
            assert (
                fail_job(
                    db,
                    job_id=job_id,
                    worker_id=context.worker_id,
                    attempt_no=context.attempt_no,
                    error_code="E_RECONCILIATION_REQUIRED",
                    error_message="accepted Oracle generation is ambiguous",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()

            with pytest.raises(InvalidRequestError, match="prove.*not dispatched"):
                reconcile_uncertain_oracle_reading(
                    db,
                    reading_id=reading.id,
                    resolution=_raw_terminal_attachment(
                        _media_terminal_frame(generation_id),
                        latency_ms=1,
                    ),
                )
            db.rollback()

            reconcile_uncertain_oracle_reading(
                db,
                reading_id=reading.id,
                resolution=ProveNotDispatched(),
            )

            repaired = get_job(db, job_id)
            assert repaired is not None and repaired.status == "pending"
            assert repaired.id == job_id
            assert read_step_states(repaired)["synthesis"].dispatch_phase is Prepared
            assert read_generation(db, generation_id=generation_id) is None
            job_count = db.execute(
                text(
                    "SELECT COUNT(*) FROM background_jobs "
                    "WHERE kind = 'oracle_reading_generate' "
                    "AND payload ->> 'reading_id' = :reading_id"
                ),
                {"reading_id": str(reading.id)},
            ).scalar_one()
            assert job_count == 1
    finally:
        set_rate_limiter(previous_limiter)


def test_oracle_terminal_noop_completes_prepared_without_ledger_evidence(
    engine: Engine,
) -> None:
    """Risk: a terminal reading leaves its pre-dispatch job journal open."""

    user_id = uuid4()
    runtime = _NeverExecutionRuntime()
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(engine)))
    try:
        with Session(engine, expire_on_commit=False) as db:
            ensure_user_and_default_library(
                db,
                user_id,
                f"oracle-cancellation-{user_id}@example.invalid",
            )
            reading = create_reading(
                db,
                viewer_id=user_id,
                question="What remains after a known preaccept cancellation?",
            )
            job_id = UUID(
                str(
                    db.execute(
                        text(
                            "SELECT id FROM background_jobs "
                            "WHERE kind = 'oracle_reading_generate' "
                            "AND payload ->> 'reading_id' = :reading_id"
                        ),
                        {"reading_id": str(reading.id)},
                    ).scalar_one()
                )
            )
            job, context = _claim_exact_job(
                db,
                job_id,
                worker_id="oracle-cancellation",
            )
            generation_id = stable_generation_id(reading.id, "synthesis")
            draft = _draft(generation_id, operation="oracle")
            assert checkpoint_step_state(
                db,
                ctx=context,
                job=job,
                step_path="synthesis",
                state=StepReplayState(
                    generation_id=generation_id,
                    dispatch_phase=Prepared,
                    request_fingerprint=present(draft.spec.fingerprint),
                    terminal_result=absent(),
                ),
            )
            run_kit.mark_terminal(
                db,
                stream=run_kit.oracle_reading_stream(reading),
                status="failed",
                done_payload=oracle_done_payload(status="failed", error_code="E_APP_SEARCH_FAILED"),
                error_code="E_APP_SEARCH_FAILED",
                error_detail="terminalized before host dispatch",
            )
            db.commit()

            result = asyncio.run(
                execute_reading(
                    db,
                    reading_id=reading.id,
                    context=context,
                    runtime=runtime,
                )
            )
            persisted = get_job(db, job_id)
            assert result == {"status": "failed", "noop": True}
            assert runtime.dispatches == 0
            assert persisted is not None
            completed = read_step_states(persisted)["synthesis"]
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert json.loads(completed.terminal_result.value) == {
                "outcome": "noop",
                "status": "failed",
            }
            assert read_generation(db, generation_id=generation_id) is None
    finally:
        set_rate_limiter(previous_limiter)
