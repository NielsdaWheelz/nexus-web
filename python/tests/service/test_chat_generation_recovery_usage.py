"""Chat recovery retains original paid child usage and retires cancelled continuations."""

from __future__ import annotations

import asyncio
from typing import Literal, cast

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import sessionmaker

from nexus.config import get_settings
from nexus.db.models import ChatRunEvent, LLMModelTurnContinuation
from nexus.services import generation_policy
from nexus.services.chat_runs import (
    cancel_chat_run,
    execute_chat_run,
    get_chat_run,
)
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_service import GenerationService
from nexus.services.llm_execution import (
    ComposedExecutionRuntime,
)
from nexus.services.llm_ledger import (
    read_generation,
    read_model_turns,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.tool_authority import (
    read_tool_positions,
)
from tests.testkit.chat_generation_recovery import create_recoverable_chat
from tests.testkit.generation_catalog import configured_chat_catalog_service
from tests.testkit.generation_tool_authority import controlled_tool_runtime
from tests.testkit.provider_generation import tool_decision_generation_backend


@pytest.mark.parametrize("reason", ["cancelled", "turn_limit"])
def test_resumed_chat_stop_publishes_original_paid_usage_and_retires_continuation(
    request: pytest.FixtureRequest, reason: Literal["cancelled", "turn_limit"]
) -> None:
    """Chat recovery must retain earlier paid usage and close pending successor authority."""
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_resumed_chat_stop(engine, reason))


async def _prove_resumed_chat_stop(
    engine: Engine, reason: Literal["cancelled", "turn_limit"]
) -> None:
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    tools = controlled_tool_runtime({})
    operation = tools.operations["ChatRead"]
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    backend, peer = tool_decision_generation_backend(operation)
    runtime = ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=GenerationContinuationCipher(b"c" * 32),
        admission=GenerationService(
            catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
        ),
    )
    expected_children = 1 if reason == "cancelled" else operation.profile.run_limits.max_calls + 1

    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=factory))
    try:
        with factory() as db:
            recovered = await create_recoverable_chat(
                db,
                catalog=catalog,
                tools=tools,
                runtime=runtime,
                accepted_children=expected_children,
            )
            chat = recovered.chat
            before = read_model_turns(db, generation_id=recovered.generation_id)
            positions = read_tool_positions(db, generation_id=recovered.generation_id)
            if reason == "cancelled":
                cancel_chat_run(
                    db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
                )
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=recovered.job,
                execution_context=recovered.context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            public = get_chat_run(
                db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
            )
            assert public.run.status == ("cancelled" if reason == "cancelled" else "error")
            assert public.stream_state.terminal
            done = db.scalar(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "done"
                )
            )
            assert done is not None
            assert done.payload["usage"] == {
                "input_tokens": 100 * expected_children,
                "output_tokens": 10 * expected_children,
                "total_tokens": 110 * expected_children,
                "reasoning_tokens": None,
                "cache_read_input_tokens": None,
                "cache_write_input_tokens": None,
            }, "resumed Chat discarded or double-counted original paid child usage"
            parent = read_generation(db, generation_id=recovered.generation_id)
            assert parent is not None and parent.terminal is not None
            assert parent.terminal["orchestration_stop"] == reason
            assert read_model_turns(db, generation_id=recovered.generation_id) == before
            assert read_tool_positions(db, generation_id=recovered.generation_id) == positions
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(LLMModelTurnContinuation)
                    .where(LLMModelTurnContinuation.generation_id == recovered.generation_id)
                )
                == 0
            ), "cancelled Chat recovery left executable successor authority"
            assert peer.dispatches == expected_children, "Chat recovery paid for another model call"
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=recovered.job,
                execution_context=recovered.context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            assert peer.dispatches == expected_children
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatRunEvent)
                    .where(ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "done")
                )
                == 1
            )
    finally:
        set_rate_limiter(previous_limiter)
