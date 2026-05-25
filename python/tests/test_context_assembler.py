"""Integration tests for chat context assembly service."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message, MessageRetrieval, MessageToolCall, Model
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.context_assembler import (
    assemble_chat_context,
    load_message_context_refs,
    message_context_ref_payloads,
)
from nexus.services.context_rendering import PROMPT_VERSION
from tests.factories import (
    create_test_conversation,
    create_test_media,
    create_test_message,
    create_test_model,
)

pytestmark = pytest.mark.integration


def _create_run(
    db_session: Session,
    *,
    user_id: UUID,
    model_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
) -> ChatRun:
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="test-payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    db_session.commit()
    return run


def _insert_reader_selection_context_row(
    db_session: Session,
    *,
    message_id: UUID,
    user_id: UUID,
    source_media_id: UUID,
    locator: dict[str, object],
    snapshot: dict[str, object],
    ordinal: int = 0,
) -> None:
    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id,
                user_id,
                context_kind,
                source_media_id,
                locator_json,
                ordinal,
                context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'reader_selection',
                :source_media_id,
                :locator_json,
                :ordinal,
                :context_snapshot
            )
            """
        ).bindparams(
            bindparam("locator_json", type_=JSONB),
            bindparam("context_snapshot", type_=JSONB),
        ),
        {
            "message_id": message_id,
            "user_id": user_id,
            "source_media_id": source_media_id,
            "locator_json": locator,
            "ordinal": ordinal,
            "context_snapshot": snapshot,
        },
    )


def _insert_object_ref_context_row(
    db_session: Session,
    *,
    message_id: UUID,
    user_id: UUID,
    object_type: str,
    object_id: UUID,
    snapshot: dict[str, object],
    ordinal: int = 0,
) -> None:
    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id,
                user_id,
                context_kind,
                object_type,
                object_id,
                ordinal,
                context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'object_ref',
                :object_type,
                :object_id,
                :ordinal,
                :context_snapshot
            )
            """
        ).bindparams(bindparam("context_snapshot", type_=JSONB)),
        {
            "message_id": message_id,
            "user_id": user_id,
            "object_type": object_type,
            "object_id": object_id,
            "ordinal": ordinal,
            "context_snapshot": snapshot,
        },
    )


def test_assemble_chat_context_selects_recent_history_as_pairs(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 1300
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    for pair_index in range(10):
        seq = pair_index * 2 + 1
        create_test_message(
            db_session,
            conversation_id=conversation_id,
            seq=seq,
            role="user",
            content=f"older user {pair_index} " + ("alpha " * 80),
        )
        create_test_message(
            db_session,
            conversation_id=conversation_id,
            seq=seq + 1,
            role="assistant",
            content=f"older assistant {pair_index} " + ("beta " * 80),
        )
    current_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=21,
        role="user",
        content="What did we decide most recently?",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=22,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=current_user_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    assert assembly.prompt_plan.turns[-1].blocks[0].text == "What did we decide most recently?"
    assert assembly.llm_request.messages[-1].content == "What did we decide most recently?"
    assert 0 < len(assembly.history) < 20
    assert len(assembly.history) % 2 == 0
    assert assembly.history[0].role == "user"
    assert assembly.history[-1].role == "assistant"
    assert "older assistant 9" in assembly.history[-1].content


def test_assemble_chat_context_exposes_reader_selection_locator_and_source_version(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    media_id = create_test_media(db_session, title="Stable Reader Source")
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached quote.",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    client_context_id = uuid4()
    fragment_id = uuid4()
    locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 4,
        "end_offset": 17,
    }
    stale_row_locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 0,
        "end_offset": 1,
    }
    source_version = f"fragment:{fragment_id}"
    _insert_reader_selection_context_row(
        db_session,
        message_id=user_message_id,
        user_id=bootstrapped_user,
        source_media_id=media_id,
        locator=stale_row_locator,
        snapshot={
            "kind": "reader_selection",
            "client_context_id": str(client_context_id),
            "media_id": str(media_id),
            "source_media_id": str(media_id),
            "media_kind": "web_article",
            "media_title": "Stable Reader Source",
            "exact": "attached quote",
            "prefix": "Use ",
            "suffix": " here.",
            "locator": locator,
            "source_version": source_version,
        },
    )
    db_session.commit()
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    attached_block = next(
        block for block in assembly.prompt_plan.blocks() if block.lane == "attached_context"
    )
    attached_ref = dict(attached_block.source_refs[0])

    assert attached_block.source_version == source_version
    assert attached_ref["type"] == "reader_selection"
    assert attached_ref["id"] == str(client_context_id)
    assert attached_ref["source_media_id"] == str(media_id)
    assert attached_ref["locator"] == locator
    assert attached_ref["source_version"] == source_version
    assert attached_ref["exact_snippet"] == "attached quote"
    assert any(
        ref.get("source_version") == source_version and ref.get("locator") == locator
        for ref in assembly.ledger.included_context_refs
    )


def test_load_message_context_refs_rejects_reader_selection_with_invalid_locator(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    media_id = create_test_media(db_session, title="Incomplete Reader Source")
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached quote.",
    )
    client_context_id = uuid4()
    fragment_id = uuid4()
    stored_locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 4,
        "end_offset": 17,
    }
    invalid_locator = {
        "type": "web_text_offsets",
    }
    _insert_reader_selection_context_row(
        db_session,
        message_id=user_message_id,
        user_id=bootstrapped_user,
        source_media_id=media_id,
        locator=stored_locator,
        snapshot={
            "kind": "reader_selection",
            "client_context_id": str(client_context_id),
            "media_id": str(media_id),
            "source_media_id": str(media_id),
            "media_kind": "web_article",
            "media_title": "Incomplete Reader Source",
            "exact": "attached quote",
            "prefix": "Use ",
            "suffix": " here.",
            "locator": invalid_locator,
            "source_version": f"fragment:{fragment_id}",
        },
    )
    db_session.commit()

    with pytest.raises(NotFoundError) as exc_info:
        load_message_context_refs(db_session, user_message_id)

    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


def test_load_message_context_refs_rejects_object_ref_with_invalid_evidence_span_ids(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached chunk.",
    )
    chunk_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    _insert_object_ref_context_row(
        db_session,
        message_id=user_message_id,
        user_id=bootstrapped_user,
        object_type="content_chunk",
        object_id=chunk_id,
        snapshot={
            "kind": "object_ref",
            "type": "content_chunk",
            "id": str(chunk_id),
            "title": "Attached Chunk",
            "source_version": "content-index:test:v1",
            "locator": {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": 0,
                "end_offset": 14,
                "media_kind": "web_article",
                "text_quote_selector": {
                    "exact": "Attached Chunk",
                    "prefix": "",
                    "suffix": "",
                },
            },
            "evidence_span_ids": ["not-a-uuid"],
        },
    )
    db_session.commit()

    with pytest.raises(NotFoundError) as exc_info:
        load_message_context_refs(db_session, user_message_id)

    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


@pytest.mark.parametrize(
    "snapshot_patch",
    [
        {"source_version": 42},
        {"locator": "not-an-object"},
    ],
)
def test_load_message_context_refs_rejects_invalid_object_ref_snapshot_fields(
    db_session: Session,
    bootstrapped_user: UUID,
    snapshot_patch: dict[str, object],
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached media.",
    )
    media_id = uuid4()
    snapshot = {
        "kind": "object_ref",
        "type": "media",
        "id": str(media_id),
        "title": "Attached Media",
        **snapshot_patch,
    }
    _insert_object_ref_context_row(
        db_session,
        message_id=user_message_id,
        user_id=bootstrapped_user,
        object_type="media",
        object_id=media_id,
        snapshot=snapshot,
    )
    db_session.commit()

    with pytest.raises(NotFoundError) as exc_info:
        load_message_context_refs(db_session, user_message_id)

    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


def test_load_message_context_refs_rejects_content_chunk_missing_canonical_snapshot(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached chunk.",
    )
    _insert_object_ref_context_row(
        db_session,
        message_id=user_message_id,
        user_id=bootstrapped_user,
        object_type="content_chunk",
        object_id=(chunk_id := uuid4()),
        snapshot={
            "kind": "object_ref",
            "type": "content_chunk",
            "id": str(chunk_id),
            "title": "Stale chunk context",
        },
    )
    db_session.commit()

    with pytest.raises(NotFoundError) as exc_info:
        load_message_context_refs(db_session, user_message_id)

    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


def test_assemble_chat_context_uses_only_ancestor_path_for_branch(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    root_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Root question",
    )
    root_assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="Root answer",
        parent_message_id=root_user_id,
    )
    path_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=3,
        role="user",
        content="Use the path branch.",
        parent_message_id=root_assistant_id,
    )
    path_assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=4,
        role="assistant",
        content="Path-only decision.",
        parent_message_id=path_user_id,
    )
    sibling_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=5,
        role="user",
        content="Use the sibling branch.",
        parent_message_id=root_assistant_id,
    )
    create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=6,
        role="assistant",
        content="Sibling-only decision must stay out.",
        parent_message_id=sibling_user_id,
    )
    current_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=7,
        role="user",
        content="Continue the path branch.",
        parent_message_id=path_assistant_id,
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=8,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
        parent_message_id=current_user_id,
    )
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=current_user_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    history_text = "\n".join(turn.content for turn in assembly.history)
    assert "Path-only decision." in history_text
    assert "Sibling-only decision must stay out." not in history_text
    assert str(sibling_user_id) not in {
        str(message_id) for message_id in assembly.ledger.included_message_ids
    }


def test_assemble_chat_context_includes_one_assistant_selection_anchor_block(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    root_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Root question",
    )
    root_assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="Alpha beta gamma.",
        parent_message_id=root_user_id,
    )
    current_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=3,
        role="user",
        content="Continue from the selected phrase.",
        parent_message_id=root_assistant_id,
    )
    current_user = db_session.get(Message, current_user_id)
    assert current_user is not None
    current_user.branch_anchor_kind = "assistant_selection"
    current_user.branch_anchor = {
        "message_id": str(root_assistant_id),
        "exact": "beta",
        "prefix": "Alpha ",
        "suffix": " gamma.",
        "offset_status": "mapped",
        "start_offset": 6,
        "end_offset": 10,
        "client_selection_id": "context-anchor-once",
    }
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=4,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
        parent_message_id=current_user_id,
    )
    db_session.commit()
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=current_user_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    branch_blocks = [
        block
        for block in assembly.prompt_plan.blocks()
        if block.id == f"branch_anchor:{current_user_id}"
    ]
    context_anchor_blocks = [
        block for block in assembly.context_blocks if "<assistant_selection>" in block
    ]

    assert len(branch_blocks) == 1, (
        f"Expected exactly one branch-anchor prompt block, got {len(branch_blocks)}"
    )
    assert len(context_anchor_blocks) == 1, (
        f"Expected exactly one branch-anchor context block, got {len(context_anchor_blocks)}"
    )
    assert "<exact>beta</exact>" in branch_blocks[0].text


def test_assemble_chat_context_filters_memory_from_sibling_branch(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    root_user_id = create_test_message(db_session, conversation_id, 1, "user", "Root")
    root_assistant_id = create_test_message(
        db_session, conversation_id, 2, "assistant", "Root answer", parent_message_id=root_user_id
    )
    path_user_id = create_test_message(
        db_session, conversation_id, 3, "user", "Path", parent_message_id=root_assistant_id
    )
    path_assistant_id = create_test_message(
        db_session, conversation_id, 4, "assistant", "Path source", parent_message_id=path_user_id
    )
    sibling_user_id = create_test_message(
        db_session, conversation_id, 5, "user", "Sibling", parent_message_id=root_assistant_id
    )
    sibling_assistant_id = create_test_message(
        db_session,
        conversation_id,
        6,
        "assistant",
        "Sibling source",
        parent_message_id=sibling_user_id,
    )
    current_user_id = create_test_message(
        db_session,
        conversation_id,
        7,
        "user",
        "Current",
        parent_message_id=path_assistant_id,
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id,
        8,
        "assistant",
        "",
        "pending",
        model_id,
        parent_message_id=current_user_id,
    )
    path_memory_id = uuid4()
    sibling_memory_id = uuid4()
    for memory_id, body, source_message_id, seq in [
        (path_memory_id, "Path memory survives.", path_assistant_id, 4),
        (sibling_memory_id, "Sibling memory must not leak.", sibling_assistant_id, 6),
    ]:
        db_session.execute(
            text(
                """
                INSERT INTO conversation_memory_items (
                    id, conversation_id, kind, body, source_required, confidence,
                    valid_from_seq, created_by_message_id, prompt_version
                )
                VALUES (
                    :id, :conversation_id, 'decision', :body, true, 0.9,
                    :seq, :message_id, :prompt_version
                )
                """
            ),
            {
                "id": memory_id,
                "conversation_id": conversation_id,
                "body": body,
                "seq": seq,
                "message_id": source_message_id,
                "prompt_version": PROMPT_VERSION,
            },
        )
        db_session.execute(
            text(
                """
                INSERT INTO conversation_memory_item_sources (
                    memory_item_id, ordinal, source_ref, evidence_role
                )
                VALUES (
                    :memory_item_id, 0, :source_ref, 'supports'
                )
                """
            ).bindparams(bindparam("source_ref", type_=JSONB)),
            {
                "memory_item_id": memory_id,
                "source_ref": {
                    "type": "message",
                    "id": str(source_message_id),
                    "message_id": str(source_message_id),
                },
            },
        )
    db_session.commit()
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=current_user_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    assert path_memory_id in assembly.ledger.included_memory_item_ids
    assert sibling_memory_id not in assembly.ledger.included_memory_item_ids


def test_assemble_chat_context_returns_tool_and_retrieval_events_from_persisted_retrievals(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Search the web for current docs.",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
    )
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
        tool_name="web_search",
        tool_call_index=1,
        query_hash="hash",
        scope="public_web",
        requested_types=["mixed"],
        semantic=False,
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="web_result",
                source_id="web_1",
                context_ref={"type": "web_result", "id": "web_1"},
                result_ref={
                    "type": "web_result",
                    "id": "web_1",
                    "result_type": "web_result",
                    "result_ref": "web_1",
                    "source_id": "web_1",
                    "title": "Docs",
                    "url": "https://example.com/docs",
                    "display_url": "example.com/docs",
                    "deep_link": "https://example.com/docs",
                    "snippet": "Docs snippet",
                    "provider": "test",
                    "source_version": "web_search:test:web_1",
                    "locator": {
                        "type": "external_url",
                        "url": "https://example.com/docs",
                        "title": "Docs",
                        "display_url": "example.com/docs",
                    },
                    "context_ref": {"type": "web_result", "id": "web_1"},
                    "media_id": None,
                    "media_kind": None,
                    "score": 1.0,
                    "selected": True,
                },
                deep_link="https://example.com/docs",
                locator={
                    "type": "external_url",
                    "url": "https://example.com/docs",
                    "title": "Docs",
                    "display_url": "example.com/docs",
                },
                source_version="web_search:test:web_1",
                score=1.0,
                selected=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.commit()

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    assert "web_search" in assembly.context_types
    assert assembly.tool_call_events[0]["tool_name"] == "web_search"
    assert assembly.retrieval_result_events[0]["selected_count"] == 1
    assert assembly.retrieval_result_events[0]["citations"][0]["url"] == (
        "https://example.com/docs"
    )
    assert any("Docs snippet" in block for block in assembly.context_blocks)
    assert len(assembly.ledger.included_retrieval_ids) == 1


def test_assemble_chat_context_manifest_separates_stable_prefix_from_dynamic_blocks(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    old_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Earlier question",
    )
    old_assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="Earlier answer",
    )
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=3,
        role="user",
        content="Current private question",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=4,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    memory_item_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO conversation_memory_items (
                id,
                conversation_id,
                kind,
                body,
                source_required,
                confidence,
                valid_from_seq,
                prompt_version
            )
            VALUES (
                :id,
                :conversation_id,
                'decision',
                'Prefer concise answers.',
                false,
                0.9,
                2,
                :prompt_version
            )
            """
        ),
        {
            "id": memory_item_id,
            "conversation_id": conversation_id,
            "prompt_version": PROMPT_VERSION,
        },
    )
    db_session.commit()
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        environment="test",
        key_mode_used="platform",
        provider_account_boundary="platform",
        max_output_tokens=128,
    )

    blocks = assembly.prompt_plan.blocks()
    stable_prefix = [block.id for block in blocks[:2] if block.cache_policy is not None]
    manifest = assembly.ledger.prompt_block_manifest

    assert stable_prefix == ["system:system-v3", "memory:active"]
    assert assembly.ledger.included_memory_item_ids == (memory_item_id,)
    assert blocks[-1].lane == "current_user"
    assert blocks[-1].text == "Current private question"
    assert [block.role for block in blocks if block.lane == "recent_history"] == [
        "user",
        "assistant",
    ]
    assert str(old_user_id) in str(manifest)
    assert str(old_assistant_id) in str(manifest)
    assert "Current private question" not in str(manifest)
    assert assembly.ledger.stable_prefix_hash == assembly.prompt_plan.stable_prefix_hash
    assert assembly.llm_request.prompt_cache_key == assembly.prompt_plan.stable_prefix_hash
