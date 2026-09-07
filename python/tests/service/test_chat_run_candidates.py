"""Exact-selection proof for rerun and regeneration sibling candidates."""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.services.chat_run_candidates import regenerate_assistant_response
from nexus.services.chat_run_finalize import finalize_run
from nexus.services.generation_spec import decode_generation_spec_document
from tests.testkit.chat import create_entitled_chat
from tests.testkit.generation_catalog import (
    CHAT_TEST_SELECTION,
    configured_chat_catalog_service,
)
from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


def test_regeneration_creates_one_exact_read_only_sibling(db_session: Session) -> None:
    """Risk: repeat mutates its source, duplicates work, or inherits write authority."""

    asyncio.run(_prove_regeneration_creates_one_exact_read_only_sibling(db_session))


async def _prove_regeneration_creates_one_exact_read_only_sibling(db: Session) -> None:
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    tools = compose_available_product_tool_runtime()
    source = await create_entitled_chat(
        db,
        content="Regenerate this answer without changing its exact source prompt.",
        catalog_definition_revision=snapshot.catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="AdditiveWrites",
        catalog=catalog,
        tool_runtime=tools,
    )
    source_run = db.get(ChatRun, source.run_id)
    assert source_run is not None
    source_assistant_id = source_run.assistant_message_id
    finalize_run(
        db,
        run_id=source.run_id,
        assistant_content="Original completed answer.",
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
    )

    idempotency_key = f"exact-regeneration-{uuid4()}"
    first = await regenerate_assistant_response(
        db,
        viewer_id=source.user_id,
        assistant_message_id=source_assistant_id,
        catalog_definition_revision=snapshot.catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=tools,
    )
    replay = await regenerate_assistant_response(
        db,
        viewer_id=source.user_id,
        assistant_message_id=source_assistant_id,
        catalog_definition_revision=snapshot.catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=tools,
    )

    assert first.run.id == replay.run.id
    assert first.run.id != source.run_id
    assert first.run.run_selection.selection == CHAT_TEST_SELECTION
    assert first.run.run_selection.tool_authority == "ReadOnly"
    assert [block.text for block in first.user_message.message_document.blocks] == [
        source_run.user_message.content
    ]
    assert first.user_message.id != source_run.user_message_id
    assert first.assistant_message.id != source_assistant_id

    persisted_source = db.get(ChatRun, source.run_id)
    source_assistant = db.get(Message, source_assistant_id)
    candidate = db.get(ChatRun, first.run.id)
    assert persisted_source is not None and persisted_source.status == "complete"
    assert source_assistant is not None and source_assistant.content == "Original completed answer."
    assert candidate is not None and candidate.status == "queued"
    candidate_spec = decode_generation_spec_document(candidate.generation_spec)
    assert candidate_spec.selection == CHAT_TEST_SELECTION
    assert candidate_spec.tool_effect_mode.value == "ReadOnly"
    job_payload = db.execute(
        text("SELECT payload FROM background_jobs WHERE dedupe_key = :dedupe_key"),
        {"dedupe_key": f"chat_run:{candidate.id}"},
    ).scalar_one()
    assert job_payload == {
        "run_id": str(candidate.id),
        "generation_spec_fingerprint": candidate_spec.fingerprint,
    }
