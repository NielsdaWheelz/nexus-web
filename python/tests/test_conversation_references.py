"""Integration tests for the conversation_references service.

Exercises the read/write surface defined in
``nexus.services.conversation_references``: list, add, remove, idempotent
insert via the citation pipeline, and the cross-conversation lookup by
URI. Assertions go through the service rather than raw SQL except where
the test specifically targets the UNIQUE (conversation_id, resource_uri)
constraint.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ForbiddenError, InvalidRequestError, NotFoundError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversation_references import (
    add_reference,
    insert_reference_if_absent,
    list_conversations_with_reference,
    list_references,
    remove_reference,
)
from tests.factories import (
    create_test_conversation,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.test_resource_resolver import _make_oracle_reading
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


# =============================================================================
# Add / List / Remove
# =============================================================================


def test_add_reference_returns_resolved_row_with_metadata(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Referenced Doc"
    )
    uri = f"media:{media_id}"

    added = add_reference(db_session, conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()

    assert added.resource_uri == uri, f"Added row should echo the URI; got {added.resource_uri}"
    assert "Referenced Doc" in added.label, (
        f"Added row label should reflect resolver hydration; got {added.label}"
    )


def test_add_reference_accepts_oracle_reading_scheme(db_session: Session, bootstrapped_user: UUID):
    """S7: an oracle_reading: URI is admissible via the shared scheme validation
    (conversation create routes initial_references through the same path)."""
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    reading_id = _make_oracle_reading(db_session, bootstrapped_user, motto="Nosce Te Ipsum")
    uri = f"oracle_reading:{reading_id}"

    added = add_reference(db_session, conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()

    assert added.resource_uri == uri
    assert added.label == "Folio 1 — Nosce Te Ipsum", (
        f"the resolved label should reflect the reading; got {added.label}"
    )
    assert not added.missing


def test_add_reference_idempotent_on_unique_pair(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Idempotent Doc"
    )
    uri = f"media:{media_id}"

    first = add_reference(db_session, conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()
    second = add_reference(db_session, conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()

    assert first.id == second.id, (
        f"Adding the same URI twice must return the existing row id; got "
        f"first={first.id} second={second.id}"
    )

    rows = list_references(db_session, conversation_id, viewer_id=bootstrapped_user)
    assert len(rows) == 1, (
        f"Conversation should hold exactly one row after idempotent add; got {len(rows)}"
    )


def test_add_reference_unknown_resource_raises_not_found(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)

    with pytest.raises(NotFoundError):
        add_reference(
            db_session,
            conversation_id,
            f"media:{uuid4()}",
            viewer_id=bootstrapped_user,
        )


def test_add_reference_invalid_uri_raises(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)

    with pytest.raises(InvalidRequestError, match="Invalid resource_uri"):
        add_reference(
            db_session,
            conversation_id,
            "not-a-real-uri-format",
            viewer_id=bootstrapped_user,
        )


def test_add_reference_owner_only_access_blocks_other_users(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_conversation_id = create_test_conversation(db_session, other_user_id)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Some Doc"
    )

    with pytest.raises((ForbiddenError, NotFoundError)):
        add_reference(
            db_session,
            other_conversation_id,
            f"media:{media_id}",
            viewer_id=bootstrapped_user,
        )


def test_list_references_returns_created_at_ascending(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    first_media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="First Doc"
    )
    second_media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Second Doc"
    )

    add_reference(
        db_session, conversation_id, f"media:{first_media_id}", viewer_id=bootstrapped_user
    )
    db_session.commit()
    add_reference(
        db_session, conversation_id, f"media:{second_media_id}", viewer_id=bootstrapped_user
    )
    db_session.commit()

    rows = list_references(db_session, conversation_id, viewer_id=bootstrapped_user)

    assert [row.resource_uri for row in rows] == [
        f"media:{first_media_id}",
        f"media:{second_media_id}",
    ], f"References should be ordered by created_at ASC; got {[row.resource_uri for row in rows]}"


def test_remove_reference_drops_row(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Doomed Doc"
    )

    added = add_reference(
        db_session, conversation_id, f"media:{media_id}", viewer_id=bootstrapped_user
    )
    db_session.commit()
    remove_reference(db_session, conversation_id, added.id, viewer_id=bootstrapped_user)

    rows = list_references(db_session, conversation_id, viewer_id=bootstrapped_user)
    assert rows == [], f"Conversation should hold zero references after remove; got {rows}"


def test_remove_reference_unknown_id_raises_not_found(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)

    with pytest.raises(NotFoundError):
        remove_reference(db_session, conversation_id, uuid4(), viewer_id=bootstrapped_user)


# =============================================================================
# API contract
# =============================================================================


def test_reference_api_rejects_unsupported_uri_field(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_references", "conversation_id", conversation_id)

    response = auth_client.post(
        f"/conversations/{conversation_id}/references",
        headers=auth_headers(user_id),
        json={"uri": f"media:{uuid4()}"},
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_reference_api_add_returns_strict_resolved_payload(
    auth_client,
    direct_db: DirectSessionManager,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session,
            user_id,
            library_id,
            title="Reference API Doc",
        )
        conversation_id = create_test_conversation(session, user_id)

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_references", "conversation_id", conversation_id)

    resource_uri = f"media:{media_id}"
    response = auth_client.post(
        f"/conversations/{conversation_id}/references",
        headers=auth_headers(user_id),
        json={"resource_uri": resource_uri},
    )

    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["resource_uri"] == resource_uri
    assert data["conversation_id"] == str(conversation_id)
    assert "Reference API Doc" in data["label"]
    assert "uri" not in data
    assert {"fetch_hint", "summary", "inline_body", "missing", "created_at"} <= set(data)

    duplicate_response = auth_client.post(
        f"/conversations/{conversation_id}/references",
        headers=auth_headers(user_id),
        json={"resource_uri": resource_uri},
    )

    assert duplicate_response.status_code == 201, duplicate_response.text
    assert duplicate_response.json()["data"]["id"] == data["id"]
    with direct_db.session() as session:
        row_count = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM conversation_references
                WHERE conversation_id = :conversation_id
                  AND resource_uri = :resource_uri
                """
            ),
            {"conversation_id": conversation_id, "resource_uri": resource_uri},
        ).scalar_one()
    assert row_count == 1


# =============================================================================
# Citation pipeline write-through
# =============================================================================


def test_insert_reference_if_absent_returns_row_on_first_insert(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Citation Source"
    )
    uri = f"media:{media_id}"

    inserted = insert_reference_if_absent(db_session, conversation_id, uri)
    db_session.commit()

    assert inserted is not None, "First insert should return the newly inserted row"
    assert inserted.resource_uri == uri


def test_insert_reference_if_absent_returns_none_when_present(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Repeat Citation"
    )
    uri = f"media:{media_id}"

    insert_reference_if_absent(db_session, conversation_id, uri)
    db_session.commit()
    second = insert_reference_if_absent(db_session, conversation_id, uri)
    db_session.commit()

    assert second is None, (
        f"Repeat insert should return None to skip the SSE emission path; got {second!r}"
    )

    row_count = db_session.execute(
        text(
            """
            SELECT COUNT(*) FROM conversation_references
            WHERE conversation_id = :conversation_id
              AND resource_uri = :resource_uri
            """
        ),
        {"conversation_id": conversation_id, "resource_uri": uri},
    ).scalar_one()
    assert row_count == 1, (
        f"Unique constraint must keep the row count at 1 after repeat insert; got {row_count}"
    )


# =============================================================================
# Cross-conversation lookup
# =============================================================================


def test_list_conversations_with_reference_returns_owned_holders(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Shared Doc"
    )
    uri = f"media:{media_id}"

    first_conversation_id = create_test_conversation(db_session, bootstrapped_user)
    second_conversation_id = create_test_conversation(db_session, bootstrapped_user)
    no_ref_conversation_id = create_test_conversation(db_session, bootstrapped_user)

    add_reference(db_session, first_conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()
    add_reference(db_session, second_conversation_id, uri, viewer_id=bootstrapped_user)
    db_session.commit()

    conversations, page = list_conversations_with_reference(
        db_session, uri, viewer_id=bootstrapped_user
    )

    ids = {conv.id for conv in conversations}
    assert first_conversation_id in ids, f"Expected first conversation in results; got {ids}"
    assert second_conversation_id in ids, f"Expected second conversation in results; got {ids}"
    assert no_ref_conversation_id not in ids, (
        f"Conversation without the reference should not appear; got {ids}"
    )
    assert page.next_cursor is None, (
        f"Two-row result should not paginate; got next_cursor={page.next_cursor}"
    )


def test_list_conversations_with_reference_excludes_other_owners(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Owner-only Doc"
    )
    uri = f"media:{media_id}"

    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_conversation_id = create_test_conversation(db_session, other_user_id)
    insert_reference_if_absent(db_session, other_conversation_id, uri)
    db_session.commit()

    conversations, _ = list_conversations_with_reference(
        db_session, uri, viewer_id=bootstrapped_user
    )

    assert other_conversation_id not in {c.id for c in conversations}, (
        f"Cross-owner conversations must not leak; got {[c.id for c in conversations]}"
    )
