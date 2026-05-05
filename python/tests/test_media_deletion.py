"""Document deletion hard-cutover tests."""

from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.db.models import Fragment
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from tests.factories import create_test_conversation_with_message, create_test_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_delete_document_hides_shared_member_copy(auth_client, direct_db: DirectSessionManager):
    owner_id = create_test_user_id()
    member_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    member_default_id = auth_client.get("/me", headers=auth_headers(member_id)).json()["data"][
        "default_library_id"
    ]

    library_id = auth_client.post(
        "/libraries",
        json={"name": "Shared"},
        headers=auth_headers(owner_id),
    ).json()["data"]["id"]

    with direct_db.session() as session:
        media_id = create_test_media(session)
        fragment_id = UUID(
            str(
                session.execute(
                    text("""
                        INSERT INTO fragments (media_id, idx, html_sanitized, canonical_text)
                        VALUES (:media_id, 0, '<p>Shared chunk</p>', 'Shared chunk text')
                        RETURNING id
                    """),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        fragment = session.get(Fragment, fragment_id)
        assert fragment is not None
        insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
        rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment.id}",
            fragments=[fragment],
            reason="test",
        )
        content_chunk_id = UUID(
            str(
                session.execute(
                    text("""
                        SELECT id
                        FROM content_chunks
                        WHERE media_id = :media_id
                        ORDER BY chunk_idx ASC
                        LIMIT 1
                    """),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        conversation_id, message_id = create_test_conversation_with_message(
            session,
            member_id,
            content="Member context",
        )
        session.execute(
            text("""
                INSERT INTO message_context_items (
                    message_id, user_id, object_type, object_id, ordinal, context_snapshot
                )
                VALUES (
                    :message_id, :user_id, 'content_chunk', :content_chunk_id, 0, '{}'::jsonb
                )
            """),
            {
                "message_id": message_id,
                "user_id": member_id,
                "content_chunk_id": content_chunk_id,
            },
        )
        session.execute(
            text("""
                INSERT INTO object_links (
                    user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                )
                VALUES (
                    :user_id, 'used_as_context', 'message', :message_id,
                    'content_chunk', :content_chunk_id, '{}'::jsonb
                )
            """),
            {
                "user_id": member_id,
                "message_id": message_id,
                "content_chunk_id": content_chunk_id,
            },
        )
        session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'member')
            """),
            {"library_id": library_id, "user_id": member_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("message_context_items", "object_id", content_chunk_id)
    direct_db.register_cleanup("object_links", "b_id", content_chunk_id)
    direct_db.register_cleanup("content_chunks", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("user_media_deletions", "media_id", media_id)

    add_response = auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(owner_id),
    )
    assert add_response.status_code == 201, add_response.json()
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(member_id)).status_code == 200

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(member_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["status"] == "hidden"
    assert delete_response.json()["data"]["hard_deleted"] is False
    assert delete_response.json()["data"]["hidden_for_viewer"] is True
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(member_id)).status_code == 404
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(owner_id)).status_code == 200

    with direct_db.session() as session:
        counts = session.execute(
            text("""
                SELECT
                    (SELECT count(*) FROM message_context_items
                     WHERE object_type = 'content_chunk'
                       AND object_id = :content_chunk_id),
                    (SELECT count(*) FROM object_links
                     WHERE user_id = :member_id
                       AND (
                            (a_type = 'content_chunk' AND a_id = :content_chunk_id)
                         OR (b_type = 'content_chunk' AND b_id = :content_chunk_id)
                       ))
            """),
            {"member_id": member_id, "content_chunk_id": content_chunk_id},
        ).one()
    assert counts == (0, 0)

    save_response = auth_client.post(
        f"/libraries/{member_default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(member_id),
    )
    assert save_response.status_code == 201, save_response.json()
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(member_id)).status_code == 200

    with direct_db.session() as session:
        tombstone = session.execute(
            text("""
                SELECT 1
                FROM user_media_deletions
                WHERE user_id = :user_id
                  AND media_id = :media_id
            """),
            {"user_id": member_id, "media_id": media_id},
        ).fetchone()
    assert tombstone is None


def test_delete_document_removes_default_and_administered_libraries(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]
    work_id = auth_client.post(
        "/libraries",
        json={"name": "Work"},
        headers=auth_headers(user_id),
    ).json()["data"]["id"]

    with direct_db.session() as session:
        media_id = create_test_media(session)

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)

    for library_id in (default_id, work_id):
        response = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 201, response.json()

    response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert response.status_code == 200, response.json()
    assert response.json()["data"] == {
        "status": "deleted",
        "hard_deleted": True,
        "removed_from_library_ids": [default_id, work_id],
        "hidden_for_viewer": False,
        "remaining_reference_count": 0,
    }

    with direct_db.session() as session:
        row = session.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).fetchone()
    assert row is None


def test_delete_document_hard_deletes_web_article_fragments_and_chunks(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]

    with direct_db.session() as session:
        media_id = create_test_media(session)
        fragment_id = UUID(
            str(
                session.execute(
                    text("""
                        INSERT INTO fragments (media_id, idx, html_sanitized, canonical_text)
                        VALUES (:media_id, 0, '<p>Hello</p>', 'Hello world')
                        RETURNING id
                    """),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        fragment = session.get(Fragment, fragment_id)
        assert fragment is not None
        insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
        rebuild_fragment_content_index(
            session,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment.id}",
            fragments=[fragment],
            reason="test",
        )
        content_chunk_id = UUID(
            str(
                session.execute(
                    text(
                        """
                        SELECT id
                        FROM content_chunks
                        WHERE media_id = :media_id
                        ORDER BY chunk_idx ASC
                        LIMIT 1
                        """
                    ),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        conversation_id, message_id = create_test_conversation_with_message(
            session,
            user_id,
            content="Message with content chunk context",
        )
        session.execute(
            text(
                """
                INSERT INTO message_context_items (
                    message_id, user_id, object_type, object_id, ordinal, context_snapshot
                )
                VALUES (
                    :message_id, :user_id, 'content_chunk', :content_chunk_id, 0, '{}'::jsonb
                )
                """
            ),
            {
                "message_id": message_id,
                "user_id": user_id,
                "content_chunk_id": content_chunk_id,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO object_links (
                    user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                )
                VALUES
                    (
                        :user_id, 'used_as_context', 'message', :message_id,
                        'content_chunk', :content_chunk_id, '{}'::jsonb
                    ),
                    (
                        :user_id, 'references', 'content_chunk', :content_chunk_id,
                        'media', :media_id, '{}'::jsonb
                    )
                """
            ),
            {
                "user_id": user_id,
                "message_id": message_id,
                "content_chunk_id": content_chunk_id,
                "media_id": media_id,
            },
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("object_links", "b_id", content_chunk_id)
    direct_db.register_cleanup("object_links", "a_id", content_chunk_id)
    direct_db.register_cleanup("message_context_items", "object_id", content_chunk_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("content_chunks", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

    add_response = auth_client.post(
        f"/libraries/{default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert add_response.status_code == 201, add_response.json()

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["status"] == "deleted"

    with direct_db.session() as session:
        counts = session.execute(
            text("""
                SELECT
                    (SELECT count(*) FROM media WHERE id = :media_id),
                    (SELECT count(*) FROM fragments WHERE media_id = :media_id),
                    (SELECT count(*) FROM content_chunks WHERE media_id = :media_id),
                    (SELECT count(*) FROM message_context_items
                     WHERE object_type = 'content_chunk'
                       AND object_id = :content_chunk_id),
                    (SELECT count(*) FROM object_links
                     WHERE (a_type = 'content_chunk' AND a_id = :content_chunk_id)
                        OR (b_type = 'content_chunk' AND b_id = :content_chunk_id))
            """),
            {"media_id": media_id, "content_chunk_id": content_chunk_id},
        ).one()
    assert counts == (0, 0, 0, 0, 0)
