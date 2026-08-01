"""Database integration tests for the current document-embed artifact owner."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    DocumentEmbed,
    DocumentEmbedArtifactState,
    Fragment,
    Media,
    MediaKind,
    MediaSourceAttempt,
    ProcessingStatus,
    ResourceEdge,
)
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services import content_indexing, library_entries, media_source_ingest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.document_embeds import (
    DocumentEmbedArtifactOccurrence,
    DocumentEmbedLockSetChanged,
    DocumentEmbedTargetAcceptSource,
    DocumentEmbedTargetMaterialized,
    DocumentEmbedTargetTerminal,
    document_embed_summary_for_media,
    reconcile_document_embed_edges_for_viewer,
    replace_document_embed_artifact,
    resolved_document_embed_target_media_ids,
)
from nexus.services.media_deletion import remove_media_for_viewer
from nexus.services.media_source_ingest import (
    accept_embedded_source,
    accept_url_source,
    enqueue_accepted_source_attempt_in_transaction,
)
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.conftest import register_media_cleanup
from tests.support.source_jobs import run_queued_source_attempt
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _media(db: Session, *, owner_id, title: str) -> Media:
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url=f"https://example.com/{uuid4()}",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=owner_id,
    )
    db.add(media)
    db.flush()
    library_entries.assign_libraries_for_media_in_current_transaction(db, owner_id, media.id, [])
    return media


def _attempt(db: Session, *, media: Media, owner_id) -> MediaSourceAttempt:
    attempt = MediaSourceAttempt(
        id=uuid4(),
        media_id=media.id,
        created_by_user_id=owner_id,
        source_type="generic_web_url",
        attempt_no=1,
        status="succeeded",
        intent_key=f"test:{media.id}",
        requested_url=media.canonical_source_url,
        canonical_source_url=media.canonical_source_url,
        source_payload={},
    )
    db.add(attempt)
    db.flush()
    return attempt


def _x_thread_attempt(
    db: Session,
    *,
    media: Media,
    owner_id,
    post_id: str,
) -> MediaSourceAttempt:
    attempt = MediaSourceAttempt(
        id=uuid4(),
        media_id=media.id,
        created_by_user_id=owner_id,
        source_type="x_author_thread",
        attempt_no=1,
        run_count=1,
        status="succeeded",
        intent_key=f"x-thread:{post_id}",
        requested_url=f"https://x.com/i/status/{post_id}",
        canonical_source_url=f"https://x.com/i/status/{post_id}",
        provider="x",
        provider_target_ref=post_id,
        source_payload={"post_id": post_id},
    )
    db.add(attempt)
    db.flush()
    return attempt


def _fragment(db: Session, *, media: Media, idx: int, text: str) -> Fragment:
    fragment = Fragment(
        media_id=media.id,
        idx=idx,
        html_sanitized=f"<p>{text}</p>",
        canonical_text=text,
    )
    db.add(fragment)
    db.flush()
    return fragment


def _occurrence(
    *,
    fragment: Fragment,
    ordinal: int,
    occurrence_key: str,
    target,
) -> DocumentEmbedArtifactOccurrence:
    placeholder = f"Embed {ordinal}"
    return DocumentEmbedArtifactOccurrence(
        fragment_id=fragment.id,
        ordinal=ordinal,
        occurrence_key=occurrence_key,
        provider="x",
        embed_kind="post",
        source_shape="provider_json",
        source_url=f"https://x.com/i/status/{ordinal}",
        canonical_source_url=f"https://x.com/i/status/{ordinal}",
        provider_target_ref=f"post:{ordinal}",
        title=None,
        authored_text=None,
        placeholder_text=placeholder,
        canonical_start_offset=0,
        canonical_end_offset=len(placeholder),
        target=target,
    )


def test_direct_media_cleanup_removes_embed_children_before_fragments(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)

    with direct_db.session() as session:
        ensure_user_and_default_library(session, user_id)
        parent = _media(session, owner_id=user_id, title="Cleanup parent")
        register_media_cleanup(direct_db, parent.id)
        attempt = _attempt(session, media=parent, owner_id=user_id)
        fragment = _fragment(session, media=parent, idx=0, text="Embed 0")
        replace_document_embed_artifact(
            session,
            owner_user_id=user_id,
            media_id=parent.id,
            source_attempt_id=attempt.id,
            occurrences=[
                _occurrence(
                    fragment=fragment,
                    ordinal=0,
                    occurrence_key="cleanup:0",
                    target=DocumentEmbedTargetTerminal(
                        status="unsupported",
                        error_code=None,
                        error_message=None,
                    ),
                )
            ],
            extraction_error_code=None,
            extraction_error_message=None,
            request_id="cleanup",
            locked_existing_target_media_ids=frozenset(),
        )
        media_id = parent.id
        fragment_id = fragment.id
        session.commit()

    direct_db.cleanup()

    with direct_db.session() as session:
        assert (
            session.scalar(select(DocumentEmbed.id).where(DocumentEmbed.fragment_id == fragment_id))
            is None
        )
        assert session.get(Fragment, fragment_id) is None
        assert session.get(Media, media_id) is None


def test_batch_replacement_owns_all_fragments_counts_edges_and_current_state(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Parent")
    child = _media(db_session, owner_id=bootstrapped_user, title="Child")
    attempt = _attempt(db_session, media=parent, owner_id=bootstrapped_user)
    first = _fragment(db_session, media=parent, idx=0, text="Embed 0")
    second = _fragment(db_session, media=parent, idx=1, text="Embed 1 Embed 2")

    queued = replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=first,
                ordinal=0,
                occurrence_key="quote:0",
                target=DocumentEmbedTargetMaterialized(child.id),
            ),
            _occurrence(
                fragment=second,
                ordinal=1,
                occurrence_key="quote:1",
                target=DocumentEmbedTargetMaterialized(child.id),
            ),
            _occurrence(
                fragment=second,
                ordinal=2,
                occurrence_key="quote:2",
                target=DocumentEmbedTargetTerminal(
                    status="unsupported",
                    error_code=None,
                    error_message=None,
                ),
            ),
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="batch-artifact",
        locked_existing_target_media_ids=frozenset(),
    )

    assert queued == []
    rows = list(
        db_session.scalars(
            select(DocumentEmbed)
            .where(DocumentEmbed.media_id == parent.id)
            .order_by(DocumentEmbed.ordinal)
        )
    )
    assert [
        (row.fragment_id, row.ordinal, row.occurrence_key, row.resolution_status) for row in rows
    ] == [
        (first.id, 0, "quote:0", "resolved"),
        (second.id, 1, "quote:1", "resolved"),
        (second.id, 2, "quote:2", "unsupported"),
    ]
    summary = document_embed_summary_for_media(db_session, media_id=parent.id)
    assert summary is not None
    assert summary.model_dump() == {
        "status": "ready",
        "total_count": 3,
        "resolved_count": 2,
        "unsupported_count": 1,
        "failed_count": 0,
    }
    edges = list(
        db_session.scalars(
            select(ResourceEdge).where(
                ResourceEdge.user_id == bootstrapped_user,
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.origin == "document_embed",
            )
        )
    )
    assert [(edge.target_scheme, edge.target_id) for edge in edges] == [("media", child.id)]
    assert resolved_document_embed_target_media_ids(db_session, media_id=parent.id) == [child.id]

    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=second,
                ordinal=0,
                occurrence_key="replacement:0",
                target=DocumentEmbedTargetTerminal(
                    status="unsupported",
                    error_code=None,
                    error_message=None,
                ),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="replacement",
        locked_existing_target_media_ids=frozenset(),
    )
    assert document_embed_summary_for_media(db_session, media_id=parent.id).model_dump() == {
        "status": "unsupported",
        "total_count": 1,
        "resolved_count": 0,
        "unsupported_count": 1,
        "failed_count": 0,
    }
    assert (
        db_session.scalar(
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == bootstrapped_user,
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.origin == "document_embed",
            )
        )
        is None
    )
    assert resolved_document_embed_target_media_ids(db_session, media_id=parent.id) == []
    assert db_session.get(Media, child.id) is not None

    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=first,
                ordinal=0,
                occurrence_key="failed:0",
                target=DocumentEmbedTargetTerminal(
                    status="failed",
                    error_code="E_X_POST_UNAVAILABLE",
                    error_message="Quoted X post is unavailable.",
                ),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="failed-replacement",
        locked_existing_target_media_ids=frozenset(),
    )
    failed = db_session.scalar(select(DocumentEmbed).where(DocumentEmbed.media_id == parent.id))
    assert failed is not None
    assert (
        failed.resolution_status,
        failed.error_code,
        failed.error_message,
        failed.target_media_id,
    ) == (
        "failed",
        "E_X_POST_UNAVAILABLE",
        "Quoted X post is unavailable.",
        None,
    )
    assert document_embed_summary_for_media(db_session, media_id=parent.id).model_dump() == {
        "status": "failed",
        "total_count": 1,
        "resolved_count": 0,
        "unsupported_count": 0,
        "failed_count": 1,
    }


def test_repeated_accept_source_occurrences_enqueue_one_child(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Parent")
    attempt = _attempt(db_session, media=parent, owner_id=bootstrapped_user)
    first = _fragment(db_session, media=parent, idx=0, text="Embed 0")
    second = _fragment(db_session, media=parent, idx=1, text="Embed 1")
    canonical_url = "https://x.com/i/status/1234567890"

    queued = replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=first,
                ordinal=0,
                occurrence_key="embed:0",
                target=DocumentEmbedTargetAcceptSource(canonical_url),
            ),
            _occurrence(
                fragment=second,
                ordinal=1,
                occurrence_key="embed:1",
                target=DocumentEmbedTargetAcceptSource(canonical_url),
            ),
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="repeated-source",
        locked_existing_target_media_ids=frozenset(),
    )

    assert len(queued) == 1
    rows = list(
        db_session.scalars(
            select(DocumentEmbed)
            .where(DocumentEmbed.media_id == parent.id)
            .order_by(DocumentEmbed.ordinal)
        )
    )
    assert len({row.target_media_id for row in rows}) == 1
    assert [row.resolution_status for row in rows] == ["resolving", "resolving"]
    target_media_id = rows[0].target_media_id
    assert target_media_id is not None
    edges = list(
        db_session.scalars(
            select(ResourceEdge).where(
                ResourceEdge.user_id == bootstrapped_user,
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.origin == "document_embed",
            )
        )
    )
    assert len(edges) == 1

    concurrent_parent = _media(db_session, owner_id=bootstrapped_user, title="Concurrent parent")
    concurrent_attempt = _attempt(db_session, media=concurrent_parent, owner_id=bootstrapped_user)
    concurrent_fragment = _fragment(db_session, media=concurrent_parent, idx=0, text="Embed 0")
    concurrent_occurrences = [
        _occurrence(
            fragment=concurrent_fragment,
            ordinal=0,
            occurrence_key="concurrent:0",
            target=DocumentEmbedTargetAcceptSource(canonical_url),
        )
    ]
    with pytest.raises(DocumentEmbedLockSetChanged) as raised:
        replace_document_embed_artifact(
            db_session,
            owner_user_id=bootstrapped_user,
            media_id=concurrent_parent.id,
            source_attempt_id=concurrent_attempt.id,
            occurrences=concurrent_occurrences,
            extraction_error_code=None,
            extraction_error_message=None,
            request_id="unplanned-existing-source",
            locked_existing_target_media_ids=frozenset(),
        )
    assert raised.value.media_id == target_media_id

    concurrent_queued = replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=concurrent_parent.id,
        source_attempt_id=concurrent_attempt.id,
        occurrences=concurrent_occurrences,
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="planned-existing-source",
        locked_existing_target_media_ids=frozenset({target_media_id}),
    )
    assert concurrent_queued == []


def test_x_post_embedded_acceptance_holds_provider_identity_advisory_lock(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Parent")
    before = db_session.scalar(
        text("""
            SELECT count(*)
            FROM pg_locks
            WHERE pid = pg_backend_pid()
              AND locktype = 'advisory'
              AND granted
        """)
    )

    accepted = accept_embedded_source(
        db=db_session,
        viewer_id=bootstrapped_user,
        url="https://x.com/i/status/9876543210",
        parent_media_id=parent.id,
        document_embed_key="quote:lock",
        library_ids=[],
    )

    after = db_session.scalar(
        text("""
            SELECT count(*)
            FROM pg_locks
            WHERE pid = pg_backend_pid()
              AND locktype = 'advisory'
              AND granted
        """)
    )
    assert before is not None and after == before + 1
    assert db_session.get(Media, accepted.media_id).provider_id == "post:9876543210"


def test_canonical_parent_reuse_projects_viewer_edges_and_refresh_clears_all_viewers(
    db_session: Session, bootstrapped_user
) -> None:
    post_id = "7777777777"
    canonical_url = f"https://x.com/i/status/{post_id}"
    parent = _media(db_session, owner_id=bootstrapped_user, title="X parent")
    parent.provider = "x"
    parent.provider_id = f"thread:{post_id}"
    parent.requested_url = canonical_url
    parent.canonical_source_url = canonical_url
    parent_attempt = _x_thread_attempt(
        db_session,
        media=parent,
        owner_id=bootstrapped_user,
        post_id=post_id,
    )
    child = _media(db_session, owner_id=bootstrapped_user, title="Quoted child")
    fragment = _fragment(db_session, media=parent, idx=0, text="Quoted link")
    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=parent_attempt.id,
        occurrences=[
            _occurrence(
                fragment=fragment,
                ordinal=0,
                occurrence_key="quote:shared",
                target=DocumentEmbedTargetMaterialized(child.id),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="owner-publication",
        locked_existing_target_media_ids=frozenset(),
    )
    accepting_viewer = uuid4()
    ensure_user_and_default_library(db_session, accepting_viewer)

    reused = accept_url_source(
        db=db_session,
        viewer_id=accepting_viewer,
        url=canonical_url,
        library_ids=[],
    )

    assert reused.media_id == parent.id
    assert can_read_media(db_session, accepting_viewer, parent.id)
    assert can_read_media(db_session, accepting_viewer, child.id)
    assert (
        db_session.scalar(
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == accepting_viewer,
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.target_scheme == "media",
                ResourceEdge.target_id == child.id,
                ResourceEdge.origin == "document_embed",
            )
        )
        is not None
    )

    delete_web_article_artifacts(
        db_session,
        media_id=parent.id,
        include_content_index=False,
    )
    replacement_fragment = _fragment(db_session, media=parent, idx=0, text="No quote")
    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=parent_attempt.id,
        occurrences=[],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="owner-refresh",
        locked_existing_target_media_ids=frozenset(),
    )
    assert db_session.get(Fragment, replacement_fragment.id) is not None

    assert (
        db_session.scalar(
            select(ResourceEdge.id).where(
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.origin == "document_embed",
            )
        )
        is None
    )


def test_viewer_losing_child_access_drops_only_their_projected_edge(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Owner parent")
    child = _media(db_session, owner_id=bootstrapped_user, title="Shared child")
    attempt = _attempt(db_session, media=parent, owner_id=bootstrapped_user)
    fragment = _fragment(db_session, media=parent, idx=0, text="Quoted link")
    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=fragment,
                ordinal=0,
                occurrence_key="quote:viewer",
                target=DocumentEmbedTargetMaterialized(child.id),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="owner-publication",
        locked_existing_target_media_ids=frozenset(),
    )
    other_viewer = uuid4()
    ensure_user_and_default_library(db_session, other_viewer)
    for media_id in (parent.id, child.id):
        library_entries.assign_libraries_for_media_in_current_transaction(
            db_session,
            other_viewer,
            media_id,
            [],
        )
    reconcile_document_embed_edges_for_viewer(
        db_session,
        viewer_id=other_viewer,
        media_id=parent.id,
    )
    result = remove_media_for_viewer(db_session, other_viewer, child.id)

    assert result.kind == "Removed"
    occurrence = db_session.scalar(select(DocumentEmbed).where(DocumentEmbed.media_id == parent.id))
    assert occurrence is not None
    assert (occurrence.target_media_id, occurrence.resolution_status) == (child.id, "resolved")
    edge_viewers = set(
        db_session.scalars(
            select(ResourceEdge.user_id).where(
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.target_scheme == "media",
                ResourceEdge.target_id == child.id,
                ResourceEdge.origin == "document_embed",
            )
        )
    )
    assert edge_viewers == {bootstrapped_user}


def test_parent_owner_losing_child_access_preserves_other_viewer_projection(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Owner parent")
    child = _media(db_session, owner_id=bootstrapped_user, title="Shared child")
    attempt = _attempt(db_session, media=parent, owner_id=bootstrapped_user)
    fragment = _fragment(db_session, media=parent, idx=0, text="Quoted link")
    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=fragment,
                ordinal=0,
                occurrence_key="quote:owner-child-removal",
                target=DocumentEmbedTargetMaterialized(child.id),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="owner-publication",
        locked_existing_target_media_ids=frozenset(),
    )
    other_viewer = uuid4()
    ensure_user_and_default_library(db_session, other_viewer)
    for media_id in (parent.id, child.id):
        library_entries.assign_libraries_for_media_in_current_transaction(
            db_session,
            other_viewer,
            media_id,
            [],
        )
    reconcile_document_embed_edges_for_viewer(
        db_session,
        viewer_id=other_viewer,
        media_id=parent.id,
    )

    result = remove_media_for_viewer(db_session, bootstrapped_user, child.id)

    assert result.kind == "Removed"
    occurrence = db_session.scalar(select(DocumentEmbed).where(DocumentEmbed.media_id == parent.id))
    assert occurrence is not None
    assert (occurrence.target_media_id, occurrence.resolution_status) == (child.id, "resolved")
    edge_viewers = set(
        db_session.scalars(
            select(ResourceEdge.user_id).where(
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.target_scheme == "media",
                ResourceEdge.target_id == child.id,
                ResourceEdge.origin == "document_embed",
            )
        )
    )
    assert edge_viewers == {other_viewer}
    assert can_read_media(db_session, bootstrapped_user, parent.id)
    assert not can_read_media(db_session, bootstrapped_user, child.id)
    assert can_read_media(db_session, other_viewer, parent.id)
    assert can_read_media(db_session, other_viewer, child.id)


def test_viewer_removing_reused_parent_drops_only_their_source_edge(
    db_session: Session, bootstrapped_user
) -> None:
    parent = _media(db_session, owner_id=bootstrapped_user, title="Owner parent")
    child = _media(db_session, owner_id=bootstrapped_user, title="Quoted child")
    attempt = _attempt(db_session, media=parent, owner_id=bootstrapped_user)
    fragment = _fragment(db_session, media=parent, idx=0, text="Quoted link")
    replace_document_embed_artifact(
        db_session,
        owner_user_id=bootstrapped_user,
        media_id=parent.id,
        source_attempt_id=attempt.id,
        occurrences=[
            _occurrence(
                fragment=fragment,
                ordinal=0,
                occurrence_key="quote:parent-removal",
                target=DocumentEmbedTargetMaterialized(child.id),
            )
        ],
        extraction_error_code=None,
        extraction_error_message=None,
        request_id="owner-publication",
        locked_existing_target_media_ids=frozenset(),
    )
    other_viewer = uuid4()
    ensure_user_and_default_library(db_session, other_viewer)
    for media_id in (parent.id, child.id):
        library_entries.assign_libraries_for_media_in_current_transaction(
            db_session,
            other_viewer,
            media_id,
            [],
        )
    reconcile_document_embed_edges_for_viewer(
        db_session,
        viewer_id=other_viewer,
        media_id=parent.id,
    )

    result = remove_media_for_viewer(db_session, other_viewer, parent.id)

    assert result.kind == "Removed"
    assert not can_read_media(db_session, other_viewer, parent.id)
    occurrence = db_session.scalar(select(DocumentEmbed).where(DocumentEmbed.media_id == parent.id))
    assert occurrence is not None
    assert (occurrence.target_media_id, occurrence.resolution_status) == (child.id, "resolved")
    edge_viewers = set(
        db_session.scalars(
            select(ResourceEdge.user_id).where(
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == parent.id,
                ResourceEdge.target_scheme == "media",
                ResourceEdge.target_id == child.id,
                ResourceEdge.origin == "document_embed",
            )
        )
    )
    assert edge_viewers == {bootstrapped_user}
    assert can_read_media(db_session, bootstrapped_user, parent.id)
    assert can_read_media(db_session, bootstrapped_user, child.id)


@pytest.mark.parametrize("observation_fails", [False, True])
def test_terminal_syncs_additional_x_child_into_resolving_generic_parent(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
    observation_fails: bool,
) -> None:
    viewer_id = create_test_user_id()
    default_library_id = auth_client.get(
        "/me",
        headers=auth_headers(viewer_id),
    ).json()["data"]["default_library_id"]
    parent_id = uuid4()
    child_id = uuid4()
    thread_id = uuid4()
    fragment_id = uuid4()
    attempt_id = uuid4()
    direct_db.register_cleanup("users", "id", viewer_id)
    for media_id in (parent_id, child_id, thread_id):
        direct_db.register_cleanup("media", "id", media_id)

    with direct_db.session() as session:
        session.execute(
            text("""
                INSERT INTO media (
                    id, kind, title, processing_status, created_by_user_id,
                    provider, provider_id
                )
                VALUES
                    (
                        :parent_id, 'web_article', 'Generic parent',
                        'ready_for_reading', :viewer_id, NULL, NULL
                    ),
                    (
                        :child_id, 'web_article', 'Quoted X child',
                        'pending', :viewer_id, 'x', 'post:6666666666'
                    ),
                    (
                        :thread_id, 'web_article', 'X thread',
                        'extracting', :viewer_id, 'x', 'thread:5555555555'
                    )
            """),
            {
                "parent_id": parent_id,
                "child_id": child_id,
                "thread_id": thread_id,
                "viewer_id": viewer_id,
            },
        )
        session.execute(
            text("""
                INSERT INTO library_entries (library_id, media_id, position)
                VALUES
                    (:library_id, :parent_id, 0),
                    (:library_id, :child_id, 1),
                    (:library_id, :thread_id, 2)
            """),
            {
                "library_id": default_library_id,
                "parent_id": parent_id,
                "child_id": child_id,
                "thread_id": thread_id,
            },
        )
        session.execute(
            text("""
                INSERT INTO fragments (
                    id, media_id, idx, html_sanitized, canonical_text
                )
                VALUES (
                    :fragment_id, :parent_id, 0,
                    '<p>Quoted link</p>', 'Quoted link'
                )
            """),
            {"fragment_id": fragment_id, "parent_id": parent_id},
        )
        session.execute(
            text("""
                INSERT INTO document_embed_artifact_states (
                    media_id, status, total_count, resolved_count
                )
                VALUES (:parent_id, 'resolving', 1, 0)
            """),
            {"parent_id": parent_id},
        )
        session.execute(
            text("""
                INSERT INTO document_embeds (
                    media_id, fragment_id, ordinal, occurrence_key,
                    provider, embed_kind, source_shape, resolution_status,
                    canonical_source_url, provider_target_ref, target_media_id,
                    placeholder_text, canonical_start_offset,
                    canonical_end_offset, document_order_key
                )
                VALUES (
                    :parent_id, :fragment_id, 0, 'quote:resolving',
                    'x', 'post', 'provider_json', 'resolving',
                    'https://x.com/i/status/6666666666',
                    'post:6666666666', :child_id, 'Quoted link', 0, 11, '000000'
                )
            """),
            {
                "parent_id": parent_id,
                "fragment_id": fragment_id,
                "child_id": child_id,
            },
        )
        session.add(
            MediaSourceAttempt(
                id=attempt_id,
                media_id=thread_id,
                created_by_user_id=viewer_id,
                source_type="x_author_thread",
                attempt_no=1,
                status="accepted",
                intent_key="test-terminal-additional-sync",
                requested_url="https://x.com/i/status/5555555555",
                canonical_source_url="https://x.com/i/status/5555555555",
                provider="x",
                provider_target_ref="5555555555",
                source_payload={"post_id": "5555555555"},
            )
        )
        session.flush()
        enqueue_accepted_source_attempt_in_transaction(
            session,
            media_id=thread_id,
            attempt_id=attempt_id,
            actor_user_id=viewer_id,
            request_id="terminal-additional-sync",
        )
        attempt = session.get(MediaSourceAttempt, attempt_id)
        assert attempt is not None and attempt.job_id is not None
        job_id = attempt.job_id
        session.commit()
    direct_db.register_cleanup("background_jobs", "id", job_id)

    def fake_x_author_thread(
        session_factory,
        _media_id,
        _attempt,
        _actor_user_id,
        _request_id,
        _fence,
    ):
        session = session_factory()
        try:
            child = session.get(Media, child_id)
            assert child is not None
            child.processing_status = ProcessingStatus.ready_for_reading
            session.commit()
        finally:
            session.close()
        return {
            "processing_status": ProcessingStatus.ready_for_reading.value,
            "additional_reindex_media_ids": [str(child_id)],
        }

    monkeypatch.setattr(media_source_ingest, "_run_x_author_thread", fake_x_author_thread)
    reindexed_media_ids = []
    monkeypatch.setattr(
        content_indexing,
        "request_media_content_reindex",
        lambda _db, *, media_id, **_kwargs: reindexed_media_ids.append(media_id),
    )
    if observation_fails:
        monkeypatch.setattr(
            media_source_ingest,
            "take_author_observations",
            lambda _result: [(None, object(), "test_observation")],
        )

        def fail_observation(**_kwargs):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Modeled author publication failure.",
            )

        monkeypatch.setattr(
            media_source_ingest,
            "observe_contributors_under_source_fence",
            fail_observation,
        )

    with direct_db.session() as session:
        result = run_queued_source_attempt(
            session,
            media_id=thread_id,
            actor_user_id=viewer_id,
            request_id="terminal-additional-sync",
        )

    if observation_fails:
        assert result["status"] == "failed"
    else:
        assert result["processing_status"] == ProcessingStatus.ready_for_reading.value
    assert child_id in reindexed_media_ids
    with direct_db.session() as session:
        assert (
            session.scalar(
                select(DocumentEmbed.resolution_status).where(DocumentEmbed.media_id == parent_id)
            )
            == "resolved"
        )
        assert (
            session.scalar(
                select(DocumentEmbedArtifactState.status).where(
                    DocumentEmbedArtifactState.media_id == parent_id
                )
            )
            == "ready"
        )
