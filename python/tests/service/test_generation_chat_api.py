"""Exact-selection Chat admission, replay, repeat, and read-projection proof."""

from __future__ import annotations

import asyncio
from importlib.util import find_spec
from typing import TYPE_CHECKING
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_selection") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.db.models import ChatPromptAssembly, ChatRun, Conversation, Message
    from nexus.errors import ApiError, ApiErrorCode
    from nexus.schemas.llm import (
        AssistantUnavailableChatFailure,
        ExpectedChatFailure,
        Ineligible,
        OperatorDefectChatFailure,
        Selectable,
    )
    from nexus.services.chat_run_candidates import (
        regenerate_assistant_response,
        rerun_assistant_response,
    )
    from nexus.services.chat_run_finalize import finalize_run
    from nexus.services.chat_runs import admit_chat_selection, get_chat_run
    from nexus.services.conversation_branches import get_conversation_tree
    from nexus.services.conversations import list_messages
    from nexus.services.generation_selection import ProviderApiSelection
    from nexus.services.generation_spec import decode_generation_spec_document
    from nexus.services.tool_runtime.composition import compose_product_tool_runtime
    from nexus.services.tool_runtime.declarations import BROWSER_TOOL_PROJECTION_REVISION
    from tests.testkit.chat import create_entitled_chat
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


def test_exact_selection_and_authority_cross_every_chat_projection(
    db_session: Session,
) -> None:
    """Risk: a queued/replayed/repeated run loses or silently changes billable dispatch facts."""

    assert _CUTOVER_PRESENT, "the final exact Chat generation selection is absent"
    asyncio.run(_prove_exact_selection_and_authority(db_session))


async def _prove_exact_selection_and_authority(db_session: Session) -> None:
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    tool_runtime = compose_available_product_tool_runtime()
    revision = snapshot.catalog.definition_revision

    created = await create_entitled_chat(
        db_session,
        content="Explain the ownership boundary.",
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="AdditiveWrites",
        catalog=catalog,
        tool_runtime=tool_runtime,
    )
    replay = await create_entitled_chat(
        db_session,
        content="Explain the ownership boundary.",
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="AdditiveWrites",
        catalog=catalog,
        tool_runtime=tool_runtime,
        user_id=created.user_id,
        idempotency_key=created.idempotency_key,
    )
    assert replay.run_id == created.run_id

    run = db_session.get(ChatRun, created.run_id)
    assert run is not None
    spec = decode_generation_spec_document(run.generation_spec)
    assert spec.selection == CHAT_TEST_SELECTION
    assert spec.catalog_definition_revision == revision
    assert spec.tool_effect_mode.kind == "Present"
    assert spec.tool_effect_mode.value == "AdditiveWrites"
    assert spec.selection_source == "ChatRun"

    prompt = db_session.scalar(
        select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id)
    )
    assert prompt is not None
    assert prompt.generation_intent_digest == spec.prompt_payload_ref.payload_digest
    job_payload = db_session.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id"),
        {"job_id": created.job_id},
    ).scalar_one()
    assert job_payload == {
        "run_id": str(run.id),
        "generation_spec_fingerprint": spec.fingerprint,
    }

    messages, _page = list_messages(
        db_session,
        viewer_id=created.user_id,
        conversation_id=created.conversation_id,
        catalog_snapshot=snapshot,
    )
    assistant = next(message for message in messages if message.role == "assistant")
    assert assistant.trust_trail is not None
    assert assistant.trust_trail.run is not None
    assert assistant.trust_trail.run.run_selection.selection == CHAT_TEST_SELECTION
    assert assistant.trust_trail.run.run_selection.tool_authority == "AdditiveWrites"
    assert assistant.trust_trail.run.run_selection.display_at_dispatch == spec.display_at_dispatch

    finalize_run(
        db_session,
        run_id=created.run_id,
        assistant_content="The boundary owns the complete operation.",
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
    )
    repeat_key = f"regenerate-{uuid4()}"
    regenerated = await regenerate_assistant_response(
        db_session,
        viewer_id=created.user_id,
        assistant_message_id=run.assistant_message_id,
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        idempotency_key=repeat_key,
        catalog=catalog,
        tool_runtime=tool_runtime,
    )
    regenerated_replay = await regenerate_assistant_response(
        db_session,
        viewer_id=created.user_id,
        assistant_message_id=run.assistant_message_id,
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        idempotency_key=repeat_key,
        catalog=catalog,
        tool_runtime=tool_runtime,
    )
    assert regenerated_replay.run.id == regenerated.run.id
    assert regenerated.run.run_selection.tool_authority == "ReadOnly"
    regenerated_row = db_session.get(ChatRun, regenerated.run.id)
    assert regenerated_row is not None
    assert (
        decode_generation_spec_document(regenerated_row.generation_spec).tool_effect_mode.value
        == "ReadOnly"
    )

    tree = get_conversation_tree(
        db_session,
        viewer_id=created.user_id,
        conversation_id=created.conversation_id,
        catalog_snapshot=snapshot,
    )
    assert {
        str(run.assistant_message_id),
        str(regenerated_row.assistant_message_id),
    }.issubset(tree.path_cache_by_leaf_id), (
        "the supported branch read must hydrate both the source and regenerated leaves"
    )
    tree_messages = {
        message.id: message
        for path in (tree.selected_path, *tree.path_cache_by_leaf_id.values())
        for message in path
    }
    projected_authorities = {
        run.assistant_message_id: "AdditiveWrites",
        regenerated_row.assistant_message_id: "ReadOnly",
    }
    for assistant_message_id, authority in projected_authorities.items():
        projected = tree_messages[assistant_message_id]
        assert projected.trust_trail is not None
        assert projected.trust_trail.run is not None
        run_selection = projected.trust_trail.run.run_selection
        assert run_selection.selection == CHAT_TEST_SELECTION
        assert run_selection.catalog_definition_revision == revision
        assert run_selection.display_at_dispatch == spec.display_at_dispatch
        assert run_selection.tool_authority == authority
        assert isinstance(run_selection.current_state, Selectable)
        assert run_selection.current_state_observed_at == snapshot.catalog.observed_at
    source_selection = tree_messages[run.assistant_message_id].trust_trail
    assert source_selection is not None and source_selection.run is not None
    assert source_selection.run.run_selection.rerun_eligibility is True

    # A real catalog refresh with the historical API route removed keeps the
    # frozen dispatch facts visible but must not make either branch dispatchable.
    codex_only_snapshot = await configured_chat_catalog_service(
        configured_api_providers=()
    ).read_chat()
    assert codex_only_snapshot.catalog.definition_revision != revision
    assert codex_only_snapshot.pair(CHAT_TEST_SELECTION) is None
    stale_tree = get_conversation_tree(
        db_session,
        viewer_id=created.user_id,
        conversation_id=created.conversation_id,
        catalog_snapshot=codex_only_snapshot,
    )
    stale_tree_messages = {
        message.id: message
        for path in (stale_tree.selected_path, *stale_tree.path_cache_by_leaf_id.values())
        for message in path
    }
    for assistant_message_id, authority in projected_authorities.items():
        projected = stale_tree_messages[assistant_message_id]
        assert projected.trust_trail is not None
        assert projected.trust_trail.run is not None
        run_selection = projected.trust_trail.run.run_selection
        assert run_selection.selection == CHAT_TEST_SELECTION
        assert run_selection.catalog_definition_revision == revision
        assert run_selection.display_at_dispatch == spec.display_at_dispatch
        assert run_selection.tool_authority == authority
        assert isinstance(run_selection.current_state, Ineligible)
        assert run_selection.current_state.code == "selection_not_configured"
        assert run_selection.rerun_eligibility is False
        assert run_selection.current_state_observed_at == codex_only_snapshot.catalog.observed_at

    with pytest.raises(ApiError) as mismatch:
        await regenerate_assistant_response(
            db_session,
            viewer_id=created.user_id,
            assistant_message_id=run.assistant_message_id,
            catalog_definition_revision=revision,
            selection=ProviderApiSelection(
                route="ProviderApi",
                model_ref="openai:gpt-5.6-sol",
                reasoning="high",
            ),
            tool_authority="ReadOnly",
            idempotency_key=repeat_key,
            catalog=catalog,
            tool_runtime=tool_runtime,
        )
    assert mismatch.value.code is ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH

    failed = await create_entitled_chat(
        db_session,
        content="Please retry this unavailable answer.",
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="AdditiveWrites",
        catalog=catalog,
        tool_runtime=tool_runtime,
        user_id=created.user_id,
    )
    failed_row = db_session.get(ChatRun, failed.run_id)
    assert failed_row is not None
    finalize_run(
        db_session,
        run_id=failed.run_id,
        assistant_content="",
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code="timeout",
    )
    rerun = await rerun_assistant_response(
        db_session,
        viewer_id=created.user_id,
        assistant_message_id=failed_row.assistant_message_id,
        catalog_definition_revision=revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        idempotency_key=f"rerun-{uuid4()}",
        catalog=catalog,
        tool_runtime=tool_runtime,
    )
    assert rerun.run.run_selection.tool_authority == "ReadOnly"

    # Controlled integrity fault: an object-shaped but invalid durable spec
    # must make a non-create history hydration defect instead of falling back.
    rerun_row = db_session.get(ChatRun, rerun.run.id)
    assert rerun_row is not None
    rerun_row.generation_spec = {}
    db_session.flush()
    with pytest.raises(AssertionError, match="invalid generation spec"):
        list_messages(
            db_session,
            viewer_id=created.user_id,
            conversation_id=failed.conversation_id,
            catalog_snapshot=snapshot,
        )
    db_session.rollback()


def test_chat_generation_ingress_is_strict_and_has_no_profile_or_bodyless_repeat(
    authenticated_client: TestClient,
) -> None:
    """Risk: a legacy/default selector reaches Chat admission after the hard cut."""

    headers = {"X-Nexus-Tool-Projection": BROWSER_TOOL_PROJECTION_REVISION}
    assistant_message_id = uuid4()
    bodyless = authenticated_client.post(
        f"/messages/{assistant_message_id}/rerun",
        headers=headers,
    )
    assert bodyless.status_code == 400
    assert bodyless.json()["error"]["code"] == "E_INVALID_REQUEST"

    legacy = authenticated_client.post(
        "/chat-runs",
        headers=headers,
        json={
            "destination": {"kind": "New"},
            "content": "No implicit profile.",
            "profile_id": "balanced",
            "reader_selection": {"kind": "Absent"},
        },
    )
    assert legacy.status_code == 422
    assert legacy.json()["error"]["code"] == "E_INVALID_GENERATION_SELECTION"

    malformed_selection = authenticated_client.post(
        f"/messages/{assistant_message_id}/regenerate",
        headers=headers,
        json={
            "catalog_definition_revision": "0" * 64,
            "selection": {
                "route": "ProviderApi",
                "model_ref": "openai:gpt-5.6-terra",
                "reasoning": "invented",
            },
            "tool_authority": "ReadOnly",
        },
    )
    assert malformed_selection.status_code == 422
    assert malformed_selection.json()["error"]["code"] == "E_INVALID_GENERATION_SELECTION"

    inherited_write = authenticated_client.post(
        f"/messages/{assistant_message_id}/rerun",
        headers=headers,
        json={
            "catalog_definition_revision": "0" * 64,
            "selection": CHAT_TEST_SELECTION.model_dump(mode="json"),
            "tool_authority": "AdditiveWrites",
        },
    )
    assert inherited_write.status_code == 400
    assert inherited_write.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_chat_selection_failures_are_typed_without_durable_work() -> None:
    """Risk: stale or unknown selections are silently reinterpreted."""

    catalog = configured_chat_catalog_service()
    snapshot = asyncio.run(catalog.read_chat())
    with pytest.raises(ApiError) as stale:
        asyncio.run(
            admit_chat_selection(
                catalog,
                catalog_definition_revision="0" * 64,
                selection=CHAT_TEST_SELECTION,
            )
        )
    assert stale.value.code is ApiErrorCode.E_CATALOG_DEFINITION_STALE
    assert stale.value.status_code == 409

    with pytest.raises(ApiError) as invalid:
        asyncio.run(
            admit_chat_selection(
                catalog,
                catalog_definition_revision=snapshot.catalog.definition_revision,
                selection=ProviderApiSelection(
                    route="ProviderApi",
                    model_ref="openai:not-configured",
                    reasoning="medium",
                ),
            )
        )
    assert invalid.value.code is ApiErrorCode.E_INVALID_GENERATION_SELECTION
    assert invalid.value.status_code == 422


def test_missing_required_chat_binding_refuses_before_chat_state_is_durable(
    db_session: Session,
) -> None:
    """Risk: known-incomplete tool authority leaves a queued Chat run that cannot execute."""

    catalog = configured_chat_catalog_service()
    snapshot = asyncio.run(catalog.read_chat())
    aggregate_models = (Conversation, Message, ChatRun)
    before = tuple(
        int(db_session.scalar(select(func.count()).select_from(model)) or 0)
        for model in aggregate_models
    )

    with pytest.raises(ApiError) as unavailable:
        asyncio.run(
            create_entitled_chat(
                db_session,
                content="Do not persist an admission with incomplete tool authority.",
                catalog_definition_revision=snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=compose_product_tool_runtime(None),
            )
        )

    assert unavailable.value.code is ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE
    assert unavailable.value.status_code == 503
    assert unavailable.value.details is None
    assert (
        tuple(
            int(db_session.scalar(select(func.count()).select_from(model)) or 0)
            for model in aggregate_models
        )
        == before
    )


def test_chat_run_failure_projects_one_closed_code_and_rerun_eligibility(
    db_session: Session,
) -> None:
    """Risk: a stored terminal code reaches readers as an invented failure card or rerun state."""

    assert _CUTOVER_PRESENT, "the final exact Chat generation selection is absent"
    asyncio.run(_prove_chat_run_failure_projection(db_session))


async def _prove_chat_run_failure_projection(db_session: Session) -> None:
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    tool_runtime = compose_available_product_tool_runtime()
    revision = snapshot.catalog.definition_revision
    # Each stored code is exactly what its producer writes: the ProviderApi
    # TransientExhausted and Codex runtime failures land as runtime_unavailable,
    # a pre-accept Chat capacity refusal as capacity_unavailable, and a Codex
    # policy violation as policy_violation. The selection stays Selectable, so
    # rerun eligibility is decided by the code alone.
    cases: tuple[tuple[str, ExpectedChatFailure, bool], ...] = (
        ("runtime_unavailable", AssistantUnavailableChatFailure(can_rerun=True), True),
        ("capacity_unavailable", AssistantUnavailableChatFailure(can_rerun=True), True),
        ("policy_violation", OperatorDefectChatFailure(), False),
    )
    viewer_id = None
    for error_code, expected_failure, expected_rerun in cases:
        chat = await create_entitled_chat(
            db_session,
            content=f"Fail this run with {error_code}.",
            catalog_definition_revision=revision,
            selection=CHAT_TEST_SELECTION,
            tool_authority="ReadOnly",
            catalog=catalog,
            tool_runtime=tool_runtime,
            user_id=viewer_id,
        )
        viewer_id = chat.user_id
        finalize_run(
            db_session,
            run_id=chat.run_id,
            assistant_content="",
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code=error_code,
        )

        response = get_chat_run(
            db_session,
            viewer_id=chat.user_id,
            run_id=chat.run_id,
            catalog_snapshot=snapshot,
        )
        assert response.run.failure == expected_failure, (
            f"{error_code}: ChatRunOut projected {response.run.failure!r}"
        )

        run_row = db_session.get(ChatRun, chat.run_id)
        assert run_row is not None
        tree = get_conversation_tree(
            db_session,
            viewer_id=chat.user_id,
            conversation_id=chat.conversation_id,
            catalog_snapshot=snapshot,
        )
        assistant = next(
            message
            for path in (tree.selected_path, *tree.path_cache_by_leaf_id.values())
            for message in path
            if message.id == run_row.assistant_message_id
        )
        assert assistant.trust_trail is not None and assistant.trust_trail.run is not None
        trust_run = assistant.trust_trail.run
        assert trust_run.error_code == error_code
        assert trust_run.failure == expected_failure, (
            f"{error_code}: conversation tree projected {trust_run.failure!r}"
        )
        assert isinstance(trust_run.run_selection.current_state, Selectable)
        assert trust_run.run_selection.rerun_eligibility is expected_rerun, (
            f"{error_code}: rerun eligibility {trust_run.run_selection.rerun_eligibility!r}"
        )
