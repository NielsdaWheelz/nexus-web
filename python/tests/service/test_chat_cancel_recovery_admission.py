"""Cancelling accepted work must not need capacity for a new model dispatch."""

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import sessionmaker

from nexus.config import get_settings
from nexus.db.models import LLMModelTurnContinuation
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.llm import CapacityPaused, Ready
from nexus.schemas.presence import absent
from nexus.services import generation_policy
from nexus.services.chat_runs import cancel_chat_run, execute_chat_run, get_chat_run
from nexus.services.generation_catalog import (
    GenerationCatalogService,
    readiness_snapshot,
    source_controlled_qualification_snapshot,
)
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_service import GenerationService
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.llm_ledger import read_generation, read_model_turns
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.chat_generation_recovery import create_recoverable_chat
from tests.testkit.generation_catalog import (
    CHAT_CATALOG_NOW,
    CHAT_TEST_SELECTION,
    policy_complete_codex_catalog,
)
from tests.testkit.generation_tool_authority import controlled_tool_runtime
from tests.testkit.provider_generation import tool_decision_generation_backend


def test_cancelled_recovery_ignores_provider_and_inflight_admission(
    engine: Engine, committed_chat_state_isolation: None
) -> None:
    """A full inflight quota and unavailable provider cannot strand a safe cancellation."""
    del committed_chat_state_isolation
    asyncio.run(_prove_cancellation_without_dispatch_admission(engine))


async def _prove_cancellation_without_dispatch_admission(engine: Engine) -> None:
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    ready = Ready(last_checked=CHAT_CATALOG_NOW)
    provider_readiness: Ready | CapacityPaused = ready

    async def agent_catalog():
        return policy_complete_codex_catalog()

    async def load_readiness():
        return readiness_snapshot(
            observed_at=CHAT_CATALOG_NOW,
            routes={"CodexPersonal": ready, "ProviderApi:openai": provider_readiness},
        )

    catalog = GenerationCatalogService(
        configured_api_providers=("openai",),
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=agent_catalog,
        load_readiness=load_readiness,
        load_qualifications=source_controlled_qualification_snapshot,
        clock=lambda: CHAT_CATALOG_NOW,
    )
    tools = controlled_tool_runtime({})
    backend, peer = tool_decision_generation_backend(tools.operations["ChatRead"])
    runtime = ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=GenerationContinuationCipher(b"a" * 32),
        admission=GenerationService(
            catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
        ),
    )
    limiter = RateLimiter(session_factory=factory, concurrent_limit=1)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(limiter)
    try:
        with factory() as db:
            recovered = await create_recoverable_chat(
                db, catalog=catalog, tools=tools, runtime=runtime, accepted_children=1
            )
            chat = recovered.chat
            original_children = read_model_turns(db, generation_id=recovered.generation_id)
            db.commit()
            limiter.acquire_inflight_slot(chat.user_id)
            try:
                with pytest.raises(ApiError) as saturated:
                    limiter.check_concurrent_limit(chat.user_id)
                assert saturated.value.code == ApiErrorCode.E_RATE_LIMITED
                provider_readiness = CapacityPaused(
                    explanation="External provider quota is exhausted.",
                    reset_at=absent(),
                    next_check_at=CHAT_CATALOG_NOW + timedelta(minutes=1),
                    last_checked=CHAT_CATALOG_NOW,
                )
                snapshot = await catalog.operator_refresh()
                pair = snapshot.pair(CHAT_TEST_SELECTION)
                assert pair is not None and isinstance(pair.readiness, CapacityPaused)
                cancel_chat_run(
                    db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
                )
                try:
                    await execute_chat_run(
                        db,
                        run_id=chat.run_id,
                        job=recovered.job,
                        execution_context=recovered.context,
                        session_factory=factory,
                        runtime=runtime,
                        settings=get_settings(),
                    )
                except ApiError as error:
                    pytest.fail(f"cancelled recovery required a new inflight slot: {error.code}")
                public = get_chat_run(
                    db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
                )
                assert public.run.status == "cancelled" and public.stream_state.terminal, (
                    "cancelled recovery remained pending on provider dispatch readiness"
                )
                parent = read_generation(db, generation_id=recovered.generation_id)
                assert parent is not None and parent.outcome == "Cancelled"
                assert (
                    read_model_turns(db, generation_id=recovered.generation_id) == original_children
                )
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(LLMModelTurnContinuation)
                        .where(LLMModelTurnContinuation.generation_id == recovered.generation_id)
                    )
                    == 0
                )
                assert peer.dispatches == 1, "cancellation dispatched another paid model call"
                with pytest.raises(ApiError) as still_saturated:
                    limiter.check_concurrent_limit(chat.user_id)
                assert still_saturated.value.code == ApiErrorCode.E_RATE_LIMITED, (
                    "cancellation released another execution's inflight slot"
                )
            finally:
                limiter.release_inflight_slot(chat.user_id)
    finally:
        set_rate_limiter(previous_limiter)
