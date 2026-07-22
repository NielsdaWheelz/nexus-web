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
    ResourceMutation,
)
from nexus.services import contributors, library_entries, library_governance, passage_anchors
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.contributor_taxonomy import (
    ContributorIdentityKey,
    ContributorObservation,
    ObservedRoleSlices,
    canonicalize_identity_key,
)
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.resource_graph.cleanup import (
    assert_no_dangling_bare_edges,
    delete_edges_for_deleted_resource,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.paths import build_source_artifact_storage_path, build_storage_path
from tests.factories import (
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.support.teardown import drive_media_teardown, install_fake_storage_for_teardown
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_default_library_reachability(
    direct_db: DirectSessionManager, user_id: UUID, media_id: UUID
) -> None:
    """Mirror production ingest: give the actor a direct physical reference to
    ``media_id`` in their own default library before any REST filing call.

    The actor-authorized filing command (spec S4.3 rule 1, F2/F3) requires the
    filing target to already be membership-reachable to the caller — a
    precondition that bare ``create_test_media`` rows and raw ``INSERT INTO
    media`` test rows don't carry, unlike real ingest, which always auto-files
    new media into the creator's default library first.
    """
    with direct_db.session() as session:
        library_entries.ensure_media_in_default_library(session, user_id, media_id)
        session.commit()


@pytest.fixture(autouse=True)
def _clean_teardown_state(direct_db: DirectSessionManager):
    """Clear teardown intents + jobs after each test so media cleanup is unblocked
    (media_teardown_intents FK media) and background_jobs stays isolated."""
    yield
    with direct_db.session() as db:
        db.execute(text("DELETE FROM media_teardown_intents"))
        db.execute(
            text(
                "DELETE FROM background_jobs "
                "WHERE kind IN ('media_teardown', 'storage_object_cleanup', 'storage_orphan_sweep')"
            )
        )
        db.commit()


def test_delete_document_hides_shared_member_copy(auth_client, direct_db: DirectSessionManager):
    owner_id = create_test_user_id()
    member_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    auth_client.get("/me", headers=auth_headers(member_id))

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
    direct_db.register_cleanup("user_media_deletions", "media_id", media_id)
    direct_db.register_cleanup("consumption_queue_items", "media_id", media_id)

    _seed_default_library_reachability(direct_db, owner_id, media_id)
    add_response = auth_client.post(
        f"/media/{media_id}/libraries",
        json={"library_ids": [str(library_id)]},
        headers=auth_headers(owner_id),
    )
    assert add_response.status_code == 204, add_response.text
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(member_id)).status_code == 200

    # The member has a latent Lectern row for this media (spec §3: viewer-scoped
    # removal/hide must preserve it, not delete it).
    with direct_db.session() as session:
        session.execute(
            text("""
                INSERT INTO consumption_queue_items (user_id, media_id, position, source)
                VALUES (:user_id, :media_id, 0, 'manual')
            """),
            {"user_id": member_id, "media_id": media_id},
        )
        session.commit()

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(member_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Hidden"
    assert delete_response.json()["data"]["remainingReferenceCount"] >= 1
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(member_id)).status_code == 404

    with direct_db.session() as session:
        latent = session.execute(
            text("""
                SELECT 1 FROM consumption_queue_items
                WHERE user_id = :user_id AND media_id = :media_id
            """),
            {"user_id": member_id, "media_id": media_id},
        ).fetchone()
    assert latent is not None, "viewer-scoped hide must preserve the latent Lectern row"
    assert auth_client.get(f"/media/{media_id}", headers=auth_headers(owner_id)).status_code == 200

    with direct_db.session() as session:
        library_entries.ensure_media_in_default_library(session, member_id, media_id)
        session.commit()
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
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    work_id = auth_client.post(
        "/libraries",
        json={"name": "Work"},
        headers=auth_headers(user_id),
    ).json()["data"]["id"]

    with direct_db.session() as session:
        media_id = create_test_media(session)

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)

    _seed_default_library_reachability(direct_db, user_id, media_id)
    response = auth_client.post(
        f"/media/{media_id}/libraries",
        json={"library_ids": [str(work_id)]},
        headers=auth_headers(user_id),
    )
    assert response.status_code == 204, response.text

    response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert response.status_code == 200, response.json()
    # Removing the last reference returns Deleting (intent + job) only after commit.
    assert response.json()["data"] == {"kind": "Deleting"}

    with direct_db.session() as session:
        intent = session.execute(
            text("SELECT 1 FROM media_teardown_intents WHERE media_id = :m"),
            {"m": media_id},
        ).fetchone()
    assert intent is not None, "expected a teardown intent after the last reference removal"

    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

    with direct_db.session() as session:
        row = session.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).fetchone()
    assert row is None


def test_delete_document_removes_personal_reference_when_system_reference_remains(
    auth_client, direct_db: DirectSessionManager
):
    """Mixed-reference cell (spec S4.3/S5): a viewer holding both a non-system
    reference (their own default library) and a system-library reference to the
    same media deletes the personal reference. The system reference is untouched
    corpus data the viewer never controls, so this is a truthful ``Removed`` —
    not ``Hidden`` (no tombstone; a live non-viewer-controlled reference remains
    but it's a system one) and not ``Deleting`` (the system reference keeps the
    media alive). ``_total_reference_count`` dropped the closure term in S2, so
    this branch needs direct physical-count coverage."""
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]

    with direct_db.session() as session:
        media_id = create_test_media(session, title="Mixed Reference Media")
        system_library_id = library_governance.ensure_system_library(
            session,
            system_key=f"test_mixed_ref_system_{media_id.hex[:12]}",
            name="Mixed Reference System Library",
            owner_user_id=user_id,
        )
        library_entries.ensure_entry(
            session, system_library_id, library_entries.media_target(media_id)
        )
        session.commit()

    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", system_library_id)
    direct_db.register_cleanup("libraries", "id", system_library_id)
    direct_db.register_cleanup("user_media_deletions", "media_id", media_id)

    # The personal (non-system) reference: the viewer's own default library.
    _seed_default_library_reachability(direct_db, user_id, media_id)

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    data = delete_response.json()["data"]
    assert data["kind"] == "Removed", data
    assert data["remainingReferenceCount"] == 1, data
    assert data["removedFromLibraryIds"] == [str(default_id)], data

    with direct_db.session() as session:
        system_entry = session.execute(
            text(
                """
                SELECT 1 FROM library_entries
                WHERE library_id = :library_id AND media_id = :media_id
                """
            ),
            {"library_id": system_library_id, "media_id": media_id},
        ).fetchone()
        default_entry = session.execute(
            text(
                """
                SELECT 1 FROM library_entries
                WHERE library_id = :library_id AND media_id = :media_id
                """
            ),
            {"library_id": default_id, "media_id": media_id},
        ).fetchone()
        tombstone = session.execute(
            text(
                """
                SELECT 1 FROM user_media_deletions
                WHERE user_id = :user_id AND media_id = :media_id
                """
            ),
            {"user_id": user_id, "media_id": media_id},
        ).fetchone()
    assert system_entry is not None, "system-library reference must survive a personal delete"
    assert default_entry is None, "the personal default-library reference must be removed"
    assert tombstone is None, "a personal delete that leaves a live reference records no tombstone"


def test_delete_document_hard_deletes_source_attempt_storage_artifacts(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    storage = FakeStorageClient()
    monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)
    install_fake_storage_for_teardown(monkeypatch, storage)

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
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    _seed_default_library_reachability(direct_db, user_id, media_id)
    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.text
    assert delete_response.json()["data"]["kind"] == "Deleting"
    # The durable teardown job owns storage deletion; objects survive until it runs.
    assert storage.get_object(original_path) is not None
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert storage.get_object(original_path) is None
    assert storage.get_object(captured_source_path) is None
    assert storage.get_object(arxiv_source_path) is None


def test_delete_document_hard_deletes_web_article_fragments_and_chunks(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

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

    _seed_default_library_reachability(direct_db, user_id, media_id)
    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

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


def test_delete_document_hard_deletes_owned_document_embed_rows(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    parent_id = uuid4()
    child_id = uuid4()
    fragment_id = uuid4()
    attempt_id = uuid4()

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES
                  (:parent_id, 'web_article', 'Parent', 'ready_for_reading', :user_id),
                  (:child_id, 'web_article', 'Child', 'ready_for_reading', :user_id)
                """
            ),
            {"parent_id": parent_id, "child_id": child_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:fragment_id, :parent_id, 0, '<p>Parent</p>', 'Parent')
                """
            ),
            {"fragment_id": fragment_id, "parent_id": parent_id},
        )
        session.execute(
            text(
                """
                INSERT INTO media_source_attempts (
                    id, media_id, created_by_user_id, source_type, attempt_no, status, intent_key
                )
                VALUES (
                    :attempt_id, :parent_id, :user_id, 'generic_web_url', 1, 'succeeded', :intent_key
                )
                """
            ),
            {
                "attempt_id": attempt_id,
                "parent_id": parent_id,
                "user_id": user_id,
                "intent_key": f"embed-parent-delete:{parent_id}",
            },
        )
        session.execute(
            text(
                """
                INSERT INTO document_embed_artifact_states (
                    media_id, source_attempt_id, status, total_count, resolved_count
                )
                VALUES (:parent_id, :attempt_id, 'ready', 1, 1)
                """
            ),
            {"parent_id": parent_id, "attempt_id": attempt_id},
        )
        session.execute(
            text(
                """
                INSERT INTO document_embeds (
                    media_id, fragment_id, source_attempt_id, ordinal, occurrence_key,
                    provider, embed_kind, source_shape, resolution_status, target_media_id,
                    placeholder_text, canonical_start_offset, canonical_end_offset,
                    document_order_key
                )
                VALUES (
                    :parent_id, :fragment_id, :attempt_id, 0, 'embed:delete-parent',
                    'x', 'post', 'blockquote', 'resolved', :child_id,
                    'Embedded X post', 0, 15, '000000'
                )
                """
            ),
            {
                "parent_id": parent_id,
                "fragment_id": fragment_id,
                "attempt_id": attempt_id,
                "child_id": child_id,
            },
        )
        session.commit()

    direct_db.register_cleanup("media", "id", parent_id)
    direct_db.register_cleanup("media", "id", child_id)

    _seed_default_library_reachability(direct_db, user_id, parent_id)
    delete_response = auth_client.delete(f"/media/{parent_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, parent_id) == "succeeded"
    with direct_db.session() as session:
        counts = session.execute(
            text(
                """
                SELECT
                    (SELECT count(*) FROM media WHERE id = :parent_id),
                    (SELECT count(*) FROM fragments WHERE media_id = :parent_id),
                    (SELECT count(*) FROM media_source_attempts WHERE media_id = :parent_id),
                    (SELECT count(*) FROM document_embeds WHERE media_id = :parent_id),
                    (SELECT count(*) FROM document_embed_artifact_states WHERE media_id = :parent_id),
                    (SELECT count(*) FROM media WHERE id = :child_id)
                """
            ),
            {"parent_id": parent_id, "child_id": child_id},
        ).one()
    assert counts == (0, 0, 0, 0, 0, 1)


def test_delete_document_detaches_document_embed_target_rows(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    parent_id = uuid4()
    child_id = uuid4()
    fragment_id = uuid4()

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES
                  (:parent_id, 'web_article', 'Parent', 'ready_for_reading', :user_id),
                  (:child_id, 'web_article', 'Child', 'ready_for_reading', :user_id)
                """
            ),
            {"parent_id": parent_id, "child_id": child_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:fragment_id, :parent_id, 0, '<p>Parent</p>', 'Parent')
                """
            ),
            {"fragment_id": fragment_id, "parent_id": parent_id},
        )
        session.execute(
            text(
                """
                INSERT INTO document_embed_artifact_states (
                    media_id, status, total_count, resolved_count
                )
                VALUES (:parent_id, 'ready', 1, 1)
                """
            ),
            {"parent_id": parent_id},
        )
        session.execute(
            text(
                """
                INSERT INTO document_embeds (
                    media_id, fragment_id, ordinal, occurrence_key, provider, embed_kind,
                    source_shape, resolution_status, target_media_id, placeholder_text,
                    canonical_start_offset, canonical_end_offset, document_order_key
                )
                VALUES (
                    :parent_id, :fragment_id, 0, 'embed:delete-child', 'x', 'post',
                    'blockquote', 'resolved', :child_id, 'Embedded X post', 0, 15, '000000'
                )
                """
            ),
            {"parent_id": parent_id, "fragment_id": fragment_id, "child_id": child_id},
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :user_id, 'context', 'document_embed', 'media', :parent_id, 'media', :child_id
                )
                """
            ),
            {"user_id": user_id, "parent_id": parent_id, "child_id": child_id},
        )
        session.commit()

    direct_db.register_cleanup("media", "id", parent_id)
    direct_db.register_cleanup("media", "id", child_id)

    for media_id in (parent_id, child_id):
        _seed_default_library_reachability(direct_db, user_id, media_id)

    delete_response = auth_client.delete(f"/media/{child_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, child_id) == "succeeded"
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT target_media_id, resolution_status, error_code
                FROM document_embeds
                WHERE media_id = :parent_id
                """
            ),
            {"parent_id": parent_id},
        ).one()
        state = session.execute(
            text(
                """
                SELECT status, total_count, resolved_count, failed_count
                FROM document_embed_artifact_states
                WHERE media_id = :parent_id
                """
            ),
            {"parent_id": parent_id},
        ).one()
        edge_count = session.scalar(
            text(
                """
                SELECT count(*)
                FROM resource_edges
                WHERE origin = 'document_embed'
                  AND source_id IN (:parent_id, :child_id)
                  AND target_id IN (:parent_id, :child_id)
                """
            ),
            {"parent_id": parent_id, "child_id": child_id},
        )
    assert row == (None, "failed", "E_MEDIA_DELETED")
    assert state == ("failed", 1, 0, 1)
    assert edge_count == 0


def test_delete_document_hides_shared_document_embed_target_for_owner(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    other_user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    other_default_id = auth_client.get("/me", headers=auth_headers(other_user_id)).json()["data"][
        "default_library_id"
    ]
    parent_id = uuid4()
    child_id = uuid4()
    fragment_id = uuid4()

    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES
                  (:parent_id, 'web_article', 'Parent', 'ready_for_reading', :user_id),
                  (:child_id, 'web_article', 'Child', 'ready_for_reading', :user_id)
                """
            ),
            {"parent_id": parent_id, "child_id": child_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:fragment_id, :parent_id, 0, '<p>Parent</p>', 'Parent')
                """
            ),
            {"fragment_id": fragment_id, "parent_id": parent_id},
        )
        session.execute(
            text(
                """
                INSERT INTO document_embed_artifact_states (
                    media_id, status, total_count, resolved_count
                )
                VALUES (:parent_id, 'ready', 1, 1)
                """
            ),
            {"parent_id": parent_id},
        )
        session.execute(
            text(
                """
                INSERT INTO document_embeds (
                    media_id, fragment_id, ordinal, occurrence_key, provider, embed_kind,
                    source_shape, resolution_status, target_media_id, placeholder_text,
                    canonical_start_offset, canonical_end_offset, document_order_key
                )
                VALUES (
                    :parent_id, :fragment_id, 0, 'embed:hide-child', 'x', 'post',
                    'blockquote', 'resolved', :child_id, 'Embedded X post', 0, 15, '000000'
                )
                """
            ),
            {"parent_id": parent_id, "fragment_id": fragment_id, "child_id": child_id},
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :user_id, 'context', 'document_embed', 'media', :parent_id, 'media', :child_id
                )
                """
            ),
            {"user_id": user_id, "parent_id": parent_id, "child_id": child_id},
        )
        session.execute(
            text(
                """
                INSERT INTO library_entries (library_id, media_id, position)
                VALUES (:other_default_id, :child_id, 0)
                """
            ),
            {"other_default_id": other_default_id, "child_id": child_id},
        )
        session.commit()

    direct_db.register_cleanup("library_entries", "media_id", parent_id)
    direct_db.register_cleanup("library_entries", "media_id", child_id)
    direct_db.register_cleanup("media", "id", parent_id)
    direct_db.register_cleanup("media", "id", child_id)
    direct_db.register_cleanup("user_media_deletions", "user_id", user_id)

    for media_id in (parent_id, child_id):
        _seed_default_library_reachability(direct_db, user_id, media_id)

    delete_response = auth_client.delete(f"/media/{child_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    # The viewer's only reachable reference was their own default library, so
    # after removal they can no longer reach the child (it survives solely in
    # the other user's private default) — a truthful Removed, no tombstone —
    # while the viewer's own embed targeting it is still marked unavailable.
    assert delete_response.json()["data"]["kind"] == "Removed"
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT target_media_id, resolution_status, error_code
                FROM document_embeds
                WHERE media_id = :parent_id
                """
            ),
            {"parent_id": parent_id},
        ).one()
        state = session.execute(
            text(
                """
                SELECT status, total_count, resolved_count, failed_count
                FROM document_embed_artifact_states
                WHERE media_id = :parent_id
                """
            ),
            {"parent_id": parent_id},
        ).one()
        edge_count = session.scalar(
            text(
                """
                SELECT count(*)
                FROM resource_edges
                WHERE origin = 'document_embed'
                  AND source_id = :parent_id
                  AND target_id = :child_id
                """
            ),
            {"parent_id": parent_id, "child_id": child_id},
        )
        child_exists = session.scalar(
            text("SELECT count(*) FROM media WHERE id = :child_id"), {"child_id": child_id}
        )
    assert row == (None, "failed", "E_MEDIA_HIDDEN")
    assert state == ("failed", 1, 0, 1)
    assert edge_count == 0
    assert child_exists == 1


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
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    """AC12 (§9.6): deletion leaves no bare edge to any destroyed ref — media,
    highlight, content chunk — while cited edges sourced elsewhere survive with
    ordinal and snapshot intact (they render from the snapshot; the jump fails
    closed)."""
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

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
                    origin="user",
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
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)

    _seed_default_library_reachability(direct_db, user_id, media_id)
    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

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
        artifact_id = session.execute(
            text(
                """
                INSERT INTO artifacts (subject_scheme, subject_id, kind, user_id)
                VALUES ('library', :library_id, 'library_dossier', :user_id)
                RETURNING id
                """
            ),
            {"library_id": library_id, "user_id": user_id},
        ).scalar_one()
        revision_id = session.execute(
            text(
                """
                INSERT INTO artifact_revisions (
                    artifact_id, content_md, covered_targets, status, promoted_at
                )
                VALUES (:artifact_id, 'Doomed revision [1].', '[]'::jsonb, 'ready', now())
                RETURNING id
                """
            ),
            {"artifact_id": artifact_id},
        ).scalar_one()
        session.execute(
            text("UPDATE artifacts SET current_revision_id = :revision_id WHERE id = :artifact_id"),
            {"revision_id": revision_id, "artifact_id": artifact_id},
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
                    origin="user",
                    source_scheme="library",
                    source_id=library_id,
                    target_scheme="conversation",
                    target_id=conversation_id,
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
                # LI artifact/revision refs belong to the deleted library. Bare
                # links touching them and citations sourced by the revision must die.
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="artifact",
                    source_id=artifact_id,
                    target_scheme="conversation",
                    target_id=conversation_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="conversation",
                    source_id=conversation_id,
                    target_scheme="artifact_revision",
                    target_id=revision_id,
                ),
                ResourceEdge(
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="artifact_revision",
                    source_id=revision_id,
                    target_scheme="conversation",
                    target_id=conversation_id,
                    ordinal=3,
                    snapshot={"title": "Doomed Revision", "excerpt": "revision scoped"},
                ),
            ]
        )
        session.commit()

    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("artifact_revisions", "artifact_id", artifact_id)
    direct_db.register_cleanup("artifacts", "id", artifact_id)

    delete_response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))
    assert delete_response.status_code == 204, delete_response.text

    with direct_db.session() as session:
        assert_no_dangling_bare_edges(session, ref=ResourceRef(scheme="library", id=library_id))
        assert_no_dangling_bare_edges(session, ref=ResourceRef(scheme="artifact", id=artifact_id))
        assert_no_dangling_bare_edges(
            session, ref=ResourceRef(scheme="artifact_revision", id=revision_id)
        )

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


def test_delete_document_removes_credits_and_memos_prunes_only_keyless_authors(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    """Hard-delete tears down credits + author-edit memos, prunes keyless orphans,
    and retains a key-owner contributor whose last credit is gone (AC 19)."""
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    with direct_db.session() as session:
        media_id = create_test_media(session)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)

    keep_key = ContributorIdentityKey(
        "orcid", canonicalize_identity_key("orcid", "0000-0002-1825-0097")
    )
    observation = ObservedRoleSlices(
        managed_roles=frozenset({"author"}),
        credits=(
            ContributorObservation("Prune Me", "author", None, None),
            ContributorObservation("Keep Me", "author", None, keep_key),
        ),
    )
    contributors.replace_observed_role_slices(
        target=contributors.MediaTarget(media_id),
        observation=observation,
        source="epub_opf",
    )

    with direct_db.session() as session:
        rows = session.execute(
            text(
                "SELECT cc.credited_name, cc.contributor_id, c.handle "
                "FROM contributor_credits cc JOIN contributors c ON c.id = cc.contributor_id "
                "WHERE cc.media_id = :m"
            ),
            {"m": media_id},
        ).fetchall()
    by_name = {row[0]: (row[1], row[2]) for row in rows}
    prune_id = by_name["Prune Me"][0]
    keep_id, keep_handle = by_name["Keep Me"]
    for contributor_id in (prune_id, keep_id):
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)

    # A manual author-edit memo naming the key owner: cleanup must delete it and,
    # once gone, re-test the keyed contributor for prune (it stays — it has a key).
    with direct_db.session() as session:
        session.add(
            ResourceMutation(
                user_id=user_id,
                mutation_scope=f"media:{media_id}:authors",
                client_mutation_id="cm-authors-1",
                request_hash="a" * 64,
                changed_lanes={},
                response_json={"authors": [{"contributorHandle": keep_handle}]},
            )
        )
        session.commit()

    _seed_default_library_reachability(direct_db, user_id, media_id)
    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))
    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

    with direct_db.session() as session:
        credit_count = session.execute(
            text("SELECT count(*) FROM contributor_credits WHERE media_id = :m"),
            {"m": media_id},
        ).scalar_one()
        memo_count = session.execute(
            text("SELECT count(*) FROM resource_mutations WHERE mutation_scope = :s"),
            {"s": f"media:{media_id}:authors"},
        ).scalar_one()
        prune_exists = (
            session.execute(
                text("SELECT 1 FROM contributors WHERE id = :c"), {"c": prune_id}
            ).first()
            is not None
        )
        keep_exists = (
            session.execute(
                text("SELECT 1 FROM contributors WHERE id = :c"), {"c": keep_id}
            ).first()
            is not None
        )

    assert credit_count == 0
    assert memo_count == 0
    assert prune_exists is False, "keyless orphaned author should be pruned"
    assert keep_exists is True, "key-owner author is retained after its last credit is gone"


def test_delete_document_removes_passage_anchors_and_preserves_note_prose(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    """AC9 (universal-link-authoring): true media deletion explicitly removes
    the media's passage anchors and highlight family child-first — including
    bare edges touching the dying anchor — while detached note prose survives
    as standalone authored data."""
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]

    with direct_db.session() as session:
        media_id = create_test_media(session, title="Doomed Document")
        keeper_media_id = create_test_media(session, title="Keeper Document")
        fragment_id = create_test_fragment(
            session, media_id, content="Alpha bravo charlie delta echo foxtrot golf."
        )
        highlight_id = create_test_highlight(session, user_id, fragment_id, exact="Alpha bravo")
        anchor = passage_anchors.materialize_or_reuse(
            session,
            user_id=user_id,
            owner_scheme="media",
            owner_id=media_id,
            exact="delta echo foxtrot",
        )
        anchor_id = anchor.id
        session.add(
            ResourceEdge(
                user_id=user_id,
                kind="context",
                origin="user",
                source_scheme="passage_anchor",
                source_id=anchor_id,
                target_scheme="media",
                target_id=keeper_media_id,
            )
        )
        session.commit()

    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("media", "id", keeper_media_id)

    _seed_default_library_reachability(direct_db, user_id, media_id)
    add_response = auth_client.post(
        f"/libraries/{default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert add_response.status_code == 201, add_response.json()

    note_response = auth_client.put(
        f"/highlights/{highlight_id}/note",
        json={
            "note_block_id": str(uuid4()),
            "client_mutation_id": f"highlight-note-{uuid4()}",
            "body_pm_json": {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Prose that must survive"}],
            },
        },
        headers=auth_headers(user_id),
    )
    assert note_response.status_code == 200, note_response.text
    note_block_id = note_response.json()["data"]["note_block_id"]

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))
    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

    with direct_db.session() as session:
        counts = session.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM passage_anchors
                     WHERE owner_scheme = 'media' AND owner_id = :media_id),
                    (SELECT COUNT(*) FROM highlights WHERE anchor_media_id = :media_id),
                    (SELECT COUNT(*) FROM highlight_fragment_anchors
                     WHERE highlight_id = :highlight_id),
                    (SELECT COUNT(*) FROM resource_edges
                     WHERE (source_scheme = 'passage_anchor' AND source_id = :anchor_id)
                        OR (target_scheme = 'passage_anchor' AND target_id = :anchor_id)),
                    (SELECT COUNT(*) FROM note_blocks WHERE id = :note_block_id)
                """
            ),
            {
                "media_id": media_id,
                "highlight_id": highlight_id,
                "anchor_id": anchor_id,
                "note_block_id": note_block_id,
            },
        ).one()
        assert_no_dangling_bare_edges(
            session, ref=ResourceRef(scheme="passage_anchor", id=anchor_id)
        )
    assert tuple(counts) == (0, 0, 0, 0, 1), (
        "anchors/highlights/edges must be explicitly removed; note prose survives"
    )


def test_delete_document_with_stale_highlight_cache_after_refresh(
    auth_client, direct_db: DirectSessionManager, monkeypatch
):
    """AC9 regression: refresh replaces fragments while deliberately preserving
    the Highlight, so its anchor's fragment_id points at a hard-deleted row. If
    no list read repairs the cache before true deletion, teardown must still
    remove the anchor row — the cleanup keys off the highlight, never the
    disposable fragment cache — or the Highlight-root delete violates its FK."""
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]
    # The stale-cache highlight belongs to ANOTHER user: the deleting viewer's
    # own highlights are already removed by the viewer-scoped path, so only
    # true deletion's all-users cleanup ever sees this row.
    other_user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(other_user_id)).status_code == 200

    with direct_db.session() as session:
        media_id = create_test_media(session, title="Refreshed Then Deleted")
        fragment_id = create_test_fragment(
            session, media_id, content="Alpha bravo charlie delta echo foxtrot golf."
        )
        highlight_id = create_test_highlight(
            session, other_user_id, fragment_id, exact="Alpha bravo"
        )

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    _seed_default_library_reachability(direct_db, user_id, media_id)
    add_response = auth_client.post(
        f"/libraries/{default_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert add_response.status_code == 201, add_response.json()

    # Refresh-style wholesale fragment replacement, with NO list read afterward:
    # the highlight and its anchor survive with a stale fragment_id cache.
    with direct_db.session() as session:
        session.execute(text("DELETE FROM fragments WHERE media_id = :m"), {"m": media_id})
        session.commit()
    with direct_db.session() as session:
        create_test_fragment(
            session, media_id, content="Alpha bravo charlie delta echo foxtrot golf."
        )
        stale_pointer = session.execute(
            text("SELECT fragment_id FROM highlight_fragment_anchors WHERE highlight_id = :h"),
            {"h": highlight_id},
        ).scalar_one()
    assert stale_pointer == fragment_id, "precondition: cache still points at the deleted fragment"

    delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))
    assert delete_response.status_code == 200, delete_response.json()
    assert delete_response.json()["data"]["kind"] == "Deleting"
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"

    with direct_db.session() as session:
        counts = session.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM highlights WHERE anchor_media_id = :media_id),
                    (SELECT COUNT(*) FROM highlight_fragment_anchors
                     WHERE highlight_id = :highlight_id)
                """
            ),
            {"media_id": media_id, "highlight_id": highlight_id},
        ).one()
    assert tuple(counts) == (0, 0), "stale-cache anchor rows must die with the highlight family"
