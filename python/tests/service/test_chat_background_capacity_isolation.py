"""A stalled background claim cannot spend the foreground chat lane's capacity.

The cutover's separate-lane contract is the oracle. The real queue holds one
Synapse attempt running throughout admission and publication; process death and
stale-owner fencing remain in their existing worker proofs. Only the external
provider response is scripted.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Present,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
)
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import (
    AttemptRecord,
    CancelSignal,
    FinalAttempt,
    GenerateIntent,
    PossiblyBillable,
    ResponsePayload,
    RuntimeStreamEvent,
)
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Page
from nexus.db.session import create_session_factory, get_repeatable_read_db
from nexus.job_topology import BACKGROUND_WORKER_JOB_KINDS, INTERACTIVE_WORKER_JOB_KINDS
from nexus.jobs.queue import JobExecutionContext, complete_job, enqueue_job, get_job
from nexus.schemas.conversation import NewChatDestination
from nexus.services import generation_policy
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_runs import (
    PublishedChatExecution,
    create_chat_run,
    execute_chat_run,
    get_chat_run,
)
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_service import GenerationService
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime
from tests.testkit.provider_generation import provider_generation_backend
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.unreachable_state import delete_jobs_by_ids

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


def test_running_background_claim_does_not_block_foreground_chat_publication(
    engine: Engine,
) -> None:
    asyncio.run(_prove_background_capacity_isolation(engine))


async def _prove_background_capacity_isolation(engine: Engine) -> None:
    owner, command_key = uuid4(), str(uuid4())
    session_factory = create_session_factory(engine)
    with Session(engine) as db:
        ensure_user_and_default_library(db, owner, f"lane-isolation-{owner}@example.invalid")
        grant_entitlement_override(
            db,
            user_id=owner,
            plan_tier="ai_pro",
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="foreground lane isolation proof",
            actor_label="nexus-test",
        )
        page = Page(user_id=owner, title="Background source")
        db.add(page)
        db.flush()
        background_job = enqueue_job(
            db,
            kind="synapse_scan",
            payload={"user_id": str(owner), "ref": f"page:{page.id}", "reason": "page_edit"},
        )
        background_claim = claim_job_row(
            db,
            job_id=background_job.id,
            worker_id=f"background-{owner}",
            lease_seconds=300,
            heavy_kinds=(),
            allowed_kinds=BACKGROUND_WORKER_JOB_KINDS,
        )
        assert background_claim is not None and background_claim.status == "running"
        db.commit()

    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    tools = compose_available_product_tool_runtime()
    answer = "Foreground published while background remained stalled."
    runtime = ComposedExecutionRuntime(
        backend=provider_generation_backend(
            tools.operations["ChatRead"], _ForegroundProvider(answer)
        ),
        continuation_cipher=GenerationContinuationCipher(b"a" * 32),
        admission=GenerationService(
            catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
        ),
    )
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            receipt = await create_chat_run(
                db,
                viewer_id=owner,
                destination=NewChatDestination(),
                reader_selection=None,
                content="Publish despite the running background claim.",
                catalog_definition_revision=snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=tools,
                idempotency_key=command_key,
            )
            receipt_wire = receipt.model_dump(mode="json")
            admission = receipt_wire.get("outcome")
            assert isinstance(admission, dict) and admission.get("kind") == "Accepted", (
                f"running background job {background_claim.id} consumed foreground chat capacity: "
                f"command={command_key}, receipt={receipt_wire!r}"
            )
            run_id = UUID(admission["run_id"])
            chat_job_id = db.scalar(
                text("SELECT id FROM background_jobs WHERE dedupe_key=:key"),
                {"key": f"chat_run:{run_id}"},
            )
            assert chat_job_id is not None
            worker_id = f"foreground-{owner}"
            chat_claim = claim_job_row(
                db,
                job_id=chat_job_id,
                worker_id=worker_id,
                lease_seconds=300,
                heavy_kinds=(),
                allowed_kinds=INTERACTIVE_WORKER_JOB_KINDS,
            )
            assert chat_claim is not None, f"foreground run {run_id} could not claim its own lane"
            db.commit()
            outcome = await execute_chat_run(
                db,
                run_id=run_id,
                job=chat_claim,
                execution_context=JobExecutionContext(
                    job_id=chat_claim.id,
                    worker_id=worker_id,
                    attempt_no=chat_claim.attempts,
                    resource_class="Light",
                    execution_id=chat_claim.execution_id,
                ),
                session_factory=session_factory,
                runtime=runtime,
                settings=get_settings(),
            )
            assert isinstance(outcome, PublishedChatExecution), (
                f"foreground run {run_id} did not publish beside {background_claim.id}: {outcome!r}"
            )
            assert complete_job(
                db,
                job_id=chat_claim.id,
                worker_id=worker_id,
                attempt_no=chat_claim.attempts,
            )
            db.commit()
            with Session(engine) as read_db:
                get_repeatable_read_db(read_db)
                response = get_chat_run(
                    read_db, viewer_id=owner, run_id=run_id, catalog_snapshot=snapshot
                )
                assert response.run.status == "complete"
                assert response.assistant_message.message_document.model_dump(mode="json") == {
                    "type": "message_document",
                    "blocks": [{"type": "text", "format": "markdown", "text": answer}],
                }
                assert get_job(read_db, background_claim.id) == background_claim, (
                    f"foreground run {run_id} changed the unrelated running claim "
                    f"{background_claim.id}"
                )
    finally:
        set_rate_limiter(previous_limiter)
        with Session(engine) as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=(background_claim.id,))
            cleanup.commit()


class _ForegroundProvider:
    """Only the external model terminal is controlled; all execution owners are real."""

    def __init__(self, answer: str) -> None:
        self.answer = answer

    async def stream(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> AsyncIterator[RuntimeStreamEvent]:
        del cancel
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(seq=2, event=TextDelta(text=self.answer))
        yield RuntimeStreamEvent(
            seq=3,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=CallMeta(
                        provider=intent.target.provider,
                        model=intent.target.model,
                        provider_request_id=Present("foreground-lane-proof"),
                        upstream_provider=Absent(),
                        usage=Absent(),
                        billability=PossiblyBillable(),
                        native_reasoning=Present(intent.reasoning),
                        registry_revision=api_model_catalog().registry_revision,
                        attempt_trace=(
                            AttemptRecord(
                                attempt=1,
                                signal=FinalAttempt(),
                                status_code=Present(200),
                                started_at_ms=0,
                                ended_at_ms=1,
                            ),
                        ),
                    ),
                    response=ResponsePayload(
                        content=TextContent(text=self.answer, tool_calls=()), continuation=Absent()
                    ),
                )
            ),
        )
