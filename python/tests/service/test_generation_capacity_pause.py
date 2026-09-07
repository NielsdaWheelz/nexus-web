"""Durable background generation capacity-pause proof."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from importlib.util import find_spec
from types import MappingProxyType, SimpleNamespace
from typing import TYPE_CHECKING, cast
from uuid import UUID, uuid4

import pytest

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_admission") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION
    from sqlalchemy import Engine
    from sqlalchemy.orm import Session

    from nexus.db.session import create_session_factory
    from nexus.jobs.queue import (
        PENDING,
        JobExecutionContext,
        RescheduleRequested,
        claim_job,
        enqueue_job,
        get_job,
        lock_job,
        reschedule_running_job,
    )
    from nexus.schemas.llm import (
        CapacityPaused,
        PrivacyDisclosure,
        ProcessorChain,
        Ready,
        Selectable,
        SelectionPresentation,
        SubscriptionBilling,
    )
    from nexus.schemas.presence import Absent, Present
    from nexus.services import generation_policy
    from nexus.services.generation_backend import GenerationBackendExecution
    from nexus.services.generation_catalog import (
        CodexDispatchTarget,
        GenerationCatalogService,
        ResolvedCatalogPair,
    )
    from nexus.services.generation_continuations import GenerationContinuationCipher
    from nexus.services.generation_events import BackendTerminal
    from nexus.services.generation_intent import GenerationIntent, TextOutput
    from nexus.services.generation_selection import CodexPersonalSelection
    from nexus.services.generation_service import GenerationService
    from nexus.services.generation_spec import (
        ImmutablePromptPayloadRef,
        generation_fact_digest,
    )
    from nexus.services.llm_execution import (
        ExecutionRuntime,
        GenerationCapacityPaused,
        JobGenerationJournal,
        admit_job_generation,
    )
    from nexus.services.llm_ledger import LlmCallOwner
    from nexus.services.tool_runtime.composition import ComposedToolRuntime
    from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task
    from tests.testkit.unreachable_state import delete_jobs_by_ids

_STEP_PATH = "generation/capacity-proof"
_CATALOG_REVISION = "a" * 64
_SOURCE_REVISION = "b" * 64
_ROW_FINGERPRINT = "c" * 64


@dataclass(frozen=True, slots=True)
class _CatalogSnapshot:
    pair_value: ResolvedCatalogPair

    @property
    def catalog(self) -> object:
        return SimpleNamespace(definition_revision=_CATALOG_REVISION)

    def pair(self, selection: object) -> ResolvedCatalogPair:
        assert selection == self.pair_value.selection
        return self.pair_value


@dataclass(frozen=True, slots=True)
class _AdmissionCatalog:
    pair_value: ResolvedCatalogPair

    async def read_for_admission(self) -> _CatalogSnapshot:
        return _CatalogSnapshot(pair_value=self.pair_value)


@dataclass(frozen=True, slots=True)
class _AdmissionRuntime:
    admission: GenerationService

    @property
    def continuation_cipher(self) -> GenerationContinuationCipher:
        raise AssertionError("capacity admission must not reach continuation authority")

    async def execute(self, execution: GenerationBackendExecution) -> BackendTerminal:
        del execution
        raise AssertionError("capacity admission must not dispatch a backend")


def _shipped_dawn_selection() -> CodexPersonalSelection:
    """Build the shipped Dawn Write selection lazily; BASE has no selection owner."""
    return CodexPersonalSelection(
        route="CodexPersonal",
        model="gpt-5.6-terra",
        reasoning="medium",
    )


def _pair(
    readiness: Ready | CapacityPaused,
    *,
    selection: CodexPersonalSelection,
) -> ResolvedCatalogPair:
    return ResolvedCatalogPair(
        selection=selection,
        target_key=f"CodexPersonal:{selection.model}",
        source_catalog_definition_revision=_SOURCE_REVISION,
        source_row_fingerprint=_ROW_FINGERPRINT,
        backend_contract_revision=AGENT_BACKEND_CONTRACT_REVISION,
        resolved_dispatch_target=CodexDispatchTarget(
            model_key=selection.model,
            dispatch_model=selection.model,
            agent_definition_revision=_SOURCE_REVISION,
        ),
        source_context_window=Absent(),
        source_max_output_tokens=Absent(),
        effective_context_budget_tokens=128_000,
        effective_output_budget_tokens=16_000,
        presentation=SelectionPresentation(
            route_label="Codex Personal",
            model_label=selection.model,
            reasoning_label=selection.reasoning,
            billing=SubscriptionBilling(),
            privacy=PrivacyDisclosure(
                summary="Authenticated local Codex account.",
                retention="Codex account retention applies.",
                training="Nexus does not opt content into training.",
            ),
            processor_chain=ProcessorChain(processors=("Nexus", "OpenAI Codex")),
        ),
        lifecycle="Active",
        readiness=readiness,
        state=readiness if isinstance(readiness, CapacityPaused) else Selectable(),
        target_qualification_revision=Present(value="target-qualified"),
        reasoning_wire_qualification_revision=Present(value="reasoning-qualified"),
        qualified_capabilities=("Text", "StrictStructured", "ToolsContinuation"),
        qualified_tool_plan_authority_revisions=(),
    )


def _runtime(
    readiness: Ready | CapacityPaused,
    *,
    policy: generation_policy.GenerationPolicy | None = None,
) -> ExecutionRuntime:
    policy = generation_policy.GENERATION_POLICY if policy is None else policy
    selection = policy.background_operations["dawn_write"].selection
    assert isinstance(selection, CodexPersonalSelection)
    # justify-type-assertion: this controlled catalog implements the only public
    # admission method exercised here; constructing the remote-backed catalog
    # would replace the exact readiness state under proof.
    catalog = cast(
        GenerationCatalogService,
        _AdmissionCatalog(pair_value=_pair(readiness, selection=selection)),
    )
    # justify-type-assertion: Dawn Write owns no model tools, so admission cannot
    # observe any tool-runtime field beyond the empty operation registry.
    tools = cast(ComposedToolRuntime, SimpleNamespace(operations={}))
    return _AdmissionRuntime(
        admission=GenerationService(catalog=catalog, policy=policy, tools=tools)
    )


def _intent() -> GenerationIntent:
    return GenerationIntent(
        instructions="Write the reader's grounded dawn reflection.",
        input="One bounded proof signal.",
        output=TextOutput(),
    )


def _prompt_ref(intent: GenerationIntent) -> ImmutablePromptPayloadRef:
    revision = generation_policy.operation_revision("dawn_write")
    return ImmutablePromptPayloadRef(
        owner_kind="dawn_write",
        owner_id="capacity-proof",
        revision=revision,
        payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
    )


def _claim_job(engine: Engine, *, worker_id: str) -> tuple[UUID, JobExecutionContext]:
    with Session(engine) as db:
        job = enqueue_job(
            db,
            kind="dawn_write_job",
            payload={"proof": "generation-capacity"},
            max_attempts=1,
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
        return job.id, context


def _journal(context: JobExecutionContext) -> JobGenerationJournal:
    return JobGenerationJournal(
        context=context,
        step_path=_STEP_PATH,
        lock_dispatch=lambda db: lock_job(db, context.job_id),
    )


def test_background_admission_persists_exact_capacity_pause_and_ready_clears_it(
    engine: Engine,
) -> None:
    """Risk: quota waits lose their durable cause or poison a later ready admission."""

    assert _CUTOVER_PRESENT, "the durable generation capacity owner is absent"
    session_factory = create_session_factory(engine)
    worker_id = f"generation-capacity-{uuid4()}"
    job_id, context = _claim_job(engine, worker_id=worker_id)
    observed_at = datetime.now(UTC)
    reset_at = observed_at + timedelta(hours=2)
    pause = CapacityPaused(
        explanation="Codex subscription capacity is exhausted.",
        reset_at=Present(value=reset_at),
        next_check_at=observed_at + timedelta(minutes=15),
        last_checked=observed_at,
    )
    intent = _intent()
    journal = _journal(context)
    owner = LlmCallOwner(kind="dawn_write", id=uuid4())
    generation_id = uuid4()
    try:
        with pytest.raises(GenerationCapacityPaused) as raised:
            asyncio.run(
                admit_job_generation(
                    owner=owner,
                    generation_id=generation_id,
                    operation="dawn_write",
                    intent=intent,
                    prompt_template_revision=generation_policy.operation_revision("dawn_write"),
                    prompt_payload_ref=_prompt_ref(intent),
                    journal=journal,
                    session_factory=session_factory,
                    runtime=_runtime(pause),
                )
            )
        assert raised.value.pause == pause
        assert raised.value.schedule.instant == reset_at
        with session_factory() as db:
            parked = get_job(db, job_id)
            assert parked is not None
            assert parked.payload["generation_capacity_pauses"] == {
                _STEP_PATH: pause.model_dump(mode="json")
            }

        admitted = asyncio.run(
            admit_job_generation(
                owner=owner,
                generation_id=generation_id,
                operation="dawn_write",
                intent=intent,
                prompt_template_revision=generation_policy.operation_revision("dawn_write"),
                prompt_payload_ref=_prompt_ref(intent),
                journal=journal,
                session_factory=session_factory,
                runtime=_runtime(Ready(last_checked=observed_at + timedelta(minutes=1))),
            )
        )
        assert admitted.spec.operation == "dawn_write"
        with session_factory() as db:
            ready = get_job(db, job_id)
            assert ready is not None
            assert "generation_capacity_pauses" not in ready.payload
    finally:
        with session_factory() as db:
            delete_jobs_by_ids(db, job_ids=(job_id,))
            db.commit()


def test_capacity_pause_reschedule_preserves_retry_budget(engine: Engine) -> None:
    """Risk: a routine subscription wait consumes the job's only retry attempt."""

    assert _CUTOVER_PRESENT, "the durable generation capacity owner is absent"
    session_factory = create_session_factory(engine)
    worker_id = f"generation-capacity-reschedule-{uuid4()}"
    job_id, context = _claim_job(engine, worker_id=worker_id)
    observed_at = datetime.now(UTC)
    reset_at = observed_at + timedelta(hours=2)
    pause = CapacityPaused(
        explanation="Codex subscription capacity is exhausted.",
        reset_at=Present(value=reset_at),
        next_check_at=observed_at + timedelta(minutes=15),
        last_checked=observed_at,
    )

    async def paused_handler(_db: Session, _runtime: ExecutionRuntime) -> None:
        raise GenerationCapacityPaused(pause)

    try:
        result = run_llm_task(
            LlmTaskSpec(label="generation_capacity_proof"),
            paused_handler,
        )
        assert isinstance(result, RescheduleRequested)
        assert result.schedule.instant == reset_at
        with session_factory() as db:
            assert reschedule_running_job(
                db,
                job_id=job_id,
                worker_id=worker_id,
                attempt_no=context.attempt_no,
                schedule=result.schedule,
            )
            db.commit()
            rescheduled = get_job(db, job_id)
            assert rescheduled is not None
            assert rescheduled.status == PENDING
            assert rescheduled.attempts == 0
            assert rescheduled.max_attempts == 1
            assert rescheduled.available_at == reset_at
    finally:
        with session_factory() as db:
            delete_jobs_by_ids(db, job_ids=(job_id,))
            db.commit()


def test_rebuild_admission_reads_current_policy_and_never_alters_frozen_work(
    engine: Engine,
) -> None:
    """Risk: a policy deployment rewrites queued work, or a manual rebuild admits stale policy."""

    assert _CUTOVER_PRESENT, "the durable generation admission owner is absent"
    session_factory = create_session_factory(engine)
    ready = Ready(last_checked=datetime.now(UTC))
    intent = _intent()
    revision = generation_policy.operation_revision("dawn_write")
    shipped = generation_policy.GENERATION_POLICY
    revised_selection = CodexPersonalSelection(
        route="CodexPersonal",
        model="gpt-5.6-luna",
        reasoning="low",
    )
    assert revised_selection != _shipped_dawn_selection()
    revised = replace(
        shipped,
        revision=generation_fact_digest("rebuild-admission-proof-policy"),
        background_operations=MappingProxyType(
            {
                **shipped.background_operations,
                "dawn_write": replace(
                    shipped.background_operations["dawn_write"],
                    selection=revised_selection,
                ),
            }
        ),
    )
    first_job, first_context = _claim_job(engine, worker_id=f"generation-policy-first-{uuid4()}")
    rebuild_job, rebuild_context = _claim_job(
        engine,
        worker_id=f"generation-policy-rebuild-{uuid4()}",
    )
    first_owner = LlmCallOwner(kind="dawn_write", id=uuid4())
    first_generation_id = uuid4()
    try:
        first = asyncio.run(
            admit_job_generation(
                owner=first_owner,
                generation_id=first_generation_id,
                operation="dawn_write",
                intent=intent,
                prompt_template_revision=revision,
                prompt_payload_ref=_prompt_ref(intent),
                journal=_journal(first_context),
                session_factory=session_factory,
                runtime=_runtime(ready),
            )
        )
        assert first.spec.selection == _shipped_dawn_selection()
        assert first.spec.policy_revision == shipped.revision

        # The deployed policy changes while the first admission is still queued:
        # replaying that admission must return the frozen spec, never reread policy.
        replayed = asyncio.run(
            admit_job_generation(
                owner=first_owner,
                generation_id=first_generation_id,
                operation="dawn_write",
                intent=intent,
                prompt_template_revision=revision,
                prompt_payload_ref=_prompt_ref(intent),
                journal=_journal(first_context),
                session_factory=session_factory,
                runtime=_runtime(ready, policy=revised),
            )
        )
        assert replayed.spec == first.spec, (
            f"a queued admission was rewritten by a later policy revision: {replayed.spec!r}"
        )

        # A manual rebuild is a fresh admission under the current developer policy.
        rebuild = asyncio.run(
            admit_job_generation(
                owner=LlmCallOwner(kind="dawn_write", id=uuid4()),
                generation_id=uuid4(),
                operation="dawn_write",
                intent=intent,
                prompt_template_revision=revision,
                prompt_payload_ref=_prompt_ref(intent),
                journal=_journal(rebuild_context),
                session_factory=session_factory,
                runtime=_runtime(ready, policy=revised),
            )
        )
        assert rebuild.spec.selection == revised_selection, (
            f"rebuild admission ignored the current policy selection: {rebuild.spec.selection!r}"
        )
        assert rebuild.spec.policy_revision == revised.revision
        assert rebuild.spec.fingerprint != first.spec.fingerprint
    finally:
        with session_factory() as db:
            delete_jobs_by_ids(db, job_ids=(first_job, rebuild_job))
            db.commit()
