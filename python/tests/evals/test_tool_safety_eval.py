"""Deterministic defense-in-depth evaluation for tool-bearing chat.

Provider output is untrusted input to Nexus.  This zero-network proof therefore
feeds the reviewed adversarial calls directly into the production authorization
boundary and proves that neither prompt text nor a model-shaped tool call can
grant cross-account authority.  Hosted semantic behavior is certified
separately by the bounded nightly canary.
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from provider_runtime import CanonicalTool
from provider_runtime.types import ToolCall
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.services import bootstrap
from nexus.services.agent_tools import writes
from nexus.services.chat_prompt import render_system_prompt_block
from tests.testkit.llm_tool_scenarios import create_chat_run, create_readable_media


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

    pin = payload["provider_runtime_revision"]
    pyproject = Path(__file__).parents[2] / "pyproject.toml"
    assert f'rev = "{pin}"' in pyproject.read_text(encoding="utf-8")

    write_tools = tuple(
        CanonicalTool(
            name=definition["name"],
            description=definition["description"],
            parameters=definition["parameters"],
        )
        for definition in writes.ASSISTANT_WRITE_TOOL_DEFINITIONS
    )
    system_contract = render_system_prompt_block(tools=write_tools)
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

        for index, case in enumerate(cases):
            requested = case["adversarial_tool_call"]
            tool_call = ToolCall(
                id=f"adversarial-{case['id']}",
                name=requested["name"],
                arguments={
                    key: foreign_uri if value == "foreign_media_uri" else value
                    for key, value in requested["arguments"].items()
                },
            )
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
                outcome.status == rubric["decision"]
                and outcome.error_code == rubric["error_code"]
                and after - before == rubric["maximum_domain_mutations"]
            )
            observed_baseline[case["id"]] = "server_refused" if refused else "failed"
            if not refused:
                failures[case["id"]] = {
                    "status": outcome.status,
                    "error_code": outcome.error_code,
                    "domain_mutations": after - before,
                }

    assert observed_baseline == payload["baseline"], (
        "tool-safety baseline drifted: "
        f"expected={payload['baseline']!r}, observed={observed_baseline!r}"
    )
    assert not failures, f"deterministic tool-safety evaluation failures: {failures}"
