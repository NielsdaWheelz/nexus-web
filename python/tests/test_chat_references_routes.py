"""Integration tests for GET /api/chat-references/media/{media_id}.

Spec §7.4 / §4.6:
- Returns non-singleton conversations whose messages have at least one
  ``media_context`` attached_context referencing the media.
- Excludes the doc-chat singleton for ``(viewer, media)``.
- Ordered by ``updated_at`` desc.
- Supports ``limit`` (default 50, max 200) + ``offset`` pagination with
  ``next_offset`` echoed in the response when more pages exist.
- Returns 403 ``E_SINGLETON_TARGET_FORBIDDEN`` if the viewer cannot read the
  media; 404 if the media does not exist.
"""

import time
from uuid import UUID

import pytest
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB

from nexus.services.message_context_snapshots import object_ref_context_snapshot
from tests.factories import (
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _attach_media_context_to_message(
    session,
    *,
    user_id: UUID,
    message_id: UUID,
    media_id: UUID,
    title: str,
) -> None:
    session.execute(
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
                'media',
                :media_id,
                0,
                :snapshot
            )
            """
        ).bindparams(bindparam("snapshot", type_=JSONB)),
        {
            "message_id": message_id,
            "user_id": user_id,
            "media_id": media_id,
            "snapshot": object_ref_context_snapshot(
                object_type="media",
                object_id=media_id,
                title=title,
            ),
        },
    )


def test_references_media_lists_referencing_general_conversation(
    auth_client, direct_db: DirectSessionManager
):
    """A general conversation that attached the media as context appears in
    the references list for that media."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Ref Library")
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Referenced Doc"
        )
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session, conversation_id, 1, "user", "Tell me about this doc"
        )
        _attach_media_context_to_message(
            session,
            user_id=user_id,
            message_id=user_message_id,
            media_id=media_id,
            title="Referenced Doc",
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(f"/chat-references/media/{media_id}", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    conv_ids = [item["id"] for item in data["conversations"]]
    assert str(conversation_id) in conv_ids, (
        f"Expected conversation {conversation_id} in references list, got {conv_ids}"
    )
    first = next(item for item in data["conversations"] if item["id"] == str(conversation_id))
    assert first["is_singleton"] is False
    assert first["first_user_message_excerpt"] == "Tell me about this doc"
    assert first["message_count"] == 1


def test_references_media_excludes_singleton(auth_client, direct_db: DirectSessionManager):
    """The viewer's doc-chat singleton for the same media never appears in the
    references list (it would be pinned, not listed)."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Excludes Library")
        media_id = create_test_media_in_library(session, user_id, library_id, title="Excludes Doc")
        # Singleton conversation
        singleton_conv_id = create_test_conversation(session, user_id)
        singleton_user_id = create_test_message(
            session, singleton_conv_id, 1, "user", "First singleton message"
        )
        _attach_media_context_to_message(
            session,
            user_id=user_id,
            message_id=singleton_user_id,
            media_id=media_id,
            title="Excludes Doc",
        )
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
                "conversation_id": singleton_conv_id,
            },
        )
        # General conversation that also references the media
        general_conv_id = create_test_conversation(session, user_id)
        general_user_id = create_test_message(
            session, general_conv_id, 1, "user", "General reference"
        )
        _attach_media_context_to_message(
            session,
            user_id=user_id,
            message_id=general_user_id,
            media_id=media_id,
            title="Excludes Doc",
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", singleton_conv_id)
    direct_db.register_cleanup("conversations", "id", general_conv_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("chat_singletons", "conversation_id", singleton_conv_id)

    response = auth_client.get(f"/chat-references/media/{media_id}", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    conv_ids = [item["id"] for item in data["conversations"]]
    assert str(general_conv_id) in conv_ids
    assert str(singleton_conv_id) not in conv_ids, (
        f"Singleton conversation must not appear in references list; got {conv_ids}"
    )


def test_references_media_orders_by_recency(auth_client, direct_db: DirectSessionManager):
    """References are ordered by ``updated_at`` desc (most-recent first)."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Order Library")
        media_id = create_test_media_in_library(session, user_id, library_id, title="Ordered Doc")
        # Three referencing conversations with controlled timestamps.
        conv_old_id = create_test_conversation(session, user_id)
        conv_mid_id = create_test_conversation(session, user_id)
        conv_new_id = create_test_conversation(session, user_id)
        for conv_id, content in (
            (conv_old_id, "Oldest reference"),
            (conv_mid_id, "Middle reference"),
            (conv_new_id, "Newest reference"),
        ):
            msg_id = create_test_message(session, conv_id, 1, "user", content)
            _attach_media_context_to_message(
                session,
                user_id=user_id,
                message_id=msg_id,
                media_id=media_id,
                title="Ordered Doc",
            )
        # Force deterministic timestamps.
        session.execute(
            text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
            {"ts": "2026-01-01T00:00:00+00:00", "id": conv_old_id},
        )
        session.execute(
            text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
            {"ts": "2026-01-02T00:00:00+00:00", "id": conv_mid_id},
        )
        session.execute(
            text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
            {"ts": "2026-01-03T00:00:00+00:00", "id": conv_new_id},
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conv_old_id)
    direct_db.register_cleanup("conversations", "id", conv_mid_id)
    direct_db.register_cleanup("conversations", "id", conv_new_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(f"/chat-references/media/{media_id}", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    ordered_ids = [item["id"] for item in response.json()["data"]["conversations"]]
    assert ordered_ids[:3] == [
        str(conv_new_id),
        str(conv_mid_id),
        str(conv_old_id),
    ], f"Expected newest-first ordering, got {ordered_ids}"


def test_references_media_pagination_offset_limit(auth_client, direct_db: DirectSessionManager):
    """``limit`` + ``offset`` paginate; ``next_offset`` is set when more pages
    exist and is None on the last page."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Pagination Library")
        media_id = create_test_media_in_library(session, user_id, library_id, title="Paginated Doc")
        conv_ids: list[UUID] = []
        for i in range(3):
            cid = create_test_conversation(session, user_id)
            msg_id = create_test_message(session, cid, 1, "user", f"Reference {i}")
            _attach_media_context_to_message(
                session,
                user_id=user_id,
                message_id=msg_id,
                media_id=media_id,
                title="Paginated Doc",
            )
            session.execute(
                text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
                {"ts": f"2026-01-{10 + i:02d}T00:00:00+00:00", "id": cid},
            )
            conv_ids.append(cid)
        session.commit()
    for cid in conv_ids:
        direct_db.register_cleanup("conversations", "id", cid)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    first_page = auth_client.get(
        f"/chat-references/media/{media_id}?limit=2&offset=0",
        headers=auth_headers(user_id),
    )
    assert first_page.status_code == 200, first_page.text
    first_data = first_page.json()["data"]
    assert len(first_data["conversations"]) == 2
    assert first_data["next_offset"] == 2

    second_page = auth_client.get(
        f"/chat-references/media/{media_id}?limit=2&offset=2",
        headers=auth_headers(user_id),
    )
    assert second_page.status_code == 200, second_page.text
    second_data = second_page.json()["data"]
    assert len(second_data["conversations"]) == 1
    assert second_data["next_offset"] is None

    # No duplicates across pages.
    all_ids = [item["id"] for item in first_data["conversations"] + second_data["conversations"]]
    assert len(set(all_ids)) == 3
    assert isinstance(time.time(), float)  # silence unused import warning


def test_references_media_forbidden_for_invisible_media(
    auth_client, direct_db: DirectSessionManager
):
    """If the viewer cannot read the media, the references endpoint returns 403
    E_SINGLETON_TARGET_FORBIDDEN (same access check used by the singleton
    read endpoints)."""
    owner_id = create_test_user_id()
    other_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    auth_client.get("/me", headers=auth_headers(other_id))

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Forbidden Library")
        media_id = create_test_media_in_library(
            session, owner_id, library_id, title="Forbidden Doc"
        )
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    response = auth_client.get(f"/chat-references/media/{media_id}", headers=auth_headers(other_id))

    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "E_SINGLETON_TARGET_FORBIDDEN"
