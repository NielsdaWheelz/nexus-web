"""Canonical PostgreSQL proof for parent/child generation replay."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import ssl
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from importlib.util import find_spec
from types import MappingProxyType, SimpleNamespace
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    HandlerSuccess,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
)
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session, sessionmaker

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_continuations") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime.registry import api_model_catalog
    from provider_runtime.types import (
        Absent as RuntimeAbsent,
    )
    from provider_runtime.types import (
        AttemptRecord,
        CallMeta,
        CancelSignal,
        ExpectedModelFailure,
        Failed,
        FinalAttempt,
        GenerateIntent,
        PossiblyBillable,
        RuntimeStreamEvent,
        StreamStart,
        TerminalEvent,
        TextContent,
        TokenUsage,
    )
    from provider_runtime.types import (
        Present as RuntimePresent,
    )
    from provider_runtime.types import (
        Succeeded as ProviderSucceeded,
    )

    from nexus.config import Settings
    from nexus.db.models import LLMModelTurn, LLMModelTurnContinuation
    from nexus.db.session import create_session_factory
    from nexus.jobs.queue import JobExecutionContext, enqueue_job, get_job, lock_job
    from nexus.schemas.presence import Present, absent, present
    from nexus.services import generation_policy
    from nexus.services.codex_generation_contract import NormalizedFailureCode
    from nexus.services.durable_step_journal import Completed, Uncertain
    from nexus.services.generation_backend import (
        BackendGenerationRequest,
        BackendToolExecutionRequest,
        BackendToolExecutionResult,
        BackendToolExecutor,
        GenerationBackend,
        GenerationBackendComposition,
        PreparedCodexChild,
    )
    from nexus.services.generation_continuations import (
        GenerationContinuationAuthenticationError,
        GenerationContinuationCipher,
        GenerationContinuationContext,
    )
    from nexus.services.generation_events import BackendTerminal, ProviderTerminalEvidence
    from nexus.services.generation_intent import GenerationIntent, TextOutput
    from nexus.services.generation_selection import ProviderApiSelection
    from nexus.services.generation_service import GenerationService
    from nexus.services.generation_spec import (
        FrozenToolScope,
        GenerationSpec,
        ImmutablePromptPayloadRef,
        generation_fact_digest,
    )
    from nexus.services.llm_execution import (
        CompletedGeneration,
        ComposedExecutionRuntime,
        EncodedGenerationTerminal,
        GenerationExecutionRequest,
        GenerationUncertain,
        JobGenerationJournal,
        admit_job_generation,
        execute_generation,
    )
    from nexus.services.llm_ledger import (
        DispatchableModelTurn,
        GenerationStart,
        LlmCallOwner,
        ModelTurnCompletion,
        ModelTurnStart,
        PendingGenerationContinuation,
        RedispatchForbiddenModelTurn,
        arm_model_turn_dispatch_in_current_transaction,
        arm_resumed_model_turn_dispatch_in_current_transaction,
        complete_generation_in_current_transaction,
        complete_model_turn_in_current_transaction,
        generation_spec_document,
        lock_generation_owner_in_current_transaction,
        open_generation_continuation_in_current_transaction,
        read_generation,
        read_model_turns,
        read_pending_generation_continuation_in_current_transaction,
        resume_generation_continuation_in_current_transaction,
        start_generation_in_current_transaction,
        start_model_turn_in_current_transaction,
    )
    from nexus.services.provider_generation_backend import (
        ProviderGenerationBackend,
        ProviderGenerationWiring,
        build_provider_generation_backend,
    )
    from nexus.services.provider_generation_contract import ProviderModelTools
    from nexus.services.tool_authority import (
        compose_deferred_generation_tool_executor,
        read_tool_positions,
    )
    from nexus.services.tool_runtime.composition import (
        ComposedToolRuntime,
        FrozenToolOperation,
        compose_provider_model_tools,
        compose_tool_runtime,
        freeze_tool_plan_snapshot,
    )
    from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.queue_claims import claim_job_row
    from tests.testkit.unreachable_state import delete_jobs_by_ids, expire_job_claim


def _generation_spec() -> dict[str, object]:
    output_contract = {"kind": "Text"}
    document: dict[str, object] = {
        "schema_version": "nexus-generation-spec.v1",
        "operation": "metadata_enrichment",
        "selection": {
            "route": "ProviderApi",
            "model_ref": "openai:gpt-5.6-luna",
            "reasoning": "low",
        },
        "selection_source": "BackgroundPolicy",
        "resolved_dispatch_target": {
            "kind": "ProviderApi",
            "model_ref": "openai:gpt-5.6-luna",
            "provider": "openai",
            "model_id": "gpt-5.6-luna",
            "engine": "responses",
            "base_url": {"kind": "Absent"},
            "correlation": "header",
            "routing": {"kind": "Absent"},
            "continuation_codec": "openai.responses.v1",
            "registry_revision": "registry.1",
        },
        "source_catalog_definition_revision": "provider-catalog.1",
        "source_row_fingerprint": "1" * 64,
        "agent_definition_revision": {"kind": "Absent"},
        "source_context_window": {"kind": "Present", "value": 128_000},
        "source_max_output_tokens": {"kind": "Present", "value": 16_384},
        "effective_context_budget_tokens": 32_000,
        "effective_output_budget_tokens": 4_096,
        "bounds": {
            "instructions_max_bytes": 65_536,
            "input_max_bytes": 1_048_576,
            "turn_timeout_seconds": 180,
            "session_open_timeout_seconds": 30,
            "runtime_close_timeout_seconds": 10,
            "transport_margin_seconds": 5,
            "transport_deadline_seconds": 185,
            "stream": {
                "max_frames": 10_000,
                "max_frame_bytes": 1_048_576,
                "max_stream_bytes": 16_777_216,
                "text_flush_interval_ms": {"kind": "Absent"},
                "text_flush_bytes": {"kind": "Absent"},
            },
        },
        "prompt_template_revision": "metadata.prompt.1",
        "prompt_payload_ref": {
            "kind": "DomainPromptPayload",
            "owner_kind": "media_enrichment",
            "owner_id": "proof-owner",
            "revision": "metadata.prompt.1",
            "payload_digest": "2" * 64,
        },
        "instructions_digest": "3" * 64,
        "input_digest": "4" * 64,
        "output_contract": output_contract,
        "output_contract_fingerprint": hashlib.sha256(
            json.dumps(
                output_contract,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
        "display_at_dispatch": {
            "route_label": "OpenAI API",
            "model_label": "GPT-5.6 Luna",
            "reasoning_label": "Low",
            "billing": {"kind": "MeteredApi", "label": "Metered API"},
            "privacy": {
                "summary": "OpenAI API processes this generation.",
                "retention": "Configured API retention applies.",
                "training": "Configured API training policy applies.",
            },
            "processor_chain": {"processors": ("Nexus", "OpenAI API")},
        },
        "host_tool_plan_snapshot": {"kind": "Absent"},
        "host_evidence_revision": {"kind": "Absent"},
        "model_tool_plan_snapshot": {"kind": "Absent"},
        "tool_effect_mode": {"kind": "Absent"},
        "admitted_tool_scope": {"kind": "Absent"},
        "admitted_tool_scope_digest": {"kind": "Absent"},
        "catalog_definition_revision": "8" * 64,
        "policy_revision": "generation-policy.1",
        "backend_contract_revision": "provider-runtime.1",
        "provider_registry_revision": {"kind": "Present", "value": "registry.1"},
    }
    document["fingerprint"] = hashlib.sha256(
        json.dumps(
            document,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return GenerationSpec.model_validate(document).model_dump(mode="json", by_alias=True)


def test_parent_child_tool_replay_is_exactly_once(request: pytest.FixtureRequest) -> None:
    """Risk: crash replay duplicates a billable child or successor dispatch."""

    assert _CUTOVER_PRESENT, "sealed generation continuation ownership is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    generation_id = uuid4()
    first_turn_id = uuid4()
    second_turn_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    spec = generation_spec_document(_generation_spec())
    cipher = GenerationContinuationCipher(b"k" * 32)
    context = GenerationContinuationContext(
        generation_id=generation_id,
        source_turn_seq=1,
        successor_turn_seq=2,
        target_fingerprint="1" * 64,
        codec_id="openai.responses.v1",
        policy_revision="generation-policy.1",
    )
    canonical_continuation = b'{"response_id":"provider-successor"}'
    sealed = cipher.seal(
        canonical_continuation=canonical_continuation,
        context=context,
    )
    first = ModelTurnStart(
        model_turn_id=first_turn_id,
        generation_id=generation_id,
        turn_seq=1,
        request_fingerprint="6" * 64,
        route_request_identity={"kind": "ProviderApi", "request_key": "first"},
    )
    second = ModelTurnStart(
        model_turn_id=second_turn_id,
        generation_id=generation_id,
        turn_seq=2,
        request_fingerprint="7" * 64,
        route_request_identity={"kind": "ProviderApi", "request_key": "second"},
    )
    first_completion = ModelTurnCompletion(
        terminal={"kind": "Succeeded", "native": {"finish_reason": "tool_calls"}},
        usage=present({"input_tokens": 100, "output_tokens": 10}),
        billability=present({"kind": "Billable"}),
        accepted_at=present(datetime(2026, 8, 31, 20, 0, tzinfo=UTC)),
        successor=present(sealed),
    )
    with pytest.raises(ValueError, match="timezone-aware"):
        ModelTurnCompletion(
            terminal={"kind": "Failed"},
            usage=absent(),
            billability=absent(),
            accepted_at=present(datetime(2026, 8, 31, 20, 0)),
            successor=absent(),
        )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(generation_id=generation_id, owner=owner, spec=spec),
        )
        assert (
            start_generation_in_current_transaction(
                db,
                GenerationStart(generation_id=generation_id, owner=owner, spec=spec),
            )
            == generation_id
        )
        start_model_turn_in_current_transaction(db, first)
        arm_model_turn_dispatch_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
        )
        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
            completion=first_completion,
        )

        with pytest.raises(AssertionError, match="sealed successor continuation"):
            complete_generation_in_current_transaction(
                db,
                owner=owner,
                generation_id=generation_id,
                terminal={"kind": "Succeeded", "final_model_turn_seq": 1},
            )

        wrong_context = GenerationContinuationContext(
            generation_id=generation_id,
            source_turn_seq=1,
            successor_turn_seq=2,
            target_fingerprint="1" * 64,
            codec_id="openai.responses.v1",
            policy_revision="different-policy",
        )
        with pytest.raises(
            GenerationContinuationAuthenticationError,
            match="context authentication failed",
        ):
            resume_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                successor=second,
                expected_context=wrong_context,
                cipher=cipher,
            )
        assert [turn.turn_seq for turn in read_model_turns(db, generation_id=generation_id)] == [1]
        with pytest.raises(ValueError, match="successors require sealed continuation resume"):
            start_model_turn_in_current_transaction(db, second)

        pending = read_pending_generation_continuation_in_current_transaction(
            db,
            generation_id=generation_id,
            cipher=cipher,
        )
        assert isinstance(pending, PendingGenerationContinuation)
        assert pending.source_turn.id == first_turn_id
        assert pending.context == context
        assert pending.canonical_continuation == canonical_continuation

        assert (
            open_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                expected_context=context,
                cipher=cipher,
            )
            == canonical_continuation
        )
        first_resume = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        replayed_resume = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(first_resume, DispatchableModelTurn)
        assert isinstance(replayed_resume, DispatchableModelTurn)
        assert first_resume.turn.id == replayed_resume.turn.id == second_turn_id
        assert first_resume.canonical_continuation == canonical_continuation
        assert canonical_continuation.decode() not in repr(first_resume)
        assert [turn.turn_seq for turn in read_model_turns(db, generation_id=generation_id)] == [
            1,
            2,
        ]

        with pytest.raises(AssertionError, match="different child facts"):
            resume_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                successor=ModelTurnStart(
                    model_turn_id=uuid4(),
                    generation_id=generation_id,
                    turn_seq=2,
                    request_fingerprint="7" * 64,
                    route_request_identity={
                        "kind": "ProviderApi",
                        "request_key": "second",
                    },
                ),
                expected_context=context,
                cipher=cipher,
            )

        armed_second = arm_resumed_model_turn_dispatch_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert armed_second.id == second_turn_id
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurnContinuation)
                .where(LLMModelTurnContinuation.generation_id == generation_id)
            )
            == 0
        )
        forbidden = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(forbidden, RedispatchForbiddenModelTurn)

        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=second_turn_id,
            completion=ModelTurnCompletion(
                terminal={"kind": "Succeeded", "native": {"finish_reason": "stop"}},
                usage=present({"input_tokens": 40, "output_tokens": 20}),
                billability=present({"kind": "Billable"}),
                accepted_at=present(datetime(2026, 8, 31, 20, 1, tzinfo=UTC)),
                successor=absent(),
            ),
        )
        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
            completion=first_completion,
        )
        with pytest.raises(AssertionError, match="omitted its consumed successor"):
            complete_model_turn_in_current_transaction(
                db,
                generation_id=generation_id,
                model_turn_id=first_turn_id,
                completion=ModelTurnCompletion(
                    terminal=first_completion.terminal,
                    usage=first_completion.usage,
                    billability=first_completion.billability,
                    accepted_at=first_completion.accepted_at,
                    successor=absent(),
                ),
            )
        consumed = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(consumed, RedispatchForbiddenModelTurn)

        complete_generation_in_current_transaction(
            db,
            owner=owner,
            generation_id=generation_id,
            terminal={"kind": "Succeeded", "final_model_turn_seq": 2},
        )
        generation = read_generation(db, generation_id=generation_id)
        assert generation is not None
        assert generation.outcome == "Succeeded"
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurn)
                .where(LLMModelTurn.generation_id == generation_id)
            )
            == 2
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurnContinuation)
                .where(LLMModelTurnContinuation.generation_id == generation_id)
            )
            == 0
        )


def test_foreign_provider_failure_is_refused_not_relabelled(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: an llm-calling failure variant Nexus does not know is renamed into the ledger."""

    assert _CUTOVER_PRESENT, "route-neutral generation execution ownership is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_foreign_provider_failure_is_refused(engine))


async def _prove_foreign_provider_failure_is_refused(engine: Engine) -> None:
    session_factory = create_session_factory(engine)
    runtime = ComposedExecutionRuntime(
        backend=GenerationBackend(
            GenerationBackendComposition(
                codex=_UnusedCodex(),
                provider=ProviderGenerationBackend(_ForeignFailureProviderRuntime()),
                codex_projection=_UnusedCodexProjection(),
                provider_tools=_ToolFreeProviderTools(),
            )
        ),
        continuation_cipher=GenerationContinuationCipher(b"k" * 32),
        admission=GenerationService(
            catalog=configured_chat_catalog_service(),
            policy=_provider_dawn_write_policy(),
            # justify-type-assertion: Dawn Write owns no model tools, so admission
            # observes no tool-runtime field beyond the empty operation registry.
            tools=cast(ComposedToolRuntime, SimpleNamespace(operations={})),
        ),
    )
    job_id, context = _claim_dawn_write_job(engine, worker_id=f"foreign-failure-{uuid4()}")
    intent = GenerationIntent(
        instructions="Write the reader's grounded dawn reflection.",
        input="One bounded proof signal.",
        output=TextOutput(),
    )
    revision = generation_policy.operation_revision("dawn_write")
    generation_id = uuid4()
    try:
        admitted = await admit_job_generation(
            owner=LlmCallOwner(kind="dawn_write", id=uuid4()),
            generation_id=generation_id,
            operation="dawn_write",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="dawn_write",
                owner_id="foreign-failure-proof",
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=JobGenerationJournal(
                context=context,
                step_path="generation/foreign-failure-proof",
                lock_dispatch=lambda db: lock_job(db, context.job_id),
            ),
            session_factory=session_factory,
            runtime=runtime,
        )
        assert admitted.spec.selection == CHAT_TEST_SELECTION

        with pytest.raises(GenerationUncertain) as refused:
            await execute_generation(
                admitted,
                session_factory=session_factory,
                runtime=runtime,
                encode_terminal=_encode_any_terminal,
                encode_preaccept_failure=_refuse_preaccept,
            )
        cause = refused.value.__cause__
        assert isinstance(cause, AssertionError) and "unreachable" in str(cause), (
            f"foreign provider failure was not refused by the closed ledger match: {cause!r}"
        )
        assert "_ForeignFailure" in str(cause)

        with session_factory() as db:
            generation = read_generation(db, generation_id=generation_id)
            turns = read_model_turns(db, generation_id=generation_id)
        assert generation is not None
        assert generation.outcome is None, (
            f"foreign provider failure was relabelled into the ledger: {generation.terminal!r}"
        )
        assert [turn.terminal for turn in turns] == [None], (
            f"foreign provider failure was relabelled into a child terminal: {turns!r}"
        )
    finally:
        with session_factory() as db:
            delete_jobs_by_ids(db, job_ids=(job_id,))
            db.commit()


def _provider_dawn_write_policy() -> generation_policy.GenerationPolicy:
    """Current developer policy with Dawn routed to the configured API row under proof."""

    current = generation_policy.GENERATION_POLICY
    dawn_write = replace(current.background_operations["dawn_write"], selection=CHAT_TEST_SELECTION)
    return replace(
        current,
        revision=generation_fact_digest("foreign-failure-proof-policy"),
        background_operations=MappingProxyType(
            {**current.background_operations, "dawn_write": dawn_write}
        ),
    )


def _claim_dawn_write_job(engine: Engine, *, worker_id: str) -> tuple[UUID, JobExecutionContext]:
    with Session(engine) as db:
        job = enqueue_job(
            db,
            kind="dawn_write_job",
            payload={"proof": "foreign-provider-failure"},
            max_attempts=1,
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
        db.commit()
        return job.id, JobExecutionContext(
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            resource_class="Light",
            execution_id=claimed.execution_id,
        )


def _encode_any_terminal(terminal: BackendTerminal) -> EncodedGenerationTerminal:
    """A domain encoder that accepts every terminal, so only the ledger match can refuse."""

    del terminal
    return EncodedGenerationTerminal(terminal_result='{"kind":"foreign-failure-proof"}')


def _refuse_preaccept(code: NormalizedFailureCode, detail: str) -> str:
    raise AssertionError(f"a ready ProviderApi row refused before acceptance: {code} {detail}")


@dataclass(frozen=True, slots=True)
class _ForeignFailure:
    """A failure variant the pinned llm-calling contract does not declare."""

    safe_detail: str


class _ForeignFailureProviderRuntime:
    """Controlled external ProviderRuntime boundary emitting an undeclared failure."""

    async def stream(
        self,
        intent: GenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        del cancel
        usage = TokenUsage(
            input_tokens=23,
            output_tokens=0,
            total_tokens=23,
            reasoning_tokens=RuntimeAbsent(),
            cache_read_input_tokens=RuntimeAbsent(),
            cache_write_input_tokens=RuntimeAbsent(),
        )
        meta = CallMeta(
            provider=intent.target.provider,
            model=intent.target.model,
            provider_request_id=RuntimePresent("foreign-failure-proof"),
            upstream_provider=RuntimeAbsent(),
            usage=RuntimePresent(usage),
            attempt_trace=(
                AttemptRecord(
                    attempt=1,
                    signal=FinalAttempt(),
                    status_code=RuntimePresent(500),
                    started_at_ms=1,
                    ended_at_ms=2,
                ),
            ),
            billability=PossiblyBillable(),
            native_reasoning=RuntimePresent(intent.reasoning),
            registry_revision=api_model_catalog().registry_revision,
        )
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(
            seq=2,
            event=TerminalEvent(
                outcome=Failed(
                    meta=meta,
                    # justify-type-assertion: the proof deliberately crosses the pinned
                    # closed union with a variant the contract does not declare.
                    failure=cast(ExpectedModelFailure, _ForeignFailure(safe_detail="drifted")),
                )
            ),
        )


class _UnusedCodex:
    def stream(self, *_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise AssertionError("ProviderApi Dawn admission fell through to Codex")

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unused Codex transport was cancelled for {request_id}")


class _UnusedCodexProjection:
    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild:
        raise AssertionError(
            f"ProviderApi generation {request.generation_id} used Codex projection"
        )


class _ToolFreeProviderTools:
    """The production port answers every spec; a NoModelTools admission publishes no tools."""

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools | None:
        if isinstance(spec.model_tool_plan_snapshot, Present):
            raise AssertionError(f"tool-free {spec.operation!r} admission froze a model tool plan")
        return None


def test_provider_crash_after_accepted_child_resumes_one_successor_without_redispatch(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: a worker crash after an accepted API child reissues billed model work."""

    assert _CUTOVER_PRESENT, "route-neutral durable generation execution is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_provider_crash_resumes_exactly_once(engine))


async def _prove_provider_crash_resumes_exactly_once(engine: Engine) -> None:
    settings = Settings()
    endpoint_overrides = json.loads(os.environ["GENERATION_API_BASE_URLS"])
    ca_certificates = json.loads(os.environ["NEXUS_TEST_TLS_CA_CERTS"])
    tools = _fail_loud_tool_runtime()
    operation = tools.operations["ChatRead"]
    catalog = configured_chat_catalog_service()
    admission = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=tools,
    )
    intent = GenerationIntent(
        instructions="Use the supplied tool before answering.",
        input="NEXUS_PROVIDER_SCENARIO=tool model=openai:gpt-5.6-luna",
        output=TextOutput(),
    )
    spec = await admission.freeze_chat(
        catalog_definition_revision=(
            await catalog.read_for_admission()
        ).catalog.definition_revision,
        selection=ProviderApiSelection(
            route="ProviderApi",
            model_ref="openai:gpt-5.6-luna",
            reasoning="low",
        ),
        tool_authority="ReadOnly",
        scope=FrozenToolScope(admitted_refs=("library:proof",), predicates=()),
        intent=intent,
        prompt_template_revision="chat.prompt.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="chat_run",
            owner_id="generation-execution-proof",
            revision="chat.prompt.v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
    )
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    generation_id = uuid4()
    user_id = uuid4()
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    async with httpx.AsyncClient(
        verify=ssl.create_default_context(cafile=ca_certificates[0]),
        timeout=httpx.Timeout(10.0),
        trust_env=False,
    ) as client:
        runtime = ComposedExecutionRuntime(
            backend=GenerationBackend(
                GenerationBackendComposition(
                    codex=_UnusedCodex(),
                    provider=build_provider_generation_backend(
                        settings,
                        client,
                        wiring=ProviderGenerationWiring(endpoint_overrides=endpoint_overrides),
                    ),
                    codex_projection=_UnusedCodexProjection(),
                    provider_tools=_FrozenProviderTools(operation),
                )
            ),
            continuation_cipher=GenerationContinuationCipher(b"k" * 32),
            admission=admission,
        )
        with Session(engine) as db:
            job = enqueue_job(db, kind="generation_execution_proof", max_attempts=2)
            claimed = claim_job_row(
                db,
                job_id=job.id,
                worker_id="crashed-worker",
                lease_seconds=300,
                heavy_kinds=(),
            )
            assert claimed is not None
            db.commit()
        crashed_context = JobExecutionContext(
            job_id=job.id,
            worker_id="crashed-worker",
            attempt_no=claimed.attempts,
            resource_class="Light",
            execution_id=claimed.execution_id,
        )
        crashed_journal = JobGenerationJournal(
            context=crashed_context,
            step_path="generation",
            lock_dispatch=lambda db: get_job(db, job.id),
        )
        with Session(engine) as db:
            lock_generation_owner_in_current_transaction(db, owner)
            crashed_journal.prepare_admission(
                db,
                generation_id=generation_id,
                spec=spec,
                intent=intent,
            )
            db.commit()
        crashed_tools = _WorkerToolBoundary(
            inner=compose_deferred_generation_tool_executor(
                session_factory=factory,
                user_id=user_id,
                owner=owner,
                generation_id=generation_id,
                job_context=crashed_context,
                operation=operation,
            ),
            crash_after_receipt=True,
        )
        attempt_error: Exception | None = None
        try:
            await execute_generation(
                GenerationExecutionRequest(
                    owner=owner,
                    generation_id=generation_id,
                    spec=spec,
                    intent=intent,
                    journal=crashed_journal,
                    tool_executor=crashed_tools,
                ),
                session_factory=factory,
                runtime=runtime,
                encode_terminal=_encode_terminal,
                encode_preaccept_failure=_refuse_preaccept,
            )
        except Exception as error:
            # The queue worker fails its attempt on any exception; durable truth
            # below is what the reclaimed attempt inherits.
            attempt_error = error

        with Session(engine) as db:
            state = crashed_journal.read(db)
            pending = read_pending_generation_continuation_in_current_transaction(
                db,
                generation_id=generation_id,
                cipher=runtime.continuation_cipher,
            )
            turns_after_crash = read_model_turns(db, generation_id=generation_id)
            positions_after_crash = read_tool_positions(db, generation_id=generation_id)
        phase = None if state is None else state.dispatch_phase
        assert phase is Uncertain, (
            "generation dispatch did not persist the Uncertain checkpoint atomically: "
            f"generation {generation_id} journal is {phase!r} after its first accepted "
            f"child; the attempt ended with {attempt_error!r}"
        )
        assert isinstance(attempt_error, GenerationUncertain), attempt_error
        assert isinstance(attempt_error.__cause__, _WorkerCrash), attempt_error.__cause__
        assert isinstance(pending, PendingGenerationContinuation), (
            f"accepted child 1 of {generation_id} left no sealed successor continuation"
        )
        assert (pending.context.source_turn_seq, pending.context.successor_turn_seq) == (1, 2)
        assert [
            (turn.turn_seq, turn.usage is not None, turn.completed_at is not None)
            for turn in turns_after_crash
        ] == [(1, True, True)]
        assert [(position.path, position.replay_status) for position in positions_after_crash] == [
            ("generation/1/tool/1", "Completed")
        ]
        assert len(crashed_tools.receipts) == 1
        # The peer's fixture proposal omits required arguments, so the durable
        # receipt is the typed InvalidInput failure, not a handler effect.
        assert json.loads(crashed_tools.receipts[0].output) == {
            "type": "Failure",
            "error": {"type": "InvalidInput"},
        }

        with Session(engine) as db:
            expire_job_claim(db, job_id=job.id)
            db.commit()
            reclaimed = claim_job_row(
                db,
                job_id=job.id,
                worker_id="recovery-worker",
                lease_seconds=300,
                heavy_kinds=(),
            )
            assert reclaimed is not None and reclaimed.attempts == 2, reclaimed
            db.commit()
        recovery_context = JobExecutionContext(
            job_id=job.id,
            worker_id="recovery-worker",
            attempt_no=reclaimed.attempts,
            resource_class="Light",
            execution_id=reclaimed.execution_id,
        )
        recovery_journal = JobGenerationJournal(
            context=recovery_context,
            step_path="generation",
            lock_dispatch=lambda db: get_job(db, job.id),
        )
        recovery_tools = _WorkerToolBoundary(
            inner=compose_deferred_generation_tool_executor(
                session_factory=factory,
                user_id=user_id,
                owner=owner,
                generation_id=generation_id,
                job_context=recovery_context,
                operation=operation,
            ),
        )
        completed = await execute_generation(
            GenerationExecutionRequest(
                owner=owner,
                generation_id=generation_id,
                spec=spec,
                intent=intent,
                journal=recovery_journal,
                tool_executor=recovery_tools,
            ),
            session_factory=factory,
            runtime=runtime,
            encode_terminal=_encode_terminal,
            encode_preaccept_failure=_refuse_preaccept,
        )

    assert isinstance(completed, CompletedGeneration), completed
    assert (completed.terminal_result, completed.replayed) == ("provider:openai:tool-ok", False)
    assert [
        (receipt.provider_call_id, receipt.output, receipt.is_error)
        for receipt in recovery_tools.receipts
    ] == [
        (receipt.provider_call_id, receipt.output, receipt.is_error)
        for receipt in crashed_tools.receipts
    ], "the reclaimed attempt did not replay the exact landed tool receipt"
    with Session(engine) as db:
        final_state = recovery_journal.read(db)
        generation = read_generation(db, generation_id=generation_id)
        turns = read_model_turns(db, generation_id=generation_id)
        positions = read_tool_positions(db, generation_id=generation_id)
        model_turn_rows = db.scalar(
            select(func.count())
            .select_from(LLMModelTurn)
            .where(LLMModelTurn.generation_id == generation_id)
        )
        continuation_rows = db.scalar(
            select(func.count())
            .select_from(LLMModelTurnContinuation)
            .where(LLMModelTurnContinuation.generation_id == generation_id)
        )
    assert final_state is not None and final_state.dispatch_phase is Completed, final_state
    assert generation is not None and generation.outcome == "Succeeded"
    assert [turn.turn_seq for turn in turns] == [1, 2]
    assert model_turn_rows == 2
    assert (turns[0].id, turns[0].completed_at, turns[0].usage) == (
        turns_after_crash[0].id,
        turns_after_crash[0].completed_at,
        turns_after_crash[0].usage,
    ), "the reclaimed attempt re-landed the already accepted child 1"
    assert turns[1].usage is not None and turns[1].completed_at is not None
    assert continuation_rows == 0
    assert [
        (position.id, position.path, position.replay_status, position.completed_at)
        for position in positions
    ] == [
        (
            positions_after_crash[0].id,
            "generation/1/tool/1",
            "Completed",
            positions_after_crash[0].completed_at,
        )
    ]


class _WorkerCrash(RuntimeError):
    """The worker process dies right after its durable tool receipt lands."""


@dataclass(slots=True)
class _WorkerToolBoundary:
    """The worker's provider tool seam; the crashed attempt dies after its first receipt."""

    inner: BackendToolExecutor
    crash_after_receipt: bool = False
    receipts: list[BackendToolExecutionResult] = field(default_factory=list)

    async def execute(self, request: BackendToolExecutionRequest) -> BackendToolExecutionResult:
        receipt = await self.inner.execute(request)
        self.receipts.append(receipt)
        if self.crash_after_receipt:
            raise _WorkerCrash("worker died after landing the tool receipt")
        return receipt


@dataclass(frozen=True, slots=True)
class _FrozenProviderTools:
    operation: FrozenToolOperation

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools | None:
        plan = spec.model_tool_plan_snapshot
        assert isinstance(plan, Present), plan
        assert plan.value == freeze_tool_plan_snapshot(self.operation)
        return compose_provider_model_tools(self.operation)


def _fail_loud_tool_runtime() -> ComposedToolRuntime:
    async def unexpected(value: Any, context: Any) -> HandlerSuccess[Any]:
        del value, context
        raise AssertionError("the peer's fixture proposal must be refused before any handler")

    nexus_bindings = tuple(
        ToolBinding(
            spec=entry.spec,
            execute=Available(unexpected),
            replay_policy=ReplayPolicy.ReDispatchable,
            policy_epoch=PolicyEpoch("generation-execution-proof-v1"),
            policy_inputs={"owner": "generation-execution-proof"},
        )
        for entry in NEXUS_TOOL_DECLARATIONS
    )
    return compose_tool_runtime(
        ToolBinding(
            spec=WEB_SEARCH_SPEC,
            execute=Available(unexpected),
            replay_policy=ReplayPolicy.BilledOnce,
            policy_epoch=PolicyEpoch("generation-execution-proof-v1"),
            policy_inputs={"owner": "generation-execution-proof"},
        ),
        nexus_bindings=nexus_bindings,
    )


def _encode_terminal(terminal: BackendTerminal) -> EncodedGenerationTerminal:
    evidence = terminal.evidence
    assert isinstance(evidence, ProviderTerminalEvidence), evidence
    assert isinstance(evidence.outcome, ProviderSucceeded), evidence.outcome
    content = evidence.outcome.response.content
    assert isinstance(content, TextContent), content
    return EncodedGenerationTerminal(terminal_result=content.text)
