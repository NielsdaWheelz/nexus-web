"""Versioned prompt-injection evaluation through Nexus prompt/runtime composition."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

from provider_runtime import (
    Absent,
    CallMeta,
    FinalizedProviderCall,
    PossiblyBillable,
    ProviderCredential,
    ResponsePayload,
    Succeeded,
    TextContent,
    ToolCall,
    plan_generate,
)
from provider_runtime.testing import ScriptedRuntime
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ConsumptionQueueItem,
    Highlight,
    NoteBlock,
    ResourceEdge,
    ResourceMutation,
)
from nexus.services.agent_tools.read_resource import execute_read_resource
from nexus.services.chat_prompt import (
    build_generate_intent_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
)
from nexus.services.chat_runs import _chat_tool_specs
from nexus.services.conversations import create_conversation
from nexus.services.llm_execution import ProductionExecutionRuntime
from nexus.services.llm_profiles import profile
from nexus.services.prompt_budget import PromptBlock
from tests.testkit.auth import UserRecord

_MUTATION_MODELS = (
    ResourceMutation,
    ResourceEdge,
    NoteBlock,
    Highlight,
    ConsumptionQueueItem,
)


def _mutation_counts(db: Session) -> tuple[int, ...]:
    return tuple(
        int(db.scalar(select(func.count()).select_from(model)) or 0) for model in _MUTATION_MODELS
    )


def _prompt_block(block_id: str, role: str, lane: str, text: str) -> PromptBlock:
    return PromptBlock(
        id=block_id,
        role=cast(Any, role),
        lane=cast(Any, lane),
        text=text,
        estimated_tokens=max(1, len(text) // 4),
        source_refs=(),
        privacy_scope="global" if lane == "system" else "conversation",
    )


def _adversarial_outcome(model: str, tool_call: ToolCall) -> Succeeded:
    return Succeeded(
        meta=CallMeta(
            provider="openai",
            model=model,
            provider_request_id=Absent(),
            upstream_provider=Absent(),
            usage=Absent(),
            attempt_trace=(),
            billability=PossiblyBillable(),
        ),
        response=ResponsePayload(
            content=TextContent(text="", tool_calls=(tool_call,)),
            continuation=Absent(),
        ),
    )


def test_prompt_injection_eval_refuses_scripted_adversarial_tool_calls(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    cases_path = Path(__file__).parent / "cases" / "tool_safety.v2.json"
    payload = json.loads(cases_path.read_text(encoding="utf-8"))
    assert payload["version"] == 2, "tool-safety rubric changed without review"
    pin = payload["provider_runtime_revision"]
    pyproject = Path(__file__).parents[2] / "pyproject.toml"
    assert f'rev = "{pin}"' in pyproject.read_text(encoding="utf-8")

    selected_profile = profile("fast")
    assert selected_profile is not None
    assert selected_profile.target.model == payload["model"]
    conversation = create_conversation(db_session, test_user.id)
    rubric = payload["rubric"]

    failures: dict[str, dict[str, object]] = {}
    for case in payload["cases"]:
        plan = build_prompt_plan(
            stable_blocks=(
                _prompt_block("system", "system", "system", render_system_prompt_block()),
            ),
            dynamic_system_blocks=(),
            history_blocks=(),
            current_user_block=_prompt_block(
                f"case:{case['id']}",
                "user",
                "current_user",
                case["prompt"],
            ),
        )
        intent = build_generate_intent_from_plan(
            plan=plan,
            target=selected_profile.target,
            max_output_tokens=256,
            reasoning=selected_profile.default_reasoning_option_id,
            tools=_chat_tool_specs(),
        )
        finalized = plan_generate(intent)
        assert isinstance(finalized, FinalizedProviderCall)

        requested = case["adversarial_tool_call"]
        tool_call = ToolCall(
            id=f"eval-{case['id']}",
            name=requested["name"],
            arguments=requested["arguments"],
        )
        scripted = ScriptedRuntime(
            generate_outcomes=(_adversarial_outcome(payload["model"], tool_call),)
        )
        runtime = ProductionExecutionRuntime(scripted)
        generated = asyncio.run(
            runtime.generate(
                intent,
                finalized,
                ProviderCredential(provider="openai", key="not-recorded"),
            )
        )
        assert len(scripted.calls) == 1
        content = generated.response.content
        assert isinstance(content, TextContent)
        assert content.tool_calls == (tool_call,)

        before = _mutation_counts(db_session)
        result = execute_read_resource(
            db_session,
            viewer_id=test_user.id,
            conversation_id=conversation.id,
            uri=cast(str, tool_call.arguments["uri"]),
        )
        after = _mutation_counts(db_session)
        if (
            (
                result.status != rubric["decision"]
                and not (rubric["decision"] == "refuse" and result.status == "error")
            )
            or result.error_code != rubric["error_code"]
            or after != before
        ):
            failures[case["id"]] = {
                "status": result.status,
                "error_code": result.error_code,
                "mutation_delta": tuple(a - b for a, b in zip(after, before, strict=True)),
            }

    assert not failures, f"tool-safety evaluation failures: {failures}"
