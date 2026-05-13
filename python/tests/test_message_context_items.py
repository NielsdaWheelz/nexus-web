from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import ObjectLink
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.notes import CreateMessageContextItemRequest, CreatePageRequest
from nexus.services import contexts as contexts_service
from nexus.services import notes
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.context_assembler import load_message_context_refs, message_context_ref_payloads
from nexus.services.context_lookup import hydrate_context_ref, hydrate_source_ref
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.conversations import load_message_context_snapshots_for_message_ids
from nexus.services.message_context_items import create_message_context_item
from nexus.services.retrieval_planner import build_retrieval_plan
from tests.factories import (
    create_test_conversation,
    create_test_media_in_library,
    create_test_message,
)


def _default_library_id(db_session, user_id: UUID) -> UUID:
    return db_session.execute(
        text(
            """
            SELECT id
            FROM libraries
            WHERE owner_user_id = :user_id
              AND is_default = true
            """
        ),
        {"user_id": user_id},
    ).scalar_one()


@pytest.mark.integration
def test_create_message_context_item_requires_conversation_owner_write(
    db_session,
    bootstrapped_user,
):
    owner_id = bootstrapped_user
    reader_id = uuid4()
    ensure_user_and_default_library(db_session, reader_id)
    conversation_id = create_test_conversation(db_session, owner_id, sharing="public")
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="public readable message",
    )

    with pytest.raises(NotFoundError) as error:
        create_message_context_item(
            db_session,
            reader_id,
            CreateMessageContextItemRequest(
                message_id=message_id,
                object_type="message",
                object_id=message_id,
            ),
        )

    assert error.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND


@pytest.mark.integration
def test_create_message_context_item_writes_link_and_conversation_media(
    db_session,
    bootstrapped_user,
):
    user_id = bootstrapped_user
    library_id = _default_library_id(db_session, user_id)
    media_id = create_test_media_in_library(
        db_session,
        user_id,
        library_id,
        title=f"Context media {uuid4()}",
    )
    conversation_id = create_test_conversation(db_session, user_id)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="attach media context",
    )

    item = create_message_context_item(
        db_session,
        user_id,
        CreateMessageContextItemRequest(
            message_id=message_id,
            object_type="media",
            object_id=media_id,
        ),
    )

    stored_user_id = db_session.execute(
        text("SELECT user_id FROM message_context_items WHERE id = :id"),
        {"id": item.id},
    ).scalar_one()
    link_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM object_links
            WHERE user_id = :user_id
              AND relation_type = 'used_as_context'
              AND a_type = 'message'
              AND a_id = :message_id
              AND b_type = 'media'
              AND b_id = :media_id
            """
        ),
        {"user_id": user_id, "message_id": message_id, "media_id": media_id},
    ).scalar_one()
    conversation_media_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM conversation_media
            WHERE conversation_id = :conversation_id
              AND media_id = :media_id
            """
        ),
        {"conversation_id": conversation_id, "media_id": media_id},
    ).scalar_one()

    assert stored_user_id == user_id
    assert link_count == 1
    assert conversation_media_count == 1


@pytest.mark.integration
def test_chat_context_insert_skips_reverse_duplicate_object_link(
    db_session,
    bootstrapped_user,
):
    user_id = bootstrapped_user
    page = notes.create_page(
        db_session,
        user_id,
        CreatePageRequest(title=f"Chat reverse link context {uuid4()}"),
    )
    conversation_id = create_test_conversation(db_session, user_id)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="attach page context",
    )
    db_session.add(
        ObjectLink(
            user_id=user_id,
            relation_type="used_as_context",
            a_type="page",
            a_id=page.id,
            b_type="message",
            b_id=message_id,
            b_order_key="0000000001",
            metadata_json={},
        )
    )
    db_session.commit()

    item = contexts_service.insert_context(
        db_session,
        message_id=message_id,
        ordinal=0,
        context=MessageContextRef(type="page", id=page.id),
    )
    db_session.commit()

    link_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM object_links
            WHERE user_id = :user_id
              AND relation_type = 'used_as_context'
              AND a_locator IS NULL
              AND b_locator IS NULL
              AND (
                    (a_type = 'message' AND a_id = :message_id AND b_type = 'page' AND b_id = :page_id)
                 OR (a_type = 'page' AND a_id = :page_id AND b_type = 'message' AND b_id = :message_id)
              )
            """
        ),
        {"user_id": user_id, "message_id": message_id, "page_id": page.id},
    ).scalar_one()

    assert item.object_type == "page"
    assert item.object_id == page.id
    assert link_count == 1


@pytest.mark.integration
def test_contributor_message_context_roundtrips_with_handle(
    db_session,
    bootstrapped_user,
):
    user_id = bootstrapped_user
    media_id = create_test_media_in_library(
        db_session,
        user_id,
        _default_library_id(db_session, user_id),
        title=f"Contributor context {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Context Contributor", "role": "author", "source": "manual"}],
    )
    contributor_id, contributor_handle = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    conversation_id = create_test_conversation(db_session, user_id)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="attach contributor context",
    )

    item = create_message_context_item(
        db_session,
        user_id,
        CreateMessageContextItemRequest(
            message_id=message_id,
            object_type="contributor",
            object_id=contributor_id,
        ),
    )
    snapshots = load_message_context_snapshots_for_message_ids(db_session, [message_id])
    snapshot_payload = snapshots[message_id][0].model_dump(mode="json")
    id_result = hydrate_context_ref(
        db_session,
        viewer_id=user_id,
        context_ref={"type": "contributor", "id": str(contributor_id)},
    )
    source_result = hydrate_source_ref(
        db_session,
        viewer_id=user_id,
        source_ref={"type": "message_context", "id": str(item.id)},
    )

    assert snapshot_payload["type"] == "contributor"
    assert snapshot_payload["id"] == contributor_handle
    assert snapshot_payload["route"] == f"/authors/{contributor_handle}"
    assert id_result.resolved is True
    assert id_result.context_ref == {
        "type": "contributor",
        "id": contributor_handle,
        "contributor_handle": contributor_handle,
    }
    assert (
        f"<contributor_handle>{contributor_handle}</contributor_handle>" in id_result.evidence_text
    )
    assert source_result.resolved is True
    assert source_result.context_ref == {
        "type": "contributor",
        "id": contributor_handle,
        "contributor_handle": contributor_handle,
    }

    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    hidden_result = hydrate_context_ref(
        db_session,
        viewer_id=other_user_id,
        context_ref={"type": "contributor", "id": contributor_handle},
    )
    assert hidden_result.resolved is False
    assert hidden_result.failure is not None
    assert hidden_result.failure.code == "not_found"

    refs = load_message_context_refs(db_session, message_id)
    ref_payloads = message_context_ref_payloads(db_session, refs)
    retrieval_plan = build_retrieval_plan(
        user_content="find saved work by this author",
        history=[],
        scope_metadata={"type": "general"},
        attached_context_refs=ref_payloads,
        memory_source_refs=[],
        web_search_options={"mode": "off"},
    )
    assert retrieval_plan.app_search.filters["contributor_handles"] == [contributor_handle]


@pytest.mark.integration
def test_create_message_context_item_rejects_client_shaped_snapshot(
    db_session,
    bootstrapped_user,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="attach a context with a spoofed snapshot",
    )

    with pytest.raises(ApiError) as error:
        create_message_context_item(
            db_session,
            bootstrapped_user,
            CreateMessageContextItemRequest(
                message_id=message_id,
                object_type="message",
                object_id=message_id,
                context_snapshot={"label": "client supplied label"},
            ),
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
