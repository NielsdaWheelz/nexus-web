"""Media removal and physical teardown.

Whole-resource deletion claims a UUIDv7 teardown intent and enqueues one
``media_teardown`` job in the caller's transaction; that job owns the physical
deletion. Viewer-scoped removal and hide leave the media intact.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, non_system_media_ref_exists_sql
from nexus.db.models import Highlight, MediaKind
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ForbiddenError, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import (
    MediaDeleteResult,
    MediaDeletingResult,
    MediaHiddenResult,
    MediaRemovedResult,
)
from nexus.services import (
    contributors,
    library_entries,
    library_governance,
    media_intelligence_lifecycle,
    passage_anchors,
    resource_grants,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.contributor_writes import MediaTarget
from nexus.services.import_history import (
    delete_processing_history_in_current_transaction,
    rehome_source_supersessions,
)
from nexus.services.reader_apparatus import delete_media_apparatus
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.source_attempt_artifacts import source_attempt_storage_paths
from nexus.storage.client import StorageError, get_storage_client

if TYPE_CHECKING:
    from nexus.storage.client import StorageClient

logger = get_logger(__name__)

MEDIA_TEARDOWN_JOB_KIND = "media_teardown"

_DOCUMENT_KINDS = {MediaKind.pdf.value, MediaKind.epub.value, MediaKind.web_article.value}

# Child rows keyed plainly by media_id, deleted after the content index and
# before the media row.
_MEDIA_CHILD_TABLES = (
    "epub_fragment_sources",
    "epub_toc_nodes",
    "epub_nav_locations",
    "epub_resources",
    "pdf_page_text_spans",
    "media_transcript_states",
    "podcast_transcript_segments",
    "podcast_transcription_jobs",
    "podcast_episode_chapters",
)


def _delete_by_media_id(db: Session, media_id: UUID, *tables: str) -> None:
    for table in tables:
        db.execute(
            text(f"DELETE FROM {table} WHERE media_id = :media_id"),  # noqa: S608
            {"media_id": media_id},
        )


def total_reference_count(db: Session, media_id: UUID) -> int:
    """All physical library-entry and grant references to one media."""
    return library_entries.count_entries_for_media(db, media_id) + resource_grants.count_for_media(
        db, media_id
    )


def claim_media_teardown(db: Session, media_id: UUID) -> UUID:
    """Claim a media for physical teardown: intent + one job, in one transaction.

    Locks the media row first, so a concurrent creator either observes a live
    reference (no claim) or fails ``E_MEDIA_DELETING`` against the committed
    intent. Idempotent on the unique ``media_teardown_intents.media_id``: an
    existing intent is returned without enqueuing a second job. Callers have
    already confirmed zero references under that lock.
    """
    db.execute(text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id})
    existing = db.execute(
        text("SELECT id FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if existing is not None:
        return UUID(str(existing[0]))

    intent_id = new_uuid7()
    db.execute(
        text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
        {"id": intent_id, "media_id": media_id},
    )
    enqueue_job(
        db,
        kind=MEDIA_TEARDOWN_JOB_KIND,
        payload={
            "mediaId": str(media_id),
            "intentId": str(intent_id),
            "checkpoint": {"kind": "Unprepared"},
        },
        max_attempts=5,
    )
    return intent_id


def claim_document_teardown_if_unreferenced_locked(db: Session, media_id: UUID) -> bool:
    """Claim a document whose caller already locked its media row and removed a ref."""
    kind = db.scalar(text("SELECT kind FROM media WHERE id = :media_id"), {"media_id": media_id})
    if kind not in _DOCUMENT_KINDS or total_reference_count(db, media_id) != 0:
        return False
    claim_media_teardown(db, media_id)
    return True


def clear_user_media_deletion(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    db.execute(
        text("""
            DELETE FROM user_media_deletions
            WHERE user_id = :viewer_id AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def remove_media_for_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> MediaDeleteResult:
    """Remove a media from one viewer's workspace as one retryable operation."""
    return retry_read_committed(
        db,
        "remove_media_for_viewer",
        lambda: _remove_media_for_viewer_attempt(db, viewer_id=viewer_id, media_id=media_id),
    )


def _remove_media_for_viewer_attempt(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> MediaDeleteResult:
    """Remove any media kind from the viewer's whole workspace.

    System-only media with no grant path is not viewer-removable. Otherwise the
    command removes the viewer's controlled entries, incoming grant paths, the
    grants they created, and their own highlights and anchors. Zero-reference
    document media enters physical teardown; a still-readable media is hidden.
    """
    from nexus.services.artifacts import engine as artifact_engine
    from nexus.services.artifacts.dossier_types import AudienceUser
    from nexus.services.document_embeds import (
        reconcile_document_embed_edges_for_viewer,
        reconcile_document_embed_parent_edges_for_viewer,
    )

    removed_from_library_ids: list[UUID] = []
    with transaction(db):
        media = db.execute(
            text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
        ).fetchone()
        if media is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media_kind = str(media[0])
        # The complement of "reachable through a non-system library" is
        # system-only media: a corpus the viewer never controls, so a direct
        # delete is a rejection rather than a successful no-op. The predicate is
        # shared with the ``can_delete`` projection column so they cannot drift.
        has_non_system_reference = bool(
            db.execute(
                text(f"SELECT 1 WHERE {non_system_media_ref_exists_sql(':media_id')}"),
                {"viewer_id": viewer_id, "media_id": media_id},
            ).first()
        )
        if not has_non_system_reference and not resource_grants.media_grant_path_exists(
            db, viewer_user_id=viewer_id, media_id=media_id
        ):
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "System-only media cannot be deleted")

        default_library = db.execute(
            text("""
                SELECT id FROM libraries
                WHERE owner_user_id = :viewer_id AND is_default = true
            """),
            {"viewer_id": viewer_id},
        ).fetchone()
        default_library_id = UUID(str(default_library[0])) if default_library is not None else None
        library_governance.lock_library_rows_in_order(
            db,
            sorted(
                {
                    *(
                        UUID(str(library_id))
                        for library_id in library_entries.admin_non_default_library_ids_for_media(
                            db, viewer_id=viewer_id, media_id=media_id
                        )
                    ),
                    *([default_library_id] if default_library_id is not None else []),
                }
            ),
        )

        if default_library_id is not None and library_entries.delete_entry(
            db, default_library_id, library_entries.media_target(media_id)
        ):
            removed_from_library_ids.append(default_library_id)
            library_entries.normalize_positions(db, default_library_id)
        for library_id in sorted(
            library_entries.admin_non_default_library_ids_for_media(
                db, viewer_id=viewer_id, media_id=media_id
            )
        ):
            library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
            library_entries.normalize_positions(db, library_id)
            removed_from_library_ids.append(UUID(str(library_id)))

        resource_grants.delete_viewer_media_paths(db, viewer_user_id=viewer_id, media_id=media_id)
        _delete_viewer_media_state(db, viewer_id, media_id)

        remaining_reference_count = total_reference_count(db, media_id)
        if remaining_reference_count == 0 and media_kind in _DOCUMENT_KINDS:
            claim_media_teardown(db, media_id)
            result_kind = "Deleting"
        elif not can_read_media(db, viewer_id, media_id):
            result_kind = "Removed"
        else:
            # A system-library membership is still an access path the viewer
            # cannot remove; without a tombstone the media would stay readable
            # right after a successful delete.
            db.execute(
                text("""
                    INSERT INTO user_media_deletions (user_id, media_id)
                    VALUES (:viewer_id, :media_id)
                    ON CONFLICT DO NOTHING
                """),
                {"viewer_id": viewer_id, "media_id": media_id},
            )
            result_kind = "Hidden"

        # Document embeds are global source artifacts; reconcile after the final
        # visibility state so only this viewer's projections disappear.
        reconcile_document_embed_parent_edges_for_viewer(
            db, viewer_id=viewer_id, target_media_id=media_id
        )
        reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=media_id)
        artifact_engine.on_audience_visibility_changed(db, audience=AudienceUser(user_id=viewer_id))

        families = [CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries]
        if media_kind == MediaKind.podcast_episode.value:
            families.extend(
                (CollectionFamily.PodcastEpisodes, CollectionFamily.PodcastSubscriptions)
            )
        bump_collection_families(db, viewer_ids=(viewer_id,), families=families)

        if result_kind == "Deleting":
            return MediaDeletingResult()
        revision = read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        )
        result_type = MediaRemovedResult if result_kind == "Removed" else MediaHiddenResult
        return result_type(
            removed_from_library_ids=removed_from_library_ids,
            remaining_reference_count=remaining_reference_count,
            library_entries_collection_revision=revision,
        )


def _delete_viewer_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """The viewer's own highlights, anchors and retrieval references.

    The media itself may survive for other holders, so graph cleanup stays
    scoped to the refs this path actually destroys.
    """
    from nexus.services import highlights as highlights_service

    highlight_rows = db.scalars(
        select(Highlight)
        .where(Highlight.user_id == viewer_id, Highlight.anchor_media_id == media_id)
        .order_by(Highlight.id)
    ).all()
    passage_anchors.delete_for_owner(db, owner_scheme="media", owner_id=media_id, user_id=viewer_id)
    db.execute(
        text("""
            UPDATE message_retrievals mr
            SET media_id = NULL
            FROM message_tool_calls mtc, conversations c
            WHERE mr.tool_call_id = mtc.id
              AND mtc.conversation_id = c.id
              AND c.owner_user_id = :viewer_id
              AND mr.media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    for highlight in highlight_rows:
        highlights_service.delete_highlight_rows(db, highlight)


def delete_duplicate_document_media(
    db: Session, *, loser_media_id: UUID, winner_media_id: UUID
) -> list[str]:
    """Claim a duplicate document row for teardown once its replacement is reachable.

    Direct grants follow the canonical winner first. Exact grants on loser-owned
    highlights cannot be repointed — highlight identity is exact to its source —
    so those doomed paths are revoked before the teardown admission.
    """
    library_entries.lock_media_rows_in_order(db, [loser_media_id, winner_media_id])
    resource_grants.repoint_media_subjects(
        db, loser_media_id=loser_media_id, winner_media_id=winner_media_id
    )
    resource_grants.delete_media_and_child_highlight_subjects(db, loser_media_id)
    rehome_source_supersessions(db, loser_media_id=loser_media_id, winner_media_id=winner_media_id)

    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": loser_media_id}
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return []

    library_governance.lock_library_rows_in_order(
        db, library_entries.library_ids_for_media(db, loser_media_id)
    )
    affected_library_ids = library_entries.delete_all_entries_for_media(db, loser_media_id)
    for library_id in affected_library_ids:
        library_entries.normalize_positions(db, library_id)
    if affected_library_ids:
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
    claim_media_teardown(db, loser_media_id)
    # The teardown job owns this media's storage objects from here.
    return []


def enumerate_media_storage_paths(db: Session, media_id: UUID) -> list[str]:
    """Every storage object a media hard-delete owns: file, EPUB resources, and
    source-attempt artifacts, de-duplicated in a stable order."""
    storage_paths: list[str] = []
    for (storage_path,) in db.execute(
        text("""
            SELECT storage_path FROM media_file WHERE media_id = :media_id
            UNION
            SELECT storage_path FROM epub_resources WHERE media_id = :media_id
            ORDER BY storage_path
        """),
        {"media_id": media_id},
    ).fetchall():
        if storage_path not in storage_paths:
            storage_paths.append(storage_path)
    for (source_payload,) in db.execute(
        text("""
            SELECT source_payload FROM media_source_attempts
            WHERE media_id = :media_id
            ORDER BY attempt_no, created_at, id
        """),
        {"media_id": media_id},
    ).fetchall():
        for storage_path in source_attempt_storage_paths(source_payload):
            if storage_path not in storage_paths:
                storage_paths.append(storage_path)
    return storage_paths


def delete_document_media_if_unreferenced(db: Session, media_id: UUID) -> list[str] | None:
    """Hard-delete one unreferenced document media row and return its storage paths.

    The ordering below is load-bearing: every owner hook runs before the state it
    owns is unreachable, the content index goes before the media row (media_claims
    FK its evidence spans, and both unit tables FK media without cascade), and the
    highlight children go before the highlight roots. Returns ``None`` — deleting
    nothing — when the media is missing, non-document, or still referenced.
    """
    from nexus.services import media_upload_sessions
    from nexus.services.artifacts import engine as artifact_engine
    from nexus.services.reader_publication import delete_reader_publication

    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return None
    if total_reference_count(db, media_id) != 0:
        return None

    storage_paths = enumerate_media_storage_paths(db, media_id)
    artifact_engine.on_subject_deleted(db, ResourceRef(scheme="media", id=media_id))
    resource_grants.delete_media_and_child_highlight_subjects(db, media_id)
    _delete_by_media_id(db, media_id, "document_embeds", "document_embed_artifact_states")
    _fail_embeds_targeting(db, media_id)

    # One graph cleanup per resource ref this deletion destroys. Bare edges
    # touching a destroyed ref die; cited edges sourced elsewhere survive on
    # their snapshots, and attached note prose is never deleted here.
    highlight_ids = _child_ids(
        db, "SELECT id FROM highlights WHERE anchor_media_id = :media_id", media_id
    )
    fragment_ids = _child_ids(db, "SELECT id FROM fragments WHERE media_id = :media_id", media_id)
    for ref in (
        ResourceRef(scheme="media", id=media_id),
        *(ResourceRef(scheme="highlight", id=highlight_id) for highlight_id in highlight_ids),
        *(ResourceRef(scheme="fragment", id=fragment_id) for fragment_id in fragment_ids),
    ):
        cleanup.delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(
        text("UPDATE message_retrievals SET media_id = NULL WHERE media_id = :media_id"),
        {"media_id": media_id},
    )

    passage_anchors.delete_for_owner(db, owner_scheme="media", owner_id=media_id)
    db.execute(
        text("""
            DELETE FROM highlight_pdf_quads
            WHERE highlight_id IN (SELECT id FROM highlights WHERE anchor_media_id = :media_id)
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_pdf_anchors
            WHERE media_id = :media_id
               OR highlight_id IN (SELECT id FROM highlights WHERE anchor_media_id = :media_id)
        """),
        {"media_id": media_id},
    )
    # Scoped by highlight, not the disposable fragment_id cache: a refresh that
    # replaced fragments leaves anchors pointing at dead fragment rows, and those
    # must die here too or the highlight-root delete hits its FK.
    db.execute(
        text("""
            DELETE FROM highlight_fragment_anchors
            WHERE highlight_id IN (SELECT id FROM highlights WHERE anchor_media_id = :media_id)
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM highlights WHERE anchor_media_id = :media_id"), {"media_id": media_id}
    )

    media_intelligence_lifecycle.delete_media_unit(db, media_id=media_id)
    delete_media_apparatus(db, media_id)
    delete_content_index(db, owner=IndexOwner("media", media_id))
    db.execute(
        text("""
            DELETE FROM fragment_blocks
            WHERE fragment_id IN (SELECT id FROM fragments WHERE media_id = :media_id)
        """),
        {"media_id": media_id},
    )
    _delete_by_media_id(db, media_id, *_MEDIA_CHILD_TABLES)

    consumption_service.delete_media_consumption_state_in_txn(db, media_id=media_id)
    _delete_by_media_id(db, media_id, "user_media_deletions")
    contributors.cleanup_credits_for_deleted_target(db, target=MediaTarget(media_id))
    media_upload_sessions.delete_published_media_support_in_current_transaction(
        db, media_id=media_id
    )
    delete_processing_history_in_current_transaction(db, media_id=media_id)
    _delete_by_media_id(
        db,
        media_id,
        "media_source_attempts",
        "media_file",
        "fragments",
        "podcast_episodes",
        "media_teardown_intents",
    )
    delete_reader_publication(db, media_id=media_id)
    db.execute(text("DELETE FROM media WHERE id = :media_id"), {"media_id": media_id})
    return storage_paths


def _child_ids(db: Session, sql: str, media_id: UUID) -> list[UUID]:
    return list(db.execute(text(sql), {"media_id": media_id}).scalars().all())


def _fail_embeds_targeting(db: Session, media_id: UUID) -> None:
    """Orphan every embed pointing at the deleted media and re-aggregate its parent."""
    affected_parent_ids = {
        row[0]
        for row in db.execute(
            text("""
                UPDATE document_embeds
                SET target_media_id = NULL,
                    resolution_status = 'failed',
                    error_code = COALESCE(error_code, 'E_MEDIA_DELETED'),
                    error_message = COALESCE(error_message, 'Embedded media target was deleted.'),
                    updated_at = now()
                WHERE target_media_id = :media_id
                RETURNING media_id
            """),
            {"media_id": media_id},
        )
    }
    for parent_id in affected_parent_ids:
        db.execute(
            text("""
                WITH counts AS (
                    SELECT
                        media_id,
                        count(*)::integer AS total_count,
                        count(*) FILTER (WHERE resolution_status = 'resolved')::integer
                            AS resolved_count,
                        count(*) FILTER (WHERE resolution_status = 'unsupported')::integer
                            AS unsupported_count,
                        count(*) FILTER (WHERE resolution_status = 'failed')::integer
                            AS failed_count
                    FROM document_embeds
                    WHERE media_id = :media_id
                    GROUP BY media_id
                )
                UPDATE document_embed_artifact_states
                SET total_count = counts.total_count,
                    resolved_count = counts.resolved_count,
                    unsupported_count = counts.unsupported_count,
                    failed_count = counts.failed_count,
                    status = CASE
                        WHEN counts.total_count = 0 THEN 'empty'
                        WHEN counts.resolved_count = counts.total_count THEN 'ready'
                        WHEN counts.unsupported_count = counts.total_count THEN 'unsupported'
                        WHEN counts.failed_count = counts.total_count THEN 'failed'
                        WHEN counts.resolved_count + counts.unsupported_count + counts.failed_count = 0
                            THEN 'resolving'
                        ELSE 'partial'
                    END,
                    updated_at = now()
                FROM counts
                WHERE document_embed_artifact_states.media_id = counts.media_id
            """),
            {"media_id": parent_id},
        )


def delete_document_storage_objects(
    storage_paths: list[str], storage_client: StorageClient | None = None
) -> None:
    """Best-effort delete of already-unreachable storage objects.

    Always post-commit, and idempotent: the rows that referenced these paths are
    gone, so a failure is operational and never raises into the caller.
    """
    if not storage_paths:
        return
    client = storage_client or get_storage_client()
    for storage_path in storage_paths:
        try:
            client.delete_object(storage_path)
        except StorageError as exc:
            logger.warning(
                "document_storage_delete_failed storage_path=%s error=%s", storage_path, exc
            )
