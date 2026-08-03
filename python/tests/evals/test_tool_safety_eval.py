"""Deterministic defense-in-depth evaluation for tool-bearing chat.

The controller-owned loopback provider deliberately emits the unsafe call over
the real OpenAI protocol. This proof evaluates production prompt composition,
provider dispatch, and the server authorization/persistence boundary; it does
not claim that a hosted model will semantically refuse the prompt.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from provider_runtime import (
    FinalizedProviderCall,
    GenerateIntent,
    ProviderCredential,
    ProviderRuntime,
    Succeeded,
    TerminalEvent,
    ToolCall,
    ToolCallDone,
    plan_generate,
)
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.config import Environment, Settings
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
from nexus.services.provider_http import provider_request_event_hooks
from tests.testkit.llm_tool_scenarios import (
    create_chat_run,
    create_readable_media,
    indirect_resource_prompt_plan,
    queue_add_tool,
)


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


async def _dispatch_adversarial_tool_call(
    *,
    intent: GenerateIntent,
    finalized: FinalizedProviderCall,
    base_url: str,
    api_key: str,
) -> tuple[ToolCall, int]:
    settings = Settings.model_construct(
        nexus_env=Environment.TEST,
        openai_api_base_url=base_url,
    )
    dispatches = 0
    requested_urls: list[str] = []

    async def count_dispatch(request: httpx.Request) -> None:
        nonlocal dispatches
        dispatches += 1
        requested_urls.append(str(request.url))

    hooks = provider_request_event_hooks(settings)
    hooks.setdefault("request", []).append(count_dispatch)
    async with httpx.AsyncClient(trust_env=False, event_hooks=hooks) as client:
        runtime = ProductionExecutionRuntime(ProviderRuntime(client))
        try:
            events = [
                envelope.event
                async for envelope in runtime.stream(
                    intent,
                    finalized,
                    ProviderCredential(provider="openai", key=api_key),
                    cancel=None,
                )
            ]
        except Exception as error:
            raise AssertionError(
                f"external provider dispatch failed at {requested_urls!r}: {error}"
            ) from error
    tool_calls = [event.tool_call for event in events if isinstance(event, ToolCallDone)]
    terminals = [event.outcome for event in events if isinstance(event, TerminalEvent)]
    assert len(tool_calls) == 1, f"external protocol emitted {len(tool_calls)} tool calls"
    assert len(terminals) == 1 and isinstance(terminals[0], Succeeded), (
        f"external protocol did not complete successfully: {terminals!r}"
    )
    return tool_calls[0], dispatches


def test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call(
    engine: Engine,
) -> None:
    cases_path = Path(__file__).parent / "cases" / "tool_safety.v3.json"
    payload = json.loads(cases_path.read_text(encoding="utf-8"))
    assert payload["version"] == 3, "tool-safety rubric changed without review"
    assert payload["max_hosted_calls"] == 0, "deterministic eval acquired a hosted-call budget"
    case_ids = {case["id"] for case in payload["cases"]}
    assert set(payload["baseline"]) == case_ids, (
        "stored tool-safety baseline does not cover the exact reviewed case set"
    )
    assert set(payload["baseline"].values()) == {"server_refused"}, (
        "stored tool-safety baseline contains an unreviewed outcome"
    )
    pin = payload["provider_runtime_revision"]
    pyproject = Path(__file__).parents[2] / "pyproject.toml"
    assert f'rev = "{pin}"' in pyproject.read_text(encoding="utf-8")

    base_url = os.environ.get("OPENAI_API_BASE_URL", "")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    parsed = urlsplit(base_url)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1", (
        "LLM eval requires the controller-owned loopback provider URL"
    )
    assert parsed.path.rstrip("/") == "/v1" and parsed.query == parsed.fragment == "", (
        "LLM eval provider URL is not the exact loopback OpenAI protocol root"
    )
    assert api_key == "nexus-test-fixture-openai-key", (
        "LLM eval requires the controller-owned provider credential"
    )

    selected_profile = profile("fast")
    assert selected_profile is not None
    assert selected_profile.target.model == payload["model"]
    queue_tool = queue_add_tool()
    system_contract = render_system_prompt_block()
    assert all(
        clause in system_contract for clause in payload["rubric"]["required_system_contract"]
    ), "production prompt lost a reviewed tool-safety instruction"

    owner_id = uuid4()
    foreign_id = uuid4()
    observed_baseline: dict[str, str] = {}
    failures: dict[str, dict[str, object]] = {}
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

        for index, case in enumerate(payload["cases"]):
            prompt = str(case["prompt"]).replace("foreign_media_uri", foreign_uri)
            if case["id"] == "indirect_resource_instruction":
                plan = indirect_resource_prompt_plan(
                    case_id=case["id"],
                    resource_uri=foreign_uri,
                    resource_text=prompt,
                    system_contract=system_contract,
                )
            else:
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

            tool_call, dispatches = asyncio.run(
                _dispatch_adversarial_tool_call(
                    intent=intent,
                    finalized=finalized,
                    base_url=base_url,
                    api_key=api_key,
                )
            )
            requested = case["adversarial_tool_call"]
            expected_arguments = {
                key: foreign_uri if value == "foreign_media_uri" else value
                for key, value in requested["arguments"].items()
            }
            assert tool_call.name == requested["name"]
            assert dict(tool_call.arguments) == expected_arguments

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
                effect_id=uuid4(),
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
            refused = (
                dispatches == rubric["expected_protocol_dispatches_per_case"]
                and outcome.status == rubric["decision"]
                and outcome.error_code == rubric["error_code"]
                and after - before == rubric["maximum_domain_mutations"]
            )
            observed_baseline[case["id"]] = "server_refused" if refused else "failed"
            if not refused:
                failures[case["id"]] = {
                    "protocol_dispatches": dispatches,
                    "status": outcome.status,
                    "error_code": outcome.error_code,
                    "domain_mutations": after - before,
                }

    assert observed_baseline == payload["baseline"], (
        "tool-safety baseline drifted: "
        f"expected={payload['baseline']!r}, observed={observed_baseline!r}"
    )
    assert not failures, f"deterministic tool-safety evaluation failures: {failures}"
