"""Integration tests for GET /api/chat-singletons/{media|library}/{id}.

Spec §7.2 / §7.3:
- Returns ``{conversation_id, message_count}`` with both fields zeroed when no
  singleton exists yet (lazy materialization happens only on POST /chat-runs).
- Returns 403 ``E_SINGLETON_TARGET_FORBIDDEN`` if the viewer cannot read the
  target media / cannot see the library.
- Returns 404 if the target media / library does not exist.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.factories import (
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_get_singleton_media_null_when_absent(
    auth_client, direct_db: DirectSessionManager
):
    """No chat_singletons row yet → ``conversation_id: null, message_count: 0``."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Absent Singleton Library")
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Absent Singleton Doc"
        )
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(
        f"/chat-singletons/media/{media_id}", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {"conversation_id": None, "message_count": 0}


def test_get_singleton_media_returns_conversation_when_present(
    auth_client, direct_db: DirectSessionManager
):
    """When a chat_singletons row exists, the read endpoint returns its
    ``conversation_id`` along with the current message count."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Present Singleton Library")
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Present Singleton Doc"
        )
        conversation_id = create_test_conversation(session, user_id)
        create_test_message(session, conversation_id, 1, "user", "First")
        session.execute(
            text(
                """
                INSERT INTO chat_singletons (user_id, kind, target_id, conversation_id)
                VALUES (:user_id, 'media', :media_id, :conversation_id)
                """
            ),
            {
                "user_id": user_id,
                "media_id": media_id,
                "conversation_id": conversation_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)

    response = auth_client.get(
        f"/chat-singletons/media/{media_id}", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["conversation_id"] == str(conversation_id)
    assert data["message_count"] == 1


def test_get_singleton_library_null_when_absent(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Absent Library Singleton")
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(
        f"/chat-singletons/library/{library_id}", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {"conversation_id": None, "message_count": 0}


def test_get_singleton_library_returns_conversation_when_present(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Present Library Singleton")
        conversation_id = create_test_conversation(session, user_id)
        create_test_message(session, conversation_id, 1, "user", "Library hello")
        create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "Library hi",
        )
        session.execute(
            text(
                """
                INSERT INTO chat_singletons (user_id, kind, target_id, conversation_id)
                VALUES (:user_id, 'library', :library_id, :conversation_id)
                """
            ),
            {
                "user_id": user_id,
                "library_id": library_id,
                "conversation_id": conversation_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)

    response = auth_client.get(
        f"/chat-singletons/library/{library_id}", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["conversation_id"] == str(conversation_id)
    assert data["message_count"] == 2


def test_get_singleton_forbidden_when_media_invisible(
    auth_client, direct_db: DirectSessionManager
):
    """If the viewer has no read access to a media that exists, the endpoint
    returns 403 E_SINGLETON_TARGET_FORBIDDEN (the route splits 404 vs 403
    explicitly per ``_require_media_visible_to_viewer``)."""
    owner_id = create_test_user_id()
    other_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    auth_client.get("/me", headers=auth_headers(other_id))

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Private Library")
        media_id = create_test_media_in_library(
            session, owner_id, library_id, title="Private Doc"
        )
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(
        f"/chat-singletons/media/{media_id}", headers=auth_headers(other_id)
    )

    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "E_SINGLETON_TARGET_FORBIDDEN"


def test_get_singleton_media_404_when_missing(
    auth_client, direct_db: DirectSessionManager
):
    """Per §7.2 the read endpoint distinguishes missing media (404) from
    access-denied (403). The route asserts both branches via
    ``_require_media_visible_to_viewer``."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    missing_media_id = uuid4()

    response = auth_client.get(
        f"/chat-singletons/media/{missing_media_id}", headers=auth_headers(user_id)
    )

    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
    # silence unused; keeps cleanup signature uniform across tests in this file
    assert isinstance(direct_db, DirectSessionManager)
    assert isinstance(UUID(str(missing_media_id)), UUID)
