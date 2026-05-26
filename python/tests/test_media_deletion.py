"""Document deletion behavior tests."""

from uuid import UUID

import pytest
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.message_context_snapshots import object_ref_context_snapshot
from tests.factories import (
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_library,
    create_test_media,
    create_test_media_in_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _content_chunk_context_snapshot(
    session: Session,
    content_chunk_id: UUID,
) -> dict[str, object]:
    row = (
        session.execute(
            text("""
                SELECT
                    cc.id AS content_chunk_id,
                    cc.media_id,
                    cc.chunk_text,
                    m.kind AS media_kind,
                    m.title AS media_title,
                    es.id AS evidence_span_id,
                    es.resolver_kind,
                    es.selector,
                    es.span_text,
                    ss.source_version
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
                JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                JOIN source_snapshots ss ON ss.id = es.source_snapshot_id
                WHERE cc.id = :content_chunk_id
            """),
            {"content_chunk_id": content_chunk_id},
        )
        .mappings()
        .one()
    )
    selector = row["selector"]
    if not isinstance(selector, dict):
        raise AssertionError("content chunk evidence selector must be an object")

    fragment_id = selector.get("fragment_id")
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if (
        not isinstance(fragment_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
    ):
        raise AssertionError("content chunk evidence selector must include fragment offsets")

    quote = selector.get("text_quote")
    quote = quote if isinstance(quote, dict) else {}
    exact = str(quote.get("exact") or row["span_text"] or "")
    prefix = quote.get("prefix") if isinstance(quote.get("prefix"), str) else None
    suffix = quote.get("suffix") if isinstance(quote.get("suffix"), str) else None

    media_kind = row["media_kind"]
    if not isinstance(media_kind, str) or not media_kind:
        raise AssertionError("content chunk media kind is required")

    resolver_kind = row["resolver_kind"]
    if resolver_kind == "web":
        raw_locator = {
            "type": "web_text_offsets",
            "media_id": str(row["media_id"]),
            "fragment_id": fragment_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
            "media_kind": media_kind,
            "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
        }
    elif resolver_kind == "epub":
        raw_locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(row["media_id"]),
            "section_id": selector.get("section_id")
            if isinstance(selector.get("section_id"), str)
            else None,
            "fragment_id": fragment_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
            "media_kind": media_kind,
            "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
        }
    else:
        raise AssertionError("content chunk fixture only supports web/epub evidence spans")

    locator = retrieval_locator_json(raw_locator)
    if locator is None:
        raise AssertionError("content chunk locator is required")
    source_version = row["source_version"]
    if not isinstance(source_version, str) or not source_version:
        raise AssertionError("content chunk source_version is required")

    media_title = str(row["media_title"] or "Untitled")
    return object_ref_context_snapshot(
        object_type="content_chunk",
        object_id=content_chunk_id,
        title=media_title,
        preview=str(row["chunk_text"] or "")[:300],
        route=f"/media/{row['media_id']}",
        evidence_span_ids=[row["evidence_span_id"]],
        media_id=row["media_id"],
        media_kind=media_kind,
        media_title=media_title,
        locator=locator,
        source_version=source_version,
    )


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
                    message_id,
                    user_id,
                    context_kind,
                    object_type,
                    object_id,
                    source_media_id,
                    ordinal,
                    context_snapshot
                )
                VALUES (
                    :message_id,
                    :user_id,
                    'object_ref',
                    'content_chunk',
                    :content_chunk_id,
                    :media_id,
                    0,
                    :context_snapshot
                )
            """).bindparams(bindparam("context_snapshot", type_=JSONB)),
            {
                "message_id": message_id,
                "user_id": member_id,
                "content_chunk_id": content_chunk_id,
                "media_id": media_id,
                "context_snapshot": _content_chunk_context_snapshot(session, content_chunk_id),
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
        reader_context_id = UUID(
            str(
                session.execute(
                    text("""
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
                            :media_id,
                            jsonb_build_object(
                                'type', 'web_text_offsets',
                                'media_id', CAST(:media_id_text AS text),
                                'fragment_id', CAST(:fragment_id_text AS text),
                                'start_offset', 0,
                                'end_offset', 4
                            ),
                            1,
                            jsonb_build_object(
                                'kind', 'reader_selection',
                                'client_context_id', gen_random_uuid()::text,
                                'media_id', CAST(:media_id_text AS text),
                                'source_media_id', CAST(:media_id_text AS text),
                                'media_title', 'Shared chunk',
                                'media_kind', 'web_article',
                                'exact', 'Shared chunk text',
                                'locator', jsonb_build_object(
                                    'type', 'web_text_offsets',
                                    'media_id', CAST(:media_id_text AS text),
                                    'fragment_id', CAST(:fragment_id_text AS text),
                                    'start_offset', 0,
                                    'end_offset', 4
                                ),
                                'source_version', 'fragments_v1'
                            )
                        )
                        RETURNING id
                    """),
                    {
                        "message_id": message_id,
                        "user_id": member_id,
                        "media_id": media_id,
                        "media_id_text": str(media_id),
                        "fragment_id_text": str(fragment_id),
                    },
                ).scalar_one()
            )
        )
        session.execute(
            text("""
                INSERT INTO object_links (
                    user_id,
                    relation_type,
                    a_type,
                    a_id,
                    b_type,
                    b_id,
                    b_locator,
                    metadata
                )
                VALUES (
                    :user_id,
                    'used_as_context',
                    'message',
                    :message_id,
                    'media',
                    :media_id,
                    '{"kind":"fragment_offsets"}'::jsonb,
                    jsonb_build_object(
                        'context_kind', 'reader_selection',
                        'context_item_id', CAST(:context_item_id AS text)
                    )
                )
            """),
            {
                "user_id": member_id,
                "message_id": message_id,
                "media_id": media_id,
                "context_item_id": str(reader_context_id),
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
    direct_db.register_cleanup("message_context_items", "source_media_id", media_id)
    direct_db.register_cleanup("object_links", "b_id", content_chunk_id)
    direct_db.register_cleanup("object_links", "b_id", media_id)
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
                       )),
                    (SELECT count(*) FROM message_context_items
                     WHERE user_id = :member_id
                       AND context_kind = 'reader_selection'
                       AND source_media_id = :media_id),
                    (SELECT count(*) FROM object_links
                     WHERE user_id = :member_id
                       AND b_type = 'media'
                       AND b_id = :media_id
                       AND metadata->>'context_kind' = 'reader_selection')
            """),
            {"member_id": member_id, "content_chunk_id": content_chunk_id, "media_id": media_id},
        ).one()
    assert counts == (0, 0, 0, 0)

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
                    message_id,
                    user_id,
                    context_kind,
                    object_type,
                    object_id,
                    source_media_id,
                    ordinal,
                    context_snapshot
                )
                VALUES (
                    :message_id,
                    :user_id,
                    'object_ref',
                    'content_chunk',
                    :content_chunk_id,
                    :media_id,
                    0,
                    :context_snapshot
                )
                """
            ).bindparams(bindparam("context_snapshot", type_=JSONB)),
            {
                "message_id": message_id,
                "user_id": user_id,
                "content_chunk_id": content_chunk_id,
                "media_id": media_id,
                "context_snapshot": _content_chunk_context_snapshot(session, content_chunk_id),
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
        reader_context_id = UUID(
            str(
                session.execute(
                    text("""
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
                            :media_id,
                            jsonb_build_object(
                                'type', 'web_text_offsets',
                                'media_id', CAST(:media_id_text AS text),
                                'fragment_id', CAST(:fragment_id_text AS text),
                                'start_offset', 0,
                                'end_offset', 5
                            ),
                            1,
                            jsonb_build_object(
                                'kind', 'reader_selection',
                                'client_context_id', gen_random_uuid()::text,
                                'media_id', CAST(:media_id_text AS text),
                                'source_media_id', CAST(:media_id_text AS text),
                                'media_title', 'Hello',
                                'media_kind', 'web_article',
                                'exact', 'Hello world',
                                'locator', jsonb_build_object(
                                    'type', 'web_text_offsets',
                                    'media_id', CAST(:media_id_text AS text),
                                    'fragment_id', CAST(:fragment_id_text AS text),
                                    'start_offset', 0,
                                    'end_offset', 5
                                ),
                                'source_version', 'fragments_v1'
                            )
                        )
                        RETURNING id
                    """),
                    {
                        "message_id": message_id,
                        "user_id": user_id,
                        "media_id": media_id,
                        "media_id_text": str(media_id),
                        "fragment_id_text": str(fragment_id),
                    },
                ).scalar_one()
            )
        )
        session.execute(
            text("""
                INSERT INTO object_links (
                    user_id,
                    relation_type,
                    a_type,
                    a_id,
                    b_type,
                    b_id,
                    b_locator,
                    metadata
                )
                VALUES (
                    :user_id,
                    'used_as_context',
                    'message',
                    :message_id,
                    'media',
                    :media_id,
                    '{"kind":"fragment_offsets"}'::jsonb,
                    jsonb_build_object(
                        'context_kind', 'reader_selection',
                        'context_item_id', CAST(:context_item_id AS text)
                    )
                )
            """),
            {
                "user_id": user_id,
                "message_id": message_id,
                "media_id": media_id,
                "context_item_id": str(reader_context_id),
            },
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("object_links", "b_id", content_chunk_id)
    direct_db.register_cleanup("object_links", "a_id", content_chunk_id)
    direct_db.register_cleanup("object_links", "b_id", media_id)
    direct_db.register_cleanup("message_context_items", "object_id", content_chunk_id)
    direct_db.register_cleanup("message_context_items", "source_media_id", media_id)
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
                    (SELECT count(*) FROM message_context_items
                     WHERE context_kind = 'reader_selection'
                       AND source_media_id = :media_id),
                    (SELECT count(*) FROM object_links
                     WHERE (a_type = 'content_chunk' AND a_id = :content_chunk_id)
                        OR (b_type = 'content_chunk' AND b_id = :content_chunk_id)),
                    (SELECT count(*) FROM object_links
                     WHERE b_type = 'media'
                       AND b_id = :media_id
                       AND metadata->>'context_kind' = 'reader_selection')
            """),
            {"media_id": media_id, "content_chunk_id": content_chunk_id},
        ).one()
    assert counts == (0, 0, 0, 0, 0, 0, 0)


def test_delete_document_hard_delete_cleans_chat_singletons(
    auth_client, direct_db: DirectSessionManager
):
    """Per spec §4.7 / §5.1: deleting the media row deletes every
    ``chat_singletons`` row pointing at it, but leaves the conversation row
    intact (it still appears in the global chats pane)."""
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]

    with direct_db.session() as session:
        media_id = create_test_media(session)
        conversation_id = create_test_conversation(session, user_id)
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

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)

    add_resp = auth_client.post(
        f"/libraries/{default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert add_resp.status_code == 201, add_resp.json()

    delete_resp = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))
    assert delete_resp.status_code == 200, delete_resp.json()
    assert delete_resp.json()["data"]["hard_deleted"] is True

    with direct_db.session() as session:
        singleton_count = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chat_singletons
                WHERE kind = 'media'
                  AND target_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        assert singleton_count == 0

        conversation_row = session.execute(
            text("SELECT 1 FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": conversation_id},
        ).fetchone()
        assert conversation_row is not None

        media_row = session.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).fetchone()
        assert media_row is None


def test_delete_library_cleans_chat_singletons(
    auth_client, direct_db: DirectSessionManager
):
    """Per spec §4.7 / §5.1: deleting a library deletes every
    ``chat_singletons`` row pointing at it. The pointed-at conversation row
    is not deleted."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Singleton Lib Cleanup")
        conversation_id = create_test_conversation(session, user_id)
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

    direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    delete_resp = auth_client.delete(
        f"/libraries/{library_id}", headers=auth_headers(user_id)
    )
    assert delete_resp.status_code == 204, delete_resp.text

    with direct_db.session() as session:
        singleton_count = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chat_singletons
                WHERE kind = 'library'
                  AND target_id = :library_id
                """
            ),
            {"library_id": library_id},
        ).scalar_one()
        assert singleton_count == 0

        conversation_row = session.execute(
            text("SELECT 1 FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": conversation_id},
        ).fetchone()
        assert conversation_row is not None

        library_row = session.execute(
            text("SELECT 1 FROM libraries WHERE id = :library_id"),
            {"library_id": library_id},
        ).fetchone()
        assert library_row is None


def test_delete_conversation_rows_without_commit_cleans_chat_singletons(
    auth_client, direct_db: DirectSessionManager
):
    """Per spec §5.1: defense-in-depth at the row-deletion level. The
    user-facing route is guarded with 409, but background cleanup paths invoke
    ``delete_conversation_rows_without_commit`` directly — it must remove the
    pointing ``chat_singletons`` row before deleting the conversation."""
    from nexus.services.conversations import delete_conversation_rows_without_commit

    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Defense In Depth Lib")
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Defense In Depth Doc"
        )
        conversation_id = create_test_conversation(session, user_id)
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

    direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)

    with direct_db.session() as session:
        delete_conversation_rows_without_commit(session, conversation_id)
        session.commit()

    with direct_db.session() as session:
        singleton_row = session.execute(
            text(
                "SELECT 1 FROM chat_singletons WHERE conversation_id = :conversation_id"
            ),
            {"conversation_id": conversation_id},
        ).fetchone()
        assert singleton_row is None

        conversation_row = session.execute(
            text("SELECT 1 FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": conversation_id},
        ).fetchone()
        assert conversation_row is None
