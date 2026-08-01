"""Real-Postgres recovery contracts for the durable chat-step journal."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    CATALOG,
    Absent,
    CallMeta,
    ContinuationArtifact,
    ContinuationDelta,
    PossiblyBillable,
    Present,
    ResponsePayload,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    TokenUsage,
    ToolCall,
    ToolCallDone,
    ToolCallStart,
)
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache, get_settings
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    claim_job,
    fail_job,
    get_job,
    update_running_job_payload,
)
from nexus.schemas.conversation import NewChatDestination
from nexus.schemas.presence import absent
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_run_steps import (
    AttachReconciledResult,
    ProveNotDispatched,
    reconcile_uncertain_chat_step,
)
from nexus.services.chat_runs import (
    PublishedChatExecution,
    cancel_chat_run,
    create_chat_run,
    execute_chat_run,
    get_chat_run,
)
from nexus.services.durable_step_journal import (
    Uncertain,
    payload_with_step_state,
    read_step_states,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _execution_dependencies(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    previous_limiter = get_rate_limiter()
    set_rate_limiter(
        RateLimiter(session_factory=cast(Any, task_session_factory(db_session)))
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-platform")
    clear_settings_cache()
    yield
    clear_settings_cache()
    set_rate_limiter(previous_limiter)


class _TextRuntime:
    def __init__(self, text_value: str = "Durable answer.") -> None:
        self.calls = 0
        self.text_value = text_value

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        raise AssertionError("chat must use streaming generation")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001
        self.calls += 1
        return self._events(intent)

    async def _events(self, intent) -> AsyncIterator[RuntimeStreamEvent]:  # noqa: ANN001
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(seq=2, event=TextDelta(self.text_value))
        yield RuntimeStreamEvent(
            seq=3,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=CallMeta(
                        provider=intent.target.provider,
                        model=intent.target.model,
                        provider_request_id=Present("req-chat-durable"),
                        upstream_provider=Absent(),
                        usage=Present(
                            TokenUsage(
                                input_tokens=20,
                                output_tokens=5,
                                total_tokens=25,
                                reasoning_tokens=Absent(),
                                cache_read_input_tokens=Absent(),
                                cache_write_input_tokens=Absent(),
                            )
                        ),
                        attempt_trace=(),
                        billability=PossiblyBillable(),
                    ),
                    response=ResponsePayload(
                        content=TextContent(text=self.text_value, tool_calls=()),
                        continuation=Absent(),
                    ),
                )
            ),
        )
class _DispatchCrashRuntime:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        raise AssertionError("chat must use streaming generation")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001
        self.calls += 1
        raise RuntimeError("simulated ambiguous provider dispatch")


class _NoDispatchRuntime(_DispatchCrashRuntime):
    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001
        self.calls += 1
        raise AssertionError("completed or uncertain step dispatched again")


class _LeaseLossRuntime(_TextRuntime):
    def __init__(self, lose_lease) -> None:  # noqa: ANN001
        super().__init__("must not become a durable delta")
        self._lose_lease = lose_lease

    async def _events(self, intent) -> AsyncIterator[RuntimeStreamEvent]:  # noqa: ANN001
        async for event in super()._events(intent):
            if event.seq == 2:
                self._lose_lease()
            yield event


class _AppSearchRuntime(_TextRuntime):
    async def _events(self, intent) -> AsyncIterator[RuntimeStreamEvent]:  # noqa: ANN001
        tool_call = ToolCall(
            id="app-search-1",
            name="app_search",
            arguments={
                "query": "nothing indexed",
                "kinds": None,
                "formats": None,
                "authors": None,
                "roles": None,
                "scopes": [],
            },
        )
        contract = CATALOG.chat_contract(intent.target)
        continuation = ContinuationArtifact(
            target=intent.target,
            codec_id=contract.continuation_codec,
            opaque_payload={
                "output": (
                    {
                        "id": f"{tool_call.id}-item",
                        "type": "function_call",
                        "call_id": tool_call.id,
                        "name": tool_call.name,
                        "arguments": (
                            '{"authors":null,"formats":null,"kinds":null,'
                            '"query":"nothing indexed","roles":null,"scopes":[]}'
                        ),
                    },
                )
            },
        )
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(
            seq=2,
            event=ToolCallStart(call_id=tool_call.id, name=tool_call.name),
        )
        yield RuntimeStreamEvent(seq=3, event=ToolCallDone(tool_call=tool_call))
        yield RuntimeStreamEvent(seq=4, event=ContinuationDelta(artifact=continuation))
        yield RuntimeStreamEvent(
            seq=5,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=CallMeta(
                        provider=intent.target.provider,
                        model=intent.target.model,
                        provider_request_id=Present("req-chat-tool"),
                        upstream_provider=Absent(),
                        usage=Absent(),
                        attempt_trace=(),
                        billability=PossiblyBillable(),
                    ),
                    response=ResponsePayload(
                        content=TextContent(text="", tool_calls=(tool_call,)),
                        continuation=Present(continuation),
                    ),
                )
            ),
        )


def _seed_claimed_chat(db: Session, *, worker_id: str) -> tuple[UUID, UUID, JobRow]:
    user_id = uuid4()
    ensure_user_and_default_library(db, user_id)
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="chat durable execution test",
        actor_label="test",
    )
    response = create_chat_run(
        db,
        viewer_id=user_id,
        destination=NewChatDestination(),
        reader_selection=None,
        content="Give a concise durable answer.",
        profile_id="balanced",
        reasoning_option_id="medium",
        idempotency_key=f"chat-durable-{uuid4()}",
    )
    run_id = response.run.id
    job_id = db.execute(
        text(
            "SELECT id FROM background_jobs "
            "WHERE kind = 'chat_run' AND dedupe_key = :dedupe_key"
        ),
        {"dedupe_key": f"chat_run:{run_id}"},
    ).scalar_one()
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None
    db.commit()
    return user_id, run_id, claimed


def _context(job: JobRow, worker_id: str) -> JobExecutionContext:
    return JobExecutionContext(
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=job.attempts,
    )


def _fail_and_reclaim(db: Session, job: JobRow, *, worker_id: str) -> JobRow:
    status = fail_job(
        db,
        job_id=job.id,
        worker_id=worker_id,
        error_code="E_TEST_CRASH",
        error_message="simulated crash",
        retry_delays_seconds=(0,),
    )
    assert status in {"failed", "dead"}
    db.commit()
    if status == "dead":
        dead = get_job(db, job.id)
        assert dead is not None
        return dead
    claimed = claim_job(
        db,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None
    db.commit()
    return claimed


async def _execute(db: Session, *, run_id: UUID, job: JobRow, worker_id: str, runtime):
    return await execute_chat_run(
        db,
        run_id=run_id,
        job=job,
        execution_context=_context(job, worker_id),
        session_factory=cast(Any, task_session_factory(db)),
        runtime=runtime,
        settings=get_settings(),
    )


async def test_completed_generation_replays_without_second_provider_dispatch(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_id = "chat-replay-worker"
    _user_id, run_id, first_job = _seed_claimed_chat(db_session, worker_id=worker_id)
    first_runtime = _TextRuntime()
    original_publish = __import__(
        "nexus.services.chat_runs", fromlist=["_publish_chat_run"]
    )._publish_chat_run

    def crash_before_publication(*_args, **_kwargs):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("simulated crash after completed generation")

    monkeypatch.setattr("nexus.services.chat_runs._publish_chat_run", crash_before_publication)
    with pytest.raises(RuntimeError, match="after completed generation"):
        await _execute(
            db_session,
            run_id=run_id,
            job=first_job,
            worker_id=worker_id,
            runtime=first_runtime,
        )
    assert first_runtime.calls == 1
    payload = db_session.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id"),
        {"job_id": first_job.id},
    ).scalar_one()
    assert payload["coordination"]["prepare"]["dispatch_phase"] == "Completed"
    assert payload["coordination"]["turn/0/generation"]["dispatch_phase"] == "Completed"

    replay_job = _fail_and_reclaim(db_session, first_job, worker_id=worker_id)
    monkeypatch.setattr("nexus.services.chat_runs._publish_chat_run", original_publish)
    no_dispatch = _NoDispatchRuntime()
    outcome = await _execute(
        db_session,
        run_id=run_id,
        job=replay_job,
        worker_id=worker_id,
        runtime=no_dispatch,
    )
    assert isinstance(outcome, PublishedChatExecution)
    assert no_dispatch.calls == 0
    assert db_session.execute(
        text("SELECT count(*) FROM llm_calls WHERE owner_kind = 'chat_run' AND owner_id = :id"),
        {"id": run_id},
    ).scalar_one() == 1
    assert db_session.execute(
        text(
            "SELECT count(*) FROM chat_run_events "
            "WHERE run_id = :id AND event_type = 'done'"
        ),
        {"id": run_id},
    ).scalar_one() == 1
    assert db_session.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id"),
        {"job_id": first_job.id},
    ).scalar_one() == {"run_id": str(run_id)}


async def test_completed_preparation_replays_exact_snapshot_without_reassembly(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nexus.services.chat_runs as chat_runs

    worker_id = "chat-prepare-replay-worker"
    _user_id, run_id, job = _seed_claimed_chat(db_session, worker_id=worker_id)
    original_dispatch = chat_runs._dispatch_generation_step

    async def crash_before_generation(*_args, **_kwargs):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("simulated crash after exact preparation")

    monkeypatch.setattr(chat_runs, "_dispatch_generation_step", crash_before_generation)
    with pytest.raises(RuntimeError, match="after exact preparation"):
        await _execute(
            db_session,
            run_id=run_id,
            job=job,
            worker_id=worker_id,
            runtime=_NoDispatchRuntime(),
        )
    stored = get_job(db_session, job.id)
    assert stored is not None
    states = read_step_states(stored)
    assert states["prepare"].dispatch_phase.value == "Completed"
    assert states["turn/0/generation"].dispatch_phase.value == "Prepared"

    replay_job = _fail_and_reclaim(db_session, stored, worker_id=worker_id)
    monkeypatch.setattr(chat_runs, "_dispatch_generation_step", original_dispatch)

    def reject_reassembly(*_args, **_kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError("completed preparation must be replayed, not reassembled")

    monkeypatch.setattr(chat_runs, "assemble_chat_context", reject_reassembly)
    outcome = await _execute(
        db_session,
        run_id=run_id,
        job=replay_job,
        worker_id=worker_id,
        runtime=_TextRuntime("Prepared snapshot answer."),
    )
    assert isinstance(outcome, PublishedChatExecution)
    assert db_session.execute(
        text("SELECT content FROM messages WHERE id = :message_id"),
        {"message_id": outcome.message_id},
    ).scalar_one() == "Prepared snapshot answer."


async def test_lost_lease_fences_stream_events_before_they_commit(
    db_session: Session,
) -> None:
    worker_id = "chat-lease-loss-worker"
    _user_id, run_id, job = _seed_claimed_chat(db_session, worker_id=worker_id)
    session_factory = cast(Any, task_session_factory(db_session))

    def lose_lease() -> None:
        with session_factory() as observer:
            observer.execute(
                text(
                    "UPDATE background_jobs SET status = 'dead', claimed_by = NULL, "
                    "lease_expires_at = NULL WHERE id = :job_id"
                ),
                {"job_id": job.id},
            )
            observer.commit()

    with pytest.raises(RuntimeError, match="lost its lease"):
        await _execute(
            db_session,
            run_id=run_id,
            job=job,
            worker_id=worker_id,
            runtime=_LeaseLossRuntime(lose_lease),
        )

    counts = dict(
        db_session.execute(
            text(
                "SELECT event_type, count(*) FROM chat_run_events "
                "WHERE run_id = :run_id GROUP BY event_type"
            ),
            {"run_id": run_id},
        ).all()
    )
    assert counts.get("assistant_activity") == 1
    assert counts.get("assistant_text_delta", 0) == 0
    assert counts.get("done", 0) == 0


async def test_uncertain_generation_suspends_then_operator_requeues_same_job(
    db_session: Session,
) -> None:
    worker_id = "chat-reconcile-worker"
    user_id, run_id, job = _seed_claimed_chat(db_session, worker_id=worker_id)
    crash = _DispatchCrashRuntime()
    with pytest.raises(RuntimeError, match="ambiguous provider dispatch"):
        await _execute(
            db_session,
            run_id=run_id,
            job=job,
            worker_id=worker_id,
            runtime=crash,
        )
    assert crash.calls == 1

    for _ in range(2):
        job = _fail_and_reclaim(db_session, job, worker_id=worker_id)
        if job.status == "dead":
            break
        no_dispatch = _NoDispatchRuntime()
        with pytest.raises(RuntimeError, match="uncertain external outcome"):
            await _execute(
                db_session,
                run_id=run_id,
                job=job,
                worker_id=worker_id,
                runtime=no_dispatch,
            )
        assert no_dispatch.calls == 0
    if job.status != "dead":
        job = _fail_and_reclaim(db_session, job, worker_id=worker_id)
    assert job.status == "dead"
    advisory = get_chat_run(db_session, viewer_id=user_id, run_id=run_id)
    assert advisory.run.status == "running"
    assert advisory.run.execution.model_dump(mode="json") == {
        "kind": "Present",
        "value": {"phase": "Suspended"},
    }

    reconcile_uncertain_chat_step(
        db_session,
        run_id=run_id,
        step_path="turn/0/generation",
        resolution=ProveNotDispatched(),
    )
    repaired = get_job(db_session, job.id)
    assert repaired is not None and repaired.status == "pending" and repaired.attempts == 0
    assert repaired.error_code == "E_TEST_CRASH"
    recovering = get_chat_run(db_session, viewer_id=user_id, run_id=run_id)
    assert recovering.run.execution.model_dump(mode="json") == {
        "kind": "Present",
        "value": {"phase": "Recovering"},
    }
    claimed = claim_job(
        db_session,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None and claimed.id == job.id and claimed.attempts == 1
    assert claimed.error_code == "E_TEST_CRASH"
    db_session.commit()
    recovering = get_chat_run(db_session, viewer_id=user_id, run_id=run_id)
    assert recovering.run.execution.model_dump(mode="json") == {
        "kind": "Present",
        "value": {"phase": "Recovering"},
    }
    runtime = _TextRuntime("Recovered answer.")
    outcome = await _execute(
        db_session,
        run_id=run_id,
        job=claimed,
        worker_id=worker_id,
        runtime=runtime,
    )
    assert isinstance(outcome, PublishedChatExecution)
    assert runtime.calls == 1


async def test_operator_attaches_reconciled_generation_without_redispatch(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_id = "chat-attach-worker"
    _user_id, run_id, job = _seed_claimed_chat(db_session, worker_id=worker_id)
    original_publish = __import__(
        "nexus.services.chat_runs", fromlist=["_publish_chat_run"]
    )._publish_chat_run

    def crash_before_publication(*_args, **_kwargs):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("simulated crash before publication")

    monkeypatch.setattr("nexus.services.chat_runs._publish_chat_run", crash_before_publication)
    with pytest.raises(RuntimeError, match="before publication"):
        await _execute(
            db_session,
            run_id=run_id,
            job=job,
            worker_id=worker_id,
            runtime=_TextRuntime("Reconciled answer."),
        )

    generation_path = "turn/0/generation"
    job = get_job(db_session, job.id)
    assert job is not None
    completed = read_step_states(job)[generation_path]
    assert completed.terminal_result.kind == "Present"
    reconciled_result = completed.terminal_result.value
    uncertain = completed.model_copy(
        update={"dispatch_phase": Uncertain, "terminal_result": absent()}
    )
    assert update_running_job_payload(
        db_session,
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=job.attempts,
        payload=payload_with_step_state(
            job.payload,
            step_path=generation_path,
            state=uncertain,
        ),
    )
    db_session.commit()
    job = get_job(db_session, job.id)
    assert job is not None
    while job.status != "dead":
        job = _fail_and_reclaim(db_session, job, worker_id=worker_id)

    db_session.execute(
        text(
            "UPDATE llm_calls SET outcome = 'failed' "
            "WHERE owner_kind = 'chat_run' AND owner_id = :run_id AND call_seq = 1"
        ),
        {"run_id": run_id},
    )
    db_session.commit()
    with pytest.raises(ValueError, match="disagrees with the LLM ledger"):
        reconcile_uncertain_chat_step(
            db_session,
            run_id=run_id,
            step_path=generation_path,
            resolution=AttachReconciledResult(terminal_result=reconciled_result),
        )
    db_session.execute(
        text(
            "UPDATE llm_calls SET outcome = 'succeeded' "
            "WHERE owner_kind = 'chat_run' AND owner_id = :run_id AND call_seq = 1"
        ),
        {"run_id": run_id},
    )
    db_session.commit()

    reconcile_uncertain_chat_step(
        db_session,
        run_id=run_id,
        step_path=generation_path,
        resolution=AttachReconciledResult(terminal_result=reconciled_result),
    )
    claimed = claim_job(
        db_session,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None and claimed.id == job.id
    db_session.commit()

    monkeypatch.setattr("nexus.services.chat_runs._publish_chat_run", original_publish)
    no_dispatch = _NoDispatchRuntime()
    outcome = await _execute(
        db_session,
        run_id=run_id,
        job=claimed,
        worker_id=worker_id,
        runtime=no_dispatch,
    )
    assert isinstance(outcome, PublishedChatExecution)
    assert no_dispatch.calls == 0
    assert db_session.execute(
        text("SELECT content FROM messages WHERE id = :message_id"),
        {"message_id": outcome.message_id},
    ).scalar_one() == "Reconciled answer."


async def test_completed_tool_replays_without_second_effect_or_result_event(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nexus.services.chat_runs as chat_runs

    worker_id = "chat-tool-replay-worker"
    _user_id, run_id, first_job = _seed_claimed_chat(db_session, worker_id=worker_id)
    original_execute_app_search = chat_runs.execute_app_search
    app_search_calls = 0

    def counted_app_search(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal app_search_calls
        app_search_calls += 1
        return original_execute_app_search(*args, **kwargs)

    original_complete_tool = chat_runs._complete_tool_step

    def complete_tool_then_crash(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        original_complete_tool(*args, **kwargs)
        raise RuntimeError("simulated crash after completed tool")

    monkeypatch.setattr(chat_runs, "execute_app_search", counted_app_search)
    monkeypatch.setattr(chat_runs, "_complete_tool_step", complete_tool_then_crash)
    first_runtime = _AppSearchRuntime()
    with pytest.raises(RuntimeError, match="after completed tool"):
        await _execute(
            db_session,
            run_id=run_id,
            job=first_job,
            worker_id=worker_id,
            runtime=first_runtime,
        )
    assert first_runtime.calls == 1
    assert app_search_calls == 1
    payload = db_session.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id"),
        {"job_id": first_job.id},
    ).scalar_one()
    assert payload["coordination"]["turn/0/tool/1"]["dispatch_phase"] == "Completed"

    replay_job = _fail_and_reclaim(db_session, first_job, worker_id=worker_id)
    monkeypatch.setattr(chat_runs, "_complete_tool_step", original_complete_tool)
    outcome = await _execute(
        db_session,
        run_id=run_id,
        job=replay_job,
        worker_id=worker_id,
        runtime=_TextRuntime("Answer after recovered tool."),
    )
    assert isinstance(outcome, PublishedChatExecution)
    assert app_search_calls == 1
    assert db_session.execute(
        text(
            "SELECT count(*) FROM message_tool_calls "
            "WHERE assistant_message_id = "
            "(SELECT assistant_message_id FROM chat_runs WHERE id = :run_id) "
            "AND tool_call_index = 1"
        ),
        {"run_id": run_id},
    ).scalar_one() == 1
    assert db_session.execute(
        text(
            "SELECT count(*) FROM chat_run_events "
            "WHERE run_id = :run_id AND event_type = 'tool_result'"
        ),
        {"run_id": run_id},
    ).scalar_one() == 1


async def test_cancel_requeues_suspended_job_only_to_fold_cancellation(
    db_session: Session,
) -> None:
    worker_id = "chat-cancel-worker"
    user_id, run_id, job = _seed_claimed_chat(db_session, worker_id=worker_id)
    with pytest.raises(RuntimeError, match="ambiguous provider dispatch"):
        await _execute(
            db_session,
            run_id=run_id,
            job=job,
            worker_id=worker_id,
            runtime=_DispatchCrashRuntime(),
        )
    for _ in range(2):
        job = _fail_and_reclaim(db_session, job, worker_id=worker_id)
        if job.status == "dead":
            break
        with pytest.raises(RuntimeError, match="uncertain external outcome"):
            await _execute(
                db_session,
                run_id=run_id,
                job=job,
                worker_id=worker_id,
                runtime=_NoDispatchRuntime(),
            )
    if job.status != "dead":
        job = _fail_and_reclaim(db_session, job, worker_id=worker_id)
    assert job.status == "dead"

    cancelled = cancel_chat_run(db_session, viewer_id=user_id, run_id=run_id)
    assert cancelled.run.cancel_requested_at is not None
    pending = get_job(db_session, job.id)
    assert pending is not None and pending.status == "pending" and pending.id == job.id
    claimed = claim_job(
        db_session,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None
    db_session.commit()
    no_dispatch = _NoDispatchRuntime()
    await _execute(
        db_session,
        run_id=run_id,
        job=claimed,
        worker_id=worker_id,
        runtime=no_dispatch,
    )
    assert no_dispatch.calls == 0
    assert get_chat_run(db_session, viewer_id=user_id, run_id=run_id).run.status == "cancelled"
    assert db_session.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id"),
        {"job_id": job.id},
    ).scalar_one() == {"run_id": str(run_id)}
