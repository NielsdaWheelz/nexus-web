"""Document deletion behavior tests."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    ProcessingStatus,
    ResourceEdge,
    ResourceExternalSnapshot,
)
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.resource_graph.cleanup import (
    assert_no_dangling_bare_edges,
    delete_edges_for_deleted_resource,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.paths import build_source_artifact_storage_path, build_storage_path
from tests.factories import (
    create_test_conversation_with_message,
    create_test_highlight,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
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
            fragments=[fragment],
            reason="test",
        )
        conversation_id, _ = create_test_conversation_with_message(
            session,
            member_id,
            content="Member context",
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
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
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


def test_delete_document_hard_deletes_source_attempt_storage_artifacts(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]
    storage = FakeStorageClient()
    monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)

    media_id = uuid4()
    attempt_id = uuid4()
    original_path = build_storage_path(media_id, "pdf")
    captured_source_path = build_source_artifact_storage_path(media_id, attempt_id, "html")
    arxiv_source_path = build_source_artifact_storage_path(media_id, attempt_id, "tar")
    storage.put_object(original_path, b"%PDF-1.4 test", "application/pdf")
    storage.put_object(captured_source_path, b"<article>Source</article>", "text/html")
    storage.put_object(arxiv_source_path, b"tar bytes", "application/x-tar")

    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Delete nested source artifacts",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        session.add(
            MediaFile(
                media_id=media_id,
                storage_path=original_path,
                content_type="application/pdf",
                size_bytes=13,
            )
        )
        session.add(
            MediaSourceAttempt(
                id=attempt_id,
                media_id=media_id,
                created_by_user_id=user_id,
                source_type="remote_pdf_url",
                attempt_no=1,
                status="succeeded",
                intent_key="test-source-artifact-delete",
                requested_url="https://arxiv.org/pdf/2606.01109",
                canonical_source_url="https://arxiv.org/pdf/2606.01109",
                source_payload={
                    "remote_kind": "pdf",
                    "storage_path": captured_source_path,
                    "arxiv_source_package": {
                        "status": "fetched",
                        "storage_path": arxiv_source_path,
                    },
                },
            )
        )
        session.commit()

    direct_db.register_cleanup("media_source_attempts", "media_id", media_id)
    direct_db.register_cleanup("media_file", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    add_response = auth_client.post(
        f"/libraries/{default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert add_response.status_code == 201, add_response.text

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.text
    assert delete_response.json()["data"]["hard_deleted"] is True
    assert storage.get_object(original_path) is None
    assert storage.get_object(captured_source_path) is None
    assert storage.get_object(arxiv_source_path) is None


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
            fragments=[fragment],
            reason="test",
        )
        # The content-index "ready" branch funnels through
        # media_intelligence.ensure_media_unit_in_tx, creating the unit head; add a
        # ready summary plus a grounded claim so deletion must tear down a real,
        # non-empty unit (the head + claim FK media/evidence_spans non-cascading).
        evidence_span_id = session.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = 'media' AND owner_id = :media_id LIMIT 1"
            ),
            {"media_id": media_id},
        ).scalar_one()
        summary_id = session.execute(
            text("""
                UPDATE media_summaries
                SET status = 'ready', summary_md = 'Hello summary'
                WHERE media_id = :media_id
                RETURNING id
            """),
            {"media_id": media_id},
        ).scalar_one()
        session.execute(
            text("""
                INSERT INTO media_claims (
                    media_id, summary_id, claim_text, evidence_span_id, ordinal
                )
                VALUES (:media_id, :summary_id, 'Hello claim', :evidence_span_id, 0)
            """),
            {
                "media_id": media_id,
                "summary_id": summary_id,
                "evidence_span_id": evidence_span_id,
            },
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
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
                    (SELECT count(*) FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :media_id),
                    (SELECT count(*) FROM media_summaries WHERE media_id = :media_id),
                    (SELECT count(*) FROM media_claims WHERE media_id = :media_id)
            """),
            {"media_id": media_id},
        ).one()
    assert counts == (0, 0, 0, 0, 0)


def test_source_delete_gcs_orphaned_external_snapshots(
    auth_client, direct_db: DirectSessionManager
):
    """§9.6 (#8/#D): deleting a citation edge's SOURCE parent (message/conversation)
    garbage-collects the external_snapshot it minted once no edge references it,
    while a snapshot still cited elsewhere survives. The cleanup owner runs the
    same GC the chat re-run/prune path delegates to — one owner, every path."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        doomed_conv, doomed_msg = create_test_conversation_with_message(
            session, user_id, content="Cites a web result"
        )
        keeper_conv, keeper_msg = create_test_conversation_with_message(
            session, user_id, content="Also cites a web result"
        )
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
        direct_db.register_cleanup("messages", "conversation_id", doomed_conv)
        direct_db.register_cleanup("messages", "conversation_id", keeper_conv)
        direct_db.register_cleanup("conversations", "id", doomed_conv)
        direct_db.register_cleanup("conversations", "id", keeper_conv)

        def snapshot(url: str) -> UUID:
            row = ResourceExternalSnapshot(
                user_id=user_id,
                provider="brave",
                url=url,
                title="Web",
                snippet="snippet",
                source_snapshot={"url": url},
            )
            session.add(row)
            session.flush()
            return row.id

        orphaned_snapshot = snapshot("https://example.com/orphaned")
        shared_snapshot = snapshot("https://example.com/shared")
        # The doomed message cites the orphaned snapshot AND the shared one; the
        # keeper message also cites the shared one. Deleting the doomed message
        # must GC only the now-unreferenced orphaned snapshot.
        for src_msg, target, ordinal in (
            (doomed_msg, orphaned_snapshot, 1),
            (doomed_msg, shared_snapshot, 2),
            (keeper_msg, shared_snapshot, 1),
        ):
            session.add(
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="message",
                    source_id=src_msg,
                    target_scheme="external_snapshot",
                    target_id=target,
                    ordinal=ordinal,
                    snapshot={"title": "Web", "deep_link": str(target)},
                )
            )
        session.flush()

        delete_edges_for_deleted_resource(session, ref=ResourceRef(scheme="message", id=doomed_msg))

        remaining_snapshots = set(
            session.execute(
                text("SELECT id FROM resource_external_snapshots WHERE user_id = :u"),
                {"u": user_id},
            ).scalars()
        )
        assert orphaned_snapshot not in remaining_snapshots, (
            "the doomed message's sole-referenced snapshot must be GC'd"
        )
        assert shared_snapshot in remaining_snapshots, (
            "a snapshot still cited by the keeper message must survive"
        )
        assert (
            session.query(ResourceEdge).filter(ResourceEdge.source_id == doomed_msg).count() == 0
        ), "the doomed message's citation edges die with their source parent (rule 1)"
        assert (
            session.query(ResourceEdge).filter(ResourceEdge.source_id == keeper_msg).count() == 1
        ), "the keeper message's citation edge is untouched"
        session.rollback()


def test_delete_document_applies_graph_cleanup_two_rules(
    auth_client, direct_db: DirectSessionManager
):
    """AC12 (§9.6): deletion leaves no bare edge to any destroyed ref — media,
    highlight, content chunk — while cited edges sourced elsewhere survive with
    ordinal and snapshot intact (they render from the snapshot; the jump fails
    closed)."""
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]

    with direct_db.session() as session:
        media_id = create_test_media(session, title="Doomed Document")
        keeper_media_id = create_test_media(session, title="Keeper Document")
        fragment_id = UUID(
            str(
                session.execute(
                    text("""
                        INSERT INTO fragments (media_id, idx, html_sanitized, canonical_text)
                        VALUES (:media_id, 0, '<p>Doomed</p>', 'Doomed evidence text')
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
            fragments=[fragment],
            reason="test",
        )
        chunk_id = session.execute(
            text(
                "SELECT id FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :media_id"
            ),
            {"media_id": media_id},
        ).scalar_one()
        span_id = session.execute(
            text(
                "SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :media_id"
            ),
            {"media_id": media_id},
        ).scalar_one()
        conversation_id, message_id = create_test_conversation_with_message(
            session, user_id, content="Cites the doomed document"
        )
        highlight_id = create_test_highlight(session, user_id, fragment_id, exact="Doomed")

        session.add_all(
            [
                # Bare edges touching a destroyed ref at either endpoint — all must die.
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="media",
                    source_id=keeper_media_id,
                    target_scheme="media",
                    target_id=media_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="conversation",
                    source_id=conversation_id,
                    target_scheme="media",
                    target_id=media_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="conversation",
                    source_id=conversation_id,
                    target_scheme="content_chunk",
                    target_id=chunk_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="highlight",
                    source_id=highlight_id,
                    target_scheme="media",
                    target_id=keeper_media_id,
                ),
                # Cited edges sourced from the surviving message — both must outlive
                # their deleted targets (rule 1).
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="message",
                    source_id=message_id,
                    target_scheme="evidence_span",
                    target_id=span_id,
                    ordinal=1,
                    snapshot={"title": "Doomed Document", "excerpt": "Doomed evidence text"},
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="message",
                    source_id=message_id,
                    target_scheme="media",
                    target_id=media_id,
                    ordinal=2,
                    snapshot={"title": "Doomed Document"},
                ),
            ]
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("media", "id", keeper_media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)

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
        for ref in (
            ResourceRef(scheme="media", id=media_id),
            ResourceRef(scheme="highlight", id=highlight_id),
            ResourceRef(scheme="content_chunk", id=chunk_id),
            ResourceRef(scheme="evidence_span", id=span_id),
        ):
            assert_no_dangling_bare_edges(session, ref=ref)

        surviving = session.execute(
            text(
                """
                SELECT source_scheme, target_scheme, target_id, ordinal, snapshot
                FROM resource_edges
                WHERE user_id = :user_id
                ORDER BY ordinal
                """
            ),
            {"user_id": user_id},
        ).fetchall()
    assert [
        (row.source_scheme, row.target_scheme, row.target_id, row.ordinal) for row in surviving
    ] == [
        ("message", "evidence_span", span_id, 1),
        ("message", "media", media_id, 2),
    ], "Only the two cited edges may survive media deletion"
    assert surviving[0].snapshot == {
        "title": "Doomed Document",
        "excerpt": "Doomed evidence text",
    }, "The surviving citation must keep its snapshot for rendering"


def test_delete_library_applies_graph_cleanup_two_rules(
    auth_client, direct_db: DirectSessionManager
):
    """§9.6 (HIGH #3, AC12): deleting a library removes every bare edge touching
    its ``library:`` ref — context refs and app_search scopes — so no phantom
    scope dangles, while a citation sourced *elsewhere* that merely targets the
    library survives on its snapshot (rule 1: cited edges die only with their
    source)."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, name="Doomed Library")
        conversation_id, message_id = create_test_conversation_with_message(
            session, user_id, content="Scopes the doomed library"
        )

        session.add_all(
            [
                # Bare edges touching the library at either endpoint — all must die.
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="conversation",
                    source_id=conversation_id,
                    target_scheme="library",
                    target_id=library_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="library",
                    source_id=library_id,
                    target_scheme="conversation",
                    target_id=conversation_id,
                ),
                # Cited edge SOURCED BY the library (rule 1): dies with its source.
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="library",
                    source_id=library_id,
                    target_scheme="conversation",
                    target_id=conversation_id,
                    ordinal=1,
                    snapshot={"title": "Doomed Library"},
                ),
                # Cited edge sourced from the surviving message that merely TARGETS
                # the library (rule 1): must outlive the deleted target.
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="message",
                    source_id=message_id,
                    target_scheme="library",
                    target_id=library_id,
                    ordinal=2,
                    snapshot={"title": "Doomed Library", "excerpt": "scoped"},
                ),
            ]
        )
        session.commit()

    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)

    delete_response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))
    assert delete_response.status_code == 204, delete_response.text

    with direct_db.session() as session:
        assert_no_dangling_bare_edges(session, ref=ResourceRef(scheme="library", id=library_id))

        surviving = session.execute(
            text(
                """
                SELECT source_scheme, target_scheme, target_id, ordinal, snapshot
                FROM resource_edges
                WHERE user_id = :user_id
                ORDER BY ordinal
                """
            ),
            {"user_id": user_id},
        ).fetchall()
    assert [
        (row.source_scheme, row.target_scheme, row.target_id, row.ordinal) for row in surviving
    ] == [
        ("message", "library", library_id, 2),
    ], "Only the citation sourced outside the library may survive its deletion"
    assert surviving[0].snapshot == {"title": "Doomed Library", "excerpt": "scoped"}
