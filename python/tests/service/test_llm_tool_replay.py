"""Priority proof for position-aware Chat tool replay."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from uuid import UUID, uuid4

import pytest
from llm_tools import (
    PositionConflictDefect,
    RecoveryRequired,
    WebSearchRequest,
    WebSearchResponse,
    canonical_json_bytes,
)
from provider_runtime import (
    Absent,
    CallMeta,
    Present,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    ToolCallDone,
    ToolCallStart,
)
from provider_runtime.testing import ScriptedRuntime
from provider_runtime.types import (
    AttemptRecord,
    CodecStreamEvent,
    FinalAttempt,
    PossiblyBillable,
    ResponsePayload,
    ToolCall,
)
from pydantic_core import CoreSchema, core_schema
from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ChatRun, MessageToolCall, NoteBlock
from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    claim_job,
    fail_job,
    get_job,
    lock_running_job_claim,
)
from nexus.schemas.presence import Present as OwnedPresent
from nexus.schemas.presence import present
from nexus.services import bootstrap
from nexus.services.chat_run_steps import (
    AttachReconciledResult,
    ProveNotDispatched,
    reconcile_uncertain_chat_step,
)
from nexus.services.chat_runs import PublishedChatExecution, execute_chat_run
from nexus.services.durable_step_journal import (
    Completed,
    ToolExecutionSettlement,
    Uncertain,
    read_step_states,
)
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.resource_graph.context import add_context_ref_without_commit
from nexus.services.resource_graph.refs import ResourceRef
from tests.testkit.chat import create_entitled_chat
from tests.testkit.llm_tool_scenarios import create_readable_media
from tests.testkit.unreachable_state import (
    make_failed_job_retryable,
    replace_completed_chat_prepare_admitted_resource_uris,
    replace_completed_chat_tool_arguments,
    replace_completed_chat_tool_terminal,
    set_pending_job_max_attempts,
)

_BALANCED_PROFILE = lookup_profile("balanced")
assert _BALANCED_PROFILE is not None


class _SchemaCompatibleProviderDouble:
    """Let the production Presence constructor carry this opaque test adapter."""

    @classmethod
    def __get_pydantic_core_schema__(
        cls,
        _source_type: object,
        _handler: object,
    ) -> CoreSchema:
        return core_schema.is_instance_schema(cls)


class _CancelledWebSearch(_SchemaCompatibleProviderDouble):
    """A provider adapter with an independently observable transport boundary."""

    def __init__(self, *, cross_transport: bool) -> None:
        self.adapter_calls = 0
        self.transport_dispatches = 0
        self.cross_transport = cross_transport

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.adapter_calls += 1
        if self.cross_transport:
            self.transport_dispatches += 1
        del request
        raise asyncio.CancelledError


class _NeverSearch(_SchemaCompatibleProviderDouble):
    def __init__(self) -> None:
        self.calls = 0

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.calls += 1
        raise AssertionError(f"uncertain billed search was automatically reissued: {request!r}")


def _provider_success(tool_calls: Sequence[ToolCall], *, text: str = "") -> Succeeded:
    return Succeeded(
        meta=CallMeta(
            provider=_BALANCED_PROFILE.target.provider,
            model=_BALANCED_PROFILE.target.model,
            provider_request_id=Present(f"req-tool-replay-{uuid4()}"),
            upstream_provider=Absent(),
            usage=Absent(),
            attempt_trace=(
                AttemptRecord(
                    attempt=1,
                    signal=FinalAttempt(),
                    status_code=Present(200),
                    started_at_ms=0,
                    ended_at_ms=1,
                ),
            ),
            billability=PossiblyBillable(),
            native_reasoning=Present("medium"),
            registry_revision="tool-replay-proof-v1",
        ),
        response=ResponsePayload(
            content=TextContent(text=text, tool_calls=tuple(tool_calls)),
            continuation=Absent(),
        ),
    )


def _tool_turn(*tool_calls: ToolCall) -> tuple[CodecStreamEvent, ...]:
    events: list[CodecStreamEvent] = [StreamStart()]
    for call in tool_calls:
        events.extend(
            (
                ToolCallStart(call_id=call.id, name=call.name),
                ToolCallDone(tool_call=call),
            )
        )
    events.append(TerminalEvent(outcome=_provider_success(tool_calls)))
    return tuple(events)


def _text_turn(text: str) -> tuple[CodecStreamEvent, ...]:
    return (
        StreamStart(),
        TextDelta(text=text),
        TerminalEvent(outcome=_provider_success((), text=text)),
    )


def _reconciled_web_success(*, hit_count: int = 1) -> str:
    return canonical_json_bytes(
        {
            "type": "Success",
            "value": {
                "evidence": {
                    "provider": "brave",
                    "provider_request_id": "reconciled-response-request",
                    "type": "web.search",
                },
                "observed_at": "2026-08-17T19:00:00Z",
                "provider": "brave",
                "provider_request_id": "reconciled-response-request",
                "results": [
                    {
                        "display_url": "example.test/reconciled",
                        "extra_snippets": ["Independent operator evidence."],
                        "provider": "brave",
                        "provider_request_id": "reconciled-item-request",
                        "published_at": "2026-08-17T18:00:00Z",
                        "rank": rank,
                        "result_ref": (
                            "reconciled-provider-result"
                            if rank == 1
                            else f"reconciled-provider-result-{rank}"
                        ),
                        "snippet": "The paid request completed before worker loss.",
                        "source_name": "Example",
                        "title": "Reconciled search evidence",
                        "url": "https://example.test/reconciled",
                    }
                    for rank in range(1, hit_count + 1)
                ],
            },
        }
    ).decode("utf-8")


def _invalid_json_arguments(marker: str) -> dict[str, object]:
    nested: dict[str, object] = {"marker": marker}
    for _ in range(65):
        nested = {"child": nested}
    return nested


def _claim_chat(db: Session, *, job_id: UUID, worker_id: str) -> tuple[JobRow, JobExecutionContext]:
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=(),
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None, f"Chat job {job_id} was not claimable by {worker_id}"
    context = JobExecutionContext(
        job_id=claimed.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Light",
    )
    db.commit()
    return claimed, context


def _tool_rows(db: Session, *, assistant_message_id: UUID) -> list[MessageToolCall]:
    return list(
        db.scalars(
            select(MessageToolCall)
            .where(MessageToolCall.assistant_message_id == assistant_message_id)
            .order_by(MessageToolCall.tool_call_index)
        )
    )


def test_position_replay_settles_once_and_does_not_automatically_reissue_uncertain_billed_search(
    engine: Engine,
) -> None:
    """Protect durable writes and paid search across worker loss and replay."""

    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            chat = create_entitled_chat(
                db,
                content="Inspect the admitted source, capture one note, then research the Web.",
            )
            default_library_id = bootstrap.ensure_user_and_default_library(db, chat.user_id)
            media_id = create_readable_media(
                db,
                user_id=chat.user_id,
                default_library_id=default_library_id,
                title="Replay-safe source",
                canonical_text="A durable source used by the replay proof.",
            )
            media_uri = f"media:{media_id}"
            add_context_ref_without_commit(
                db,
                viewer_id=chat.user_id,
                conversation_id=chat.conversation_id,
                target=ResourceRef(scheme="media", id=media_id),
                origin="user",
            )
            set_pending_job_max_attempts(db, job_id=chat.job_id, max_attempts=1)
            db.commit()
            first_job, first_context = _claim_chat(
                db,
                job_id=chat.job_id,
                worker_id="tool-replay-first",
            )
            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            note_text = f"One replay-safe note {uuid4()}"
            calls = (
                ToolCall(
                    id="malformed-a",
                    name="nexus__search",
                    arguments=_invalid_json_arguments("a"),
                ),
                ToolCall(
                    id="malformed-b",
                    name="nexus__search",
                    arguments=_invalid_json_arguments("b"),
                ),
                ToolCall(
                    id="read",
                    name="nexus__resource__inspect",
                    arguments={"uri": media_uri},
                ),
                ToolCall(
                    id="write",
                    name="nexus__note__create",
                    arguments={"markdown": note_text, "page_uri": None},
                ),
                ToolCall(
                    id="invalid-web-search",
                    name="web__search",
                    arguments={},
                ),
                ToolCall(
                    id="pre-boundary-search",
                    name="web__search",
                    arguments={"query": "position-aware tool replay", "freshness_days": None},
                ),
            )
            generation = ScriptedRuntime(stream_scripts=(_tool_turn(*calls),))
            pre_boundary = _CancelledWebSearch(cross_transport=False)

            with pytest.raises(asyncio.CancelledError):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=chat.run_id,
                        job=first_job,
                        execution_context=first_context,
                        session_factory=session_factory,
                        runtime=generation,
                        settings=get_settings(),
                        web_search_provider=pre_boundary,
                    )
                )

            assert pre_boundary.adapter_calls == 1
            assert pre_boundary.transport_dispatches == 0, (
                "the test may use ProveNotDispatched only when its transport oracle stayed zero"
            )
            assert [call.operation for call in generation.calls] == ["stream"]
            rows_before = _tool_rows(db, assistant_message_id=run.assistant_message_id)
            assert tuple(row.canonical_tool_id for row in rows_before) == (
                "nexus.search",
                "nexus.search",
                "nexus.resource.inspect",
                "nexus.note.create",
                "web.search",
                "web.search",
            )
            malformed_rows = rows_before[:2]
            assert tuple(
                (row.record_kind, row.status, row.error_code) for row in malformed_rows
            ) == (
                ("current_execution", "error", "InvalidInput"),
                ("current_execution", "error", "InvalidInput"),
            )
            malformed_digests = tuple(row.canonical_input_sha256 for row in malformed_rows)
            assert None not in malformed_digests
            assert malformed_digests[0] != malformed_digests[1], (
                "distinct invalid provider arguments collapsed to one replay identity"
            )
            assert tuple(row.tool_call_index for row in malformed_rows) == (1, 2), (
                "known invalid inputs did not occupy distinct current executions"
            )
            assert (
                rows_before[4].record_kind,
                rows_before[4].status,
                rows_before[4].error_code,
            ) == ("current_execution", "error", "InvalidInput")
            note_count_before = int(
                db.scalar(
                    select(func.count())
                    .select_from(NoteBlock)
                    .where(NoteBlock.user_id == chat.user_id, NoteBlock.body_text == note_text)
                )
                or 0
            )
            assert note_count_before == 1
            completed_ids_before = tuple(row.id for row in rows_before[:5])
            note_refs_before = tuple(rows_before[3].result_refs)
            input_digests_before = tuple(row.canonical_input_sha256 for row in rows_before)

            persisted = get_job(db, chat.job_id)
            assert persisted is not None
            states = read_step_states(persisted)
            assert tuple(
                states[f"turn/0/tool/{index}"].dispatch_phase for index in range(1, 7)
            ) == (
                Completed,
                Completed,
                Completed,
                Completed,
                Completed,
                Uncertain,
            )
            invalid_states = (states["turn/0/tool/1"], states["turn/0/tool/2"])
            assert all(isinstance(state.tool_execution, OwnedPresent) for state in invalid_states)
            assert (
                tuple(
                    state.tool_execution.value.identity.input_digest
                    for state in invalid_states
                    if isinstance(state.tool_execution, OwnedPresent)
                )
                == malformed_digests
            )
            effect_id_before = states["turn/0/tool/4"].generation_id

            original_admission = replace_completed_chat_prepare_admitted_resource_uris(
                db,
                job_id=chat.job_id,
                admitted_resource_uris=(media_uri, f"media:{uuid4()}"),
            )
            db.commit()
            tampered_job = get_job(db, chat.job_id)
            assert tampered_job is not None
            tampered_runtime = ScriptedRuntime()
            tampered_provider = _NeverSearch()
            with pytest.raises(AssertionError, match="request fingerprint"):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=chat.run_id,
                        job=tampered_job,
                        execution_context=first_context,
                        session_factory=session_factory,
                        runtime=tampered_runtime,
                        settings=get_settings(),
                        web_search_provider=tampered_provider,
                    )
                )
            assert tampered_runtime.calls == []
            assert tampered_provider.calls == 0
            replace_completed_chat_prepare_admitted_resource_uris(
                db,
                job_id=chat.job_id,
                admitted_resource_uris=original_admission,
            )
            db.commit()

            assert (
                fail_job(
                    db,
                    job_id=chat.job_id,
                    worker_id=first_context.worker_id,
                    error_code="E_WORKER_INTERRUPTED",
                    error_message="cancelled before the Web transport boundary",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()

            reconcile_uncertain_chat_step(
                db,
                run_id=chat.run_id,
                step_path="turn/0/tool/6",
                resolution=ProveNotDispatched(),
            )
            replace_completed_chat_tool_arguments(
                db,
                job_id=chat.job_id,
                tool_call_index=6,
                arguments={"query": "changed invocation", "freshness_days": None},
            )
            db.commit()
            retry_job, retry_context = _claim_chat(
                db,
                job_id=chat.job_id,
                worker_id="tool-replay-second",
            )
            assert not lock_running_job_claim(db, context=first_context), (
                "the public queue fence accepted a stale worker after reclaim"
            )

            changed_input_provider = _NeverSearch()
            with pytest.raises(PositionConflictDefect, match="different invocation"):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=chat.run_id,
                        job=retry_job,
                        execution_context=retry_context,
                        session_factory=session_factory,
                        runtime=ScriptedRuntime(),
                        settings=get_settings(),
                        web_search_provider=changed_input_provider,
                    )
                )
            assert changed_input_provider.calls == 0

            rows_after = _tool_rows(db, assistant_message_id=run.assistant_message_id)
            assert tuple(row.id for row in rows_after[:5]) == completed_ids_before
            assert tuple(rows_after[3].result_refs) == note_refs_before
            assert tuple(row.canonical_input_sha256 for row in rows_after) == input_digests_before
            replayed_job = get_job(db, chat.job_id)
            assert replayed_job is not None
            assert read_step_states(replayed_job)["turn/0/tool/4"].generation_id == effect_id_before
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(NoteBlock)
                    .where(NoteBlock.user_id == chat.user_id, NoteBlock.body_text == note_text)
                )
                == 1
            ), "completed write replay duplicated its stable child"

            crossed_chat = create_entitled_chat(
                db,
                content="Search once; never retry an ambiguous paid request.",
            )
            set_pending_job_max_attempts(db, job_id=crossed_chat.job_id, max_attempts=2)
            db.commit()
            crossed_job, crossed_context = _claim_chat(
                db,
                job_id=crossed_chat.job_id,
                worker_id="billed-search-first",
            )
            crossed_call = ToolCall(
                id="crossed-search",
                name="web__search",
                arguments={"query": "uncertain billed search", "freshness_days": None},
            )
            crossed_provider = _CancelledWebSearch(cross_transport=True)
            with pytest.raises(asyncio.CancelledError):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=crossed_chat.run_id,
                        job=crossed_job,
                        execution_context=crossed_context,
                        session_factory=session_factory,
                        runtime=ScriptedRuntime(stream_scripts=(_tool_turn(crossed_call),)),
                        settings=get_settings(),
                        web_search_provider=crossed_provider,
                    )
                )
            assert (crossed_provider.adapter_calls, crossed_provider.transport_dispatches) == (1, 1)
            assert (
                fail_job(
                    db,
                    job_id=crossed_chat.job_id,
                    worker_id=crossed_context.worker_id,
                    error_code="E_WORKER_INTERRUPTED",
                    error_message="provider boundary may have received the paid request",
                    retry_delays_seconds=(0,),
                )
                == "failed"
            )
            db.commit()
            make_failed_job_retryable(db, job_id=crossed_chat.job_id)
            db.commit()
            crossed_retry_job, crossed_retry_context = _claim_chat(
                db,
                job_id=crossed_chat.job_id,
                worker_id="billed-search-second",
            )
            forbidden_retry = _NeverSearch()
            with pytest.raises(RecoveryRequired, match="uncertain outcome"):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=crossed_chat.run_id,
                        job=crossed_retry_job,
                        execution_context=crossed_retry_context,
                        session_factory=session_factory,
                        runtime=ScriptedRuntime(),
                        settings=get_settings(),
                        web_search_provider=forbidden_retry,
                    )
                )
            assert forbidden_retry.calls == 0
            crossed_persisted = get_job(db, crossed_chat.job_id)
            assert crossed_persisted is not None
            crossed_state = read_step_states(crossed_persisted)["turn/0/tool/1"]
            assert crossed_state.dispatch_phase is Uncertain

            assert (
                fail_job(
                    db,
                    job_id=crossed_chat.job_id,
                    worker_id=crossed_retry_context.worker_id,
                    error_code="E_TOOL_RECONCILIATION_REQUIRED",
                    error_message="operator evidence is required for the paid request",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()

            reconciled_result = _reconciled_web_success()
            exact_settlement = ToolExecutionSettlement(
                actual_attempts=1,
                actual_output_bytes=len(reconciled_result.encode("utf-8")),
            )
            invalid_result_value = json.loads(reconciled_result)
            invalid_result_value["unexpected"] = True
            invalid_result = canonical_json_bytes(invalid_result_value).decode("utf-8")
            with pytest.raises(ValueError, match="portable tool result"):
                reconcile_uncertain_chat_step(
                    db,
                    run_id=crossed_chat.run_id,
                    step_path="turn/0/tool/1",
                    resolution=AttachReconciledResult(
                        terminal_result=invalid_result,
                        tool_settlement=present(
                            ToolExecutionSettlement(
                                actual_attempts=1,
                                actual_output_bytes=len(invalid_result.encode("utf-8")),
                            )
                        ),
                    ),
                )
            with pytest.raises(ValueError, match="settlement"):
                reconcile_uncertain_chat_step(
                    db,
                    run_id=crossed_chat.run_id,
                    step_path="turn/0/tool/1",
                    resolution=AttachReconciledResult(
                        terminal_result=reconciled_result,
                        tool_settlement=present(
                            exact_settlement.model_copy(
                                update={
                                    "actual_output_bytes": exact_settlement.actual_output_bytes + 1
                                }
                            )
                        ),
                    ),
                )
            policy_violating_result = _reconciled_web_success(hit_count=7)
            with pytest.raises(ValueError, match="binding policy"):
                reconcile_uncertain_chat_step(
                    db,
                    run_id=crossed_chat.run_id,
                    step_path="turn/0/tool/1",
                    resolution=AttachReconciledResult(
                        terminal_result=policy_violating_result,
                        tool_settlement=present(
                            ToolExecutionSettlement(
                                actual_attempts=1,
                                actual_output_bytes=len(policy_violating_result.encode("utf-8")),
                            )
                        ),
                    ),
                )

            reconcile_uncertain_chat_step(
                db,
                run_id=crossed_chat.run_id,
                step_path="turn/0/tool/1",
                resolution=AttachReconciledResult(
                    terminal_result=reconciled_result,
                    tool_settlement=present(exact_settlement),
                ),
            )
            attached_job = get_job(db, crossed_chat.job_id)
            assert attached_job is not None and attached_job.status == "pending"
            attached_state = read_step_states(attached_job)["turn/0/tool/1"]
            assert attached_state.dispatch_phase is Completed
            assert isinstance(attached_state.tool_execution, OwnedPresent)
            attached_execution = attached_state.tool_execution.value
            assert isinstance(attached_execution.settlement, OwnedPresent)
            assert attached_execution.settlement.value == exact_settlement
            assert not isinstance(attached_execution.dispatch_claim, OwnedPresent)
            assert isinstance(attached_state.terminal_result, OwnedPresent)
            assert attached_state.terminal_result.value == reconciled_result

            crossed_run = db.get(ChatRun, crossed_chat.run_id)
            assert crossed_run is not None
            attached_projection = db.execute(
                select(
                    MessageToolCall.id,
                    MessageToolCall.status,
                    MessageToolCall.provider_request_ids,
                    MessageToolCall.result_refs,
                ).where(
                    MessageToolCall.assistant_message_id == crossed_run.assistant_message_id,
                    MessageToolCall.tool_call_index == 1,
                )
            ).one()
            assert attached_projection.status == "complete"
            assert attached_projection.provider_request_ids == ["reconciled-response-request"]
            assert attached_projection.result_refs[0]["result_ref"] == (
                "reconciled-provider-result"
            )
            attached_facts = (
                db.execute(
                    text(
                        """
                    SELECT snapshot.id AS snapshot_id,
                           retrieval.source_id,
                           retrieval.result_ref->>'result_ref' AS provider_result_ref,
                           event.payload AS result_event
                    FROM message_tool_calls AS tool
                    JOIN message_retrievals AS retrieval
                      ON retrieval.tool_call_id = tool.id
                    JOIN resource_external_snapshots AS snapshot
                      ON CAST(snapshot.id AS text) = retrieval.source_id
                    JOIN chat_run_events AS event
                      ON event.run_id = :run_id
                     AND event.event_type = 'tool_result'
                     AND event.payload->>'tool_call_id' = CAST(tool.id AS text)
                    WHERE tool.id = :tool_call_id
                    """
                    ),
                    {
                        "run_id": crossed_chat.run_id,
                        "tool_call_id": attached_projection.id,
                    },
                )
                .mappings()
                .one()
            )
            assert attached_facts.source_id == str(attached_facts.snapshot_id)
            assert attached_facts.provider_result_ref == "reconciled-provider-result"
            assert attached_facts.result_event["record_kind"] == "current_execution"
            assert attached_facts.result_event["canonical_tool_id"] == "web.search"
            assert attached_facts.result_event["status"] == "complete"

            stored_terminal = replace_completed_chat_tool_terminal(
                db,
                job_id=crossed_chat.job_id,
                step_path="turn/0/tool/1",
                terminal_result=policy_violating_result,
            )
            db.commit()
            invalid_replay_job, invalid_replay_context = _claim_chat(
                db,
                job_id=crossed_chat.job_id,
                worker_id="billed-search-invalid-replay",
            )
            invalid_replay_provider = _NeverSearch()
            invalid_replay_runtime = ScriptedRuntime()
            with pytest.raises(AssertionError, match="binding policy"):
                asyncio.run(
                    execute_chat_run(
                        db,
                        run_id=crossed_chat.run_id,
                        job=invalid_replay_job,
                        execution_context=invalid_replay_context,
                        session_factory=session_factory,
                        runtime=invalid_replay_runtime,
                        settings=get_settings(),
                        web_search_provider=invalid_replay_provider,
                    )
                )
            assert invalid_replay_provider.calls == 0
            assert invalid_replay_runtime.calls == []
            assert (
                fail_job(
                    db,
                    job_id=crossed_chat.job_id,
                    worker_id=invalid_replay_context.worker_id,
                    error_code="E_TOOL_POLICY_INVALID",
                    error_message="stored tool result violates the frozen binding policy",
                    retry_delays_seconds=(0,),
                )
                == "failed"
            )
            replace_completed_chat_tool_terminal(
                db,
                job_id=crossed_chat.job_id,
                step_path="turn/0/tool/1",
                terminal_result=stored_terminal,
            )
            make_failed_job_retryable(db, job_id=crossed_chat.job_id)
            db.commit()

            reconciled_job, reconciled_context = _claim_chat(
                db,
                job_id=crossed_chat.job_id,
                worker_id="billed-search-reconciled",
            )
            replay_provider = _NeverSearch()
            replay_runtime = ScriptedRuntime(
                stream_scripts=(_text_turn("The reconciled evidence is available."),)
            )
            outcome = asyncio.run(
                execute_chat_run(
                    db,
                    run_id=crossed_chat.run_id,
                    job=reconciled_job,
                    execution_context=reconciled_context,
                    session_factory=session_factory,
                    runtime=replay_runtime,
                    settings=get_settings(),
                    web_search_provider=replay_provider,
                )
            )
            assert isinstance(outcome, PublishedChatExecution)
            assert replay_provider.calls == 0
            assert [call.operation for call in replay_runtime.calls] == ["stream"]
            replayed_projection = _tool_rows(
                db,
                assistant_message_id=crossed_run.assistant_message_id,
            )
            assert len(replayed_projection) == 1
            assert replayed_projection[0].id == attached_projection.id
            assert (
                db.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM message_retrievals AS retrieval
                        JOIN resource_external_snapshots AS snapshot
                          ON CAST(snapshot.id AS text) = retrieval.source_id
                        WHERE retrieval.tool_call_id = :tool_call_id
                        """
                    ),
                    {"tool_call_id": attached_projection.id},
                ).scalar_one()
                == 1
            )
            assert (
                db.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM chat_run_events
                        WHERE run_id = :run_id
                          AND event_type = 'tool_result'
                          AND payload->>'tool_call_id' = :tool_call_id
                        """
                    ),
                    {
                        "run_id": crossed_chat.run_id,
                        "tool_call_id": str(attached_projection.id),
                    },
                ).scalar_one()
                == 1
            )
    finally:
        set_rate_limiter(previous_limiter)
