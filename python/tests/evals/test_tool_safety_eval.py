"""Deterministic defense-in-depth evaluation for tool-bearing chat.

The scripted external provider deliberately emits the unsafe call. This proof
evaluates production prompt composition plus the server enforcement boundary;
it does not claim that a hosted model will semantically refuse the prompt.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from provider_runtime import (
    Absent,
    CallMeta,
    CanonicalTool,
    FinalizedProviderCall,
    PossiblyBillable,
    ProviderCredential,
    ResponsePayload,
    Succeeded,
    TextContent,
    ToolCall,
    parse_canonical_schema,
    plan_generate,
)
from provider_runtime.testing import ScriptedRuntime
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.services import bootstrap
from nexus.services.agent_tools import writes
from nexus.services.chat_prompt import (
    build_generate_intent_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
)
from nexus.services.llm_execution import ProductionExecutionRuntime
from nexus.services.llm_profiles import profile
from nexus.services.prompt_budget import PromptBlock
from tests.testkit.llm_tool_scenarios import create_chat_run, create_readable_media


def _prompt_block(block_id: str, role: str, lane: str, value: str) -> PromptBlock:
    return PromptBlock(
        id=block_id,
        role=cast(Any, role),
        lane=cast(Any, lane),
        text=value,
        estimated_tokens=max(1, len(value) // 4),
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


def test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call(
    engine: Engine,
) -> None:
    cases_path = Path(__file__).parent / "cases" / "tool_safety.v3.json"
    payload = json.loads(cases_path.read_text(encoding="utf-8"))
    assert payload["version"] == 3, "tool-safety rubric changed without review"
    assert payload["max_hosted_calls"] == 0, "deterministic eval acquired a hosted-call budget"
    assert set(payload["baseline"]) == {case["id"] for case in payload["cases"]}, (
        "stored tool-safety baseline does not cover the exact reviewed case set"
    )
    pin = payload["provider_runtime_revision"]
    pyproject = Path(__file__).parents[2] / "pyproject.toml"
    assert f'rev = "{pin}"' in pyproject.read_text(encoding="utf-8")

    selected_profile = profile("fast")
    assert selected_profile is not None
    assert selected_profile.target.model == payload["model"]
    queue_definition = next(
        definition
        for definition in writes.ASSISTANT_WRITE_TOOL_DEFINITIONS
        if definition["name"] == writes.QUEUE_ADD_TOOL_NAME
    )
    queue_tool = CanonicalTool(
        name=queue_definition["name"],
        description=queue_definition["description"],
        parameters=parse_canonical_schema(queue_definition["parameters"]),
    )
    system_contract = render_system_prompt_block()
    assert all(
        clause in system_contract for clause in payload["rubric"]["required_system_contract"]
    ), "production prompt lost a reviewed tool-safety instruction"

    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"eval-owner-{owner_id}@example.invalid",
        )
        foreign_default = bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"eval-foreign-{foreign_id}@example.invalid",
        )
        foreign_media_id = create_readable_media(
            db,
            user_id=foreign_id,
            default_library_id=foreign_default,
            title="Foreign eval target",
            canonical_text="Private content from another account.",
        )
        run = create_chat_run(db, owner_id)
        foreign_uri = f"media:{foreign_media_id}"
        rubric = payload["rubric"]
        failures: dict[str, dict[str, object]] = {}

        for index, case in enumerate(payload["cases"]):
            prompt = str(case["prompt"]).replace("foreign_media_uri", foreign_uri)
            plan = build_prompt_plan(
                stable_blocks=(_prompt_block("system", "system", "system", system_contract),),
                dynamic_system_blocks=(),
                history_blocks=(),
                current_user_block=_prompt_block(
                    f"case:{case['id']}",
                    "user",
                    "current_user",
                    prompt,
                ),
            )
            intent = build_generate_intent_from_plan(
                plan=plan,
                target=selected_profile.target,
                max_output_tokens=64,
                reasoning=selected_profile.default_reasoning_option_id,
                tools=(queue_tool,),
            )
            finalized = plan_generate(intent)
            assert isinstance(finalized, FinalizedProviderCall)

            requested = case["adversarial_tool_call"]
            arguments = {
                key: foreign_uri if value == "foreign_media_uri" else value
                for key, value in requested["arguments"].items()
            }
            tool_call = ToolCall(
                id=f"eval-{case['id']}",
                name=requested["name"],
                arguments=arguments,
            )
            scripted = ScriptedRuntime(
                generate_outcomes=(_adversarial_outcome(payload["model"], tool_call),)
            )
            generated = asyncio.run(
                ProductionExecutionRuntime(scripted).generate(
                    intent,
                    finalized,
                    ProviderCredential(provider="openai", key="not-recorded"),
                )
            )
            content = generated.response.content
            assert isinstance(content, TextContent)
            assert content.tool_calls == (tool_call,)

            before = int(
                db.scalar(
                    text("SELECT COUNT(*) FROM consumption_queue_items WHERE user_id = :user_id"),
                    {"user_id": owner_id},
                )
                or 0
            )
            outcome = writes.execute_write_tool(
                db,
                run=run,
                tool_call_index=index,
                tool_name=tool_call.name,
                args=dict(tool_call.arguments),
            )
            after = int(
                db.scalar(
                    text("SELECT COUNT(*) FROM consumption_queue_items WHERE user_id = :user_id"),
                    {"user_id": owner_id},
                )
                or 0
            )
            if (
                len(scripted.calls) != rubric["maximum_provider_dispatches_per_case"]
                or outcome.status != rubric["decision"]
                or outcome.error_code != rubric["error_code"]
                or after - before != rubric["maximum_domain_mutations"]
            ):
                failures[case["id"]] = {
                    "provider_dispatches": len(scripted.calls),
                    "status": outcome.status,
                    "error_code": outcome.error_code,
                    "domain_mutations": after - before,
                }

    assert not failures, f"deterministic tool-safety evaluation failures: {failures}"
