"""Deterministic tool-safety evaluation at the real authorization and database boundary."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict, cast

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
from nexus.services.agent_tools.writes import (
    ASSISTANT_WRITE_TOOL_DEFINITIONS,
    WRITE_TOOL_NAMES,
)
from nexus.services.conversations import create_conversation
from tests.testkit.auth import UserRecord


class _Case(TypedDict):
    id: str
    input: str
    expected_error: str


class _Cases(TypedDict):
    version: int
    cases: list[_Case]


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


def test_prompt_injected_resource_reads_are_refused_without_side_effects(
    db_session: Session, test_user: UserRecord
) -> None:
    path = Path(__file__).parent / "cases" / "tool_safety.v1.json"
    payload = cast(_Cases, json.loads(path.read_text(encoding="utf-8")))
    assert payload["version"] == 1, "tool-safety baseline version changed without review"
    conversation = create_conversation(db_session, test_user.id)
    before = _mutation_counts(db_session)

    results = {
        case["id"]: execute_read_resource(
            db_session,
            viewer_id=test_user.id,
            conversation_id=conversation.id,
            uri=case["input"],
        )
        for case in payload["cases"]
    }

    failures = {
        case["id"]: {
            "expected": case["expected_error"],
            "actual": results[case["id"]].error_code,
            "status": results[case["id"]].status,
        }
        for case in payload["cases"]
        if results[case["id"]].status != "error"
        or results[case["id"]].error_code != case["expected_error"]
    }
    assert not failures, f"tool authorization baseline failures: {failures}"
    assert _mutation_counts(db_session) == before, (
        "refused tool inputs changed a user-owned mutation table"
    )


def test_assistant_write_surface_is_closed_and_additive_only() -> None:
    names = tuple(definition["name"] for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS)
    assert names == WRITE_TOOL_NAMES
    assert names == (
        "add_to_library",
        "jot_note",
        "create_highlight",
        "mint_edge",
        "queue_add",
    )
    destructive_tokens = {"delete", "destroy", "overwrite", "remove", "replace"}
    leaked = {
        definition["name"]: sorted(
            token for token in destructive_tokens if token in str(definition["name"]).casefold()
        )
        for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS
    }
    assert not any(leaked.values()), f"destructive assistant tool escaped the allowlist: {leaked}"
    assert all(
        definition["parameters"].get("additionalProperties") is False
        for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS
    ), "assistant write schemas must reject unreviewed arguments"
