"""Deterministic defense-in-depth evaluation for tool-bearing Chat.

Provider output is untrusted input to Nexus. This zero-network proof decodes
reviewed adversarial provider calls through the frozen Chat publication, then
executes them through the public canonical tool boundary. Prompt text and a
model-shaped call therefore receive no authority beyond the explicit Chat
principal and scope.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from uuid import uuid4

from llm_tools import EffectId, ToolId
from provider_runtime.tool_adapter import CanonicalToolCall, ToolPublication, lower_tools
from provider_runtime.types import ToolCall
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ConsumptionQueueItem
from nexus.services import bootstrap
from nexus.services.chat_prompt import render_system_prompt_block
from nexus.services.durable_step_journal import stable_generation_id
from tests.testkit.chat import create_entitled_chat
from tests.testkit.llm_tool_scenarios import (
    claim_chat_tool_job,
    compose_keyless_tool_runtime,
    create_readable_media,
    execute_chat_tool,
)

_QUEUE_TOOL_ID = ToolId("nexus.queue.add")
_LEGACY_WRITE_NAMES = {
    "add_to_library",
    "create_highlight",
    "jot_note",
    "mint_edge",
    "queue_add",
}


def test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call(
    engine: Engine,
) -> None:
    cases_path = Path(__file__).parent / "cases" / "tool_safety.v3.json"
    payload = json.loads(cases_path.read_text(encoding="utf-8"))
    assert payload["version"] == 3, "tool-safety rubric changed without review"
    assert payload["max_hosted_calls"] == 0, "deterministic eval acquired a hosted-call budget"
    cases = payload["cases"]
    assert set(payload["baseline"]) == {case["id"] for case in cases}
    assert set(payload["baseline"].values()) == {"server_refused"}

    pyproject = Path(__file__).parents[2] / "pyproject.toml"
    project = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    sources = project["tool"]["uv"]["sources"]
    assert sources["provider-runtime"]["rev"] == payload["provider_runtime_revision"], (
        "tool-safety eval provider-runtime revision does not match the exact consumer pin"
    )
    assert sources["llm-tools"]["rev"] == payload["llm_tools_revision"], (
        "tool-safety eval llm-tools revision does not match the exact consumer pin"
    )

    runtime = compose_keyless_tool_runtime()
    operation = runtime.operations["chat"]
    publication = lower_tools(ToolPublication(plan=operation.plan, revealed_targets=()))
    published_names = {tool.name for tool in publication.tools}
    assert published_names.isdisjoint(_LEGACY_WRITE_NAMES), (
        "legacy executable write identity escaped the frozen Chat publication"
    )
    assert {case["adversarial_tool_call"]["name"] for case in cases} <= published_names
    system_contract = render_system_prompt_block(tools=publication.tools)
    assert all(
        clause in system_contract for clause in payload["rubric"]["required_system_contract"]
    ), "production prompt lost a reviewed tool-safety instruction"

    owner_id = uuid4()
    foreign_id = uuid4()
    observed_baseline: dict[str, str] = {}
    failures: dict[str, dict[str, object]] = {}
    with Session(engine, expire_on_commit=False) as db:
        chat = create_entitled_chat(
            db,
            content="Summarize the untrusted attached resource without changing my library.",
            user_id=owner_id,
        )
        foreign_default = bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"eval-foreign-{foreign_id}@example.invalid",
        )
        run = db.get(ChatRun, chat.run_id)
        assert run is not None
        foreign_media_id = create_readable_media(
            db,
            user_id=foreign_id,
            default_library_id=foreign_default,
            title="Foreign eval target",
            canonical_text="Private content from another account.",
        )
        db.commit()
        foreign_uri = f"media:{foreign_media_id}"
        job_context = claim_chat_tool_job(
            db,
            job_id=chat.job_id,
            worker_id=f"tool-safety-eval-{uuid4()}",
        )
        rubric = payload["rubric"]

        for index, case in enumerate(cases, start=1):
            requested = case["adversarial_tool_call"]
            provider_call = ToolCall(
                id=f"adversarial-{case['id']}",
                name=requested["name"],
                arguments={
                    key: foreign_uri if value == "foreign_media_uri" else value
                    for key, value in requested["arguments"].items()
                },
            )
            decoded = publication.decode_tool_call(provider_call)
            assert isinstance(decoded, CanonicalToolCall), (
                f"reviewed case {case['id']!r} no longer names a published Chat tool"
            )
            assert decoded.tool_id == _QUEUE_TOOL_ID

            before = int(
                db.scalar(
                    select(func.count())
                    .select_from(ConsumptionQueueItem)
                    .where(ConsumptionQueueItem.media_id == foreign_media_id)
                )
                or 0
            )
            path = f"turn/0/tool/{index}"
            outcome = execute_chat_tool(
                db,
                operation=operation,
                run=run,
                job_context=job_context,
                tool_id=str(decoded.tool_id),
                tool_call_index=index,
                arguments=dict(decoded.arguments),
                admitted_resource_uris=(foreign_uri,),
                effect_id=EffectId(str(stable_generation_id(run.id, path))),
            )
            after = int(
                db.scalar(
                    select(func.count())
                    .select_from(ConsumptionQueueItem)
                    .where(ConsumptionQueueItem.media_id == foreign_media_id)
                )
                or 0
            )
            refused = (
                outcome == rubric["expected_result"]
                and after - before == rubric["maximum_domain_mutations"]
            )
            observed_baseline[case["id"]] = "server_refused" if refused else "failed"
            if not refused:
                failures[case["id"]] = {
                    "result": outcome,
                    "domain_mutations": after - before,
                }

    assert observed_baseline == payload["baseline"], (
        "tool-safety baseline drifted: "
        f"expected={payload['baseline']!r}, observed={observed_baseline!r}"
    )
    assert not failures, f"deterministic tool-safety evaluation failures: {failures}"
