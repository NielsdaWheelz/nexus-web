"""Real-API proof for authoritative message-deletion cascade receipts."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Engine, event, func, select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import Conversation, Message
from nexus.schemas.conversation import MessageDeleteOut
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.conversations import delete_message
from nexus.services.seq import assign_next_message_seq
from tests.testkit.auth import UserRecord
from tests.testkit.chat import create_entitled_chat


def test_deleting_root_subtree_returns_authoritative_conversation_cascade_receipt(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    chat = create_entitled_chat(
        db_session,
        user_id=test_user.id,
        content="Delete this entire message tree.",
    )
    root_message_id = db_session.scalar(
        select(Message.id)
        .where(Message.conversation_id == chat.conversation_id)
        .order_by(Message.seq.asc(), Message.id.asc())
        .limit(1)
    )
    assert root_message_id is not None
    before_revision = read_collection_revision(
        db_session,
        viewer_id=test_user.id,
        family=CollectionFamily.ConversationIndex,
    )

    response = authenticated_client.delete(f"/messages/{root_message_id}")

    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt == {
        "conversationId": str(chat.conversation_id),
        "conversationDeleted": True,
        "collectionRevision": before_revision + 1,
    }
    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.ConversationIndex,
        )
        == receipt["collectionRevision"]
    )

    missing = authenticated_client.get(f"/conversations/{chat.conversation_id}")
    assert missing.status_code == 404, missing.text


def test_deleting_leaf_returns_receipt_without_conversation_cascade(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    chat = create_entitled_chat(
        db_session,
        user_id=test_user.id,
        content="Keep the root while deleting this pending reply.",
    )
    message_ids = list(
        db_session.scalars(
            select(Message.id)
            .where(Message.conversation_id == chat.conversation_id)
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )
    assert len(message_ids) == 2

    response = authenticated_client.delete(f"/messages/{message_ids[-1]}")

    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt["conversationId"] == str(chat.conversation_id)
    assert receipt["conversationDeleted"] is False
    assert isinstance(receipt["collectionRevision"], int)

    retained = authenticated_client.get(f"/conversations/{chat.conversation_id}")
    assert retained.status_code == 200, retained.text
    assert retained.json()["data"]["message_count"] == 1


def _delete_in_connection(
    connection: Connection,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> MessageDeleteOut:
    with Session(bind=connection) as db:
        return delete_message(db, viewer_id=viewer_id, message_id=message_id)


def test_message_delete_linearizes_after_concurrent_message_insert(engine: Engine) -> None:
    viewer_id = uuid4()
    conversation_id = uuid4()
    root_message_id = uuid4()
    inserted_message_id = uuid4()
    with Session(engine) as seed:
        ensure_user_and_default_library(
            seed,
            viewer_id,
            f"message-delete-lock-{viewer_id}@example.invalid",
        )
        seed.add(
            Conversation(
                id=conversation_id,
                owner_user_id=viewer_id,
                title="Concurrent delete receipt",
                next_seq=2,
            )
        )
        seed.add(
            Message(
                id=root_message_id,
                conversation_id=conversation_id,
                seq=1,
                role="system",
                content="Delete this original message.",
                status="complete",
            )
        )
        seed.commit()

    lock_attempted = Event()
    with Session(engine) as inserting:
        inserted_seq = assign_next_message_seq(inserting, conversation_id)
        inserting.add(
            Message(
                id=inserted_message_id,
                conversation_id=conversation_id,
                seq=inserted_seq,
                role="system",
                content="This committed concurrent message retains the chat.",
                status="complete",
            )
        )
        inserting.flush()

        with engine.connect() as delete_connection:

            def observe_parent_lock(
                _connection: Connection,
                _cursor: Any,
                statement: str,
                _parameters: Any,
                _context: Any,
                _executemany: bool,
            ) -> None:
                normalized = " ".join(statement.upper().split())
                if "FROM CONVERSATIONS" in normalized and "FOR UPDATE" in normalized:
                    lock_attempted.set()

            event.listen(delete_connection, "before_cursor_execute", observe_parent_lock)
            try:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    deletion = pool.submit(
                        _delete_in_connection,
                        delete_connection,
                        viewer_id=viewer_id,
                        message_id=root_message_id,
                    )
                    observed_lock = lock_attempted.wait(timeout=5)
                    delete_waited_for_parent = not deletion.done()
                    inserting.commit()
                    receipt = deletion.result(timeout=5)
            finally:
                event.remove(delete_connection, "before_cursor_execute", observe_parent_lock)

    assert observed_lock, "message deletion never attempted the parent Conversation lock"
    assert delete_waited_for_parent, "message deletion did not wait for the parent lock"
    assert receipt.conversation_id == conversation_id
    assert receipt.conversation_deleted is False

    with Session(engine) as oracle:
        assert oracle.get(Conversation, conversation_id) is not None
        assert (
            oracle.scalar(
                select(func.count())
                .select_from(Message)
                .where(Message.conversation_id == conversation_id)
            )
            == 1
        )
        assert oracle.get(Message, inserted_message_id) is not None
