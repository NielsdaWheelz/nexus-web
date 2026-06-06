"""Document deletion service."""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import MediaKind
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.media import DeleteDocumentResponse, DeleteDocumentStatus
from nexus.services import library_entries
from nexus.services.content_indexing import delete_media_content_index
from nexus.services.default_library_closure import (
    count_default_references,
    detach_media_from_default_library,
    purge_media_default_references,
    remove_media_from_default_intrinsic,
    remove_media_from_non_default_closure,
)
from nexus.storage.client import StorageError, get_storage_client

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

logger = get_logger(__name__)

_DOCUMENT_KINDS = {
    MediaKind.pdf.value,
    MediaKind.epub.value,
    MediaKind.web_article.value,
}


def _total_reference_count(db: Session, media_id: UUID) -> int:
    """All remaining references to a media across the two owned surfaces: non-default
    library entries + default-library closure references."""
    return library_entries.count_entries_for_media(db, media_id) + count_default_references(
        db, media_id=media_id
    )


def delete_document_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> DeleteDocumentResponse:
    """Delete a document from the viewer's whole workspace."""
    storage_paths: list[str] = []
    removed_from_library_ids: list[UUID] = []
    hard_deleted = False
    hidden_for_viewer = False
    remaining_reference_count = 0

    with transaction(db):
        media = db.execute(
            text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"),
            {"media_id": media_id},
        ).fetchone()
        if media is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media[0] not in _DOCUMENT_KINDS:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND,
                "Delete document only supports document media",
            )

        default_library = db.execute(
            text("""
                SELECT id
                FROM libraries
                WHERE owner_user_id = :viewer_id
                  AND is_default = true
                FOR UPDATE
            """),
            {"viewer_id": viewer_id},
        ).fetchone()
        if default_library is not None:
            default_library_id = default_library[0]
            if detach_media_from_default_library(
                db, default_library_id=default_library_id, media_id=media_id
            ):
                removed_from_library_ids.append(UUID(str(default_library_id)))
                library_entries.normalize_positions(db, default_library_id)

        controlled_libraries = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=media_id
        )
        for library_id in controlled_libraries:
            library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
            remove_media_from_non_default_closure(db, library_id, media_id)
            library_entries.normalize_positions(db, library_id)
            removed_from_library_ids.append(UUID(str(library_id)))

        _delete_viewer_media_state(db, viewer_id, media_id)

        remaining_reference_count = _total_reference_count(db, media_id)
        if remaining_reference_count == 0:
            paths = delete_document_media_if_unreferenced(db, media_id)
            if paths is not None:
                storage_paths = paths
                hard_deleted = True
        else:
            existing = db.execute(
                text("""
                    SELECT 1
                    FROM user_media_deletions
                    WHERE user_id = :viewer_id
                      AND media_id = :media_id
                """),
                {"viewer_id": viewer_id, "media_id": media_id},
            ).fetchone()
            if existing is None:
                db.execute(
                    text("""
                        INSERT INTO user_media_deletions (user_id, media_id)
                        VALUES (:viewer_id, :media_id)
                    """),
                    {"viewer_id": viewer_id, "media_id": media_id},
                )
            hidden_for_viewer = True

    _delete_storage_objects(storage_paths, storage_client)

    status: DeleteDocumentStatus
    if hard_deleted:
        status = "deleted"
    elif hidden_for_viewer:
        status = "hidden"
    else:
        status = "removed"

    return DeleteDocumentResponse(
        status=status,
        hard_deleted=hard_deleted,
        removed_from_library_ids=removed_from_library_ids,
        hidden_for_viewer=hidden_for_viewer,
        remaining_reference_count=remaining_reference_count,
    )


def remove_document_from_library(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> DeleteDocumentResponse:
    """Remove a document from one viewer-administered library."""
    storage_paths: list[str] = []
    hard_deleted = False
    remaining_reference_count = 0

    with transaction(db):
        media = db.execute(
            text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"),
            {"media_id": media_id},
        ).fetchone()
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media[0] not in _DOCUMENT_KINDS:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND,
                "Delete document only supports document media",
            )

        library = db.execute(
            text("""
                SELECT l.id, l.is_default, m.role
                FROM libraries l
                JOIN memberships m
                  ON m.library_id = l.id
                 AND m.user_id = :viewer_id
                WHERE l.id = :library_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        ).fetchone()
        if library is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
        if library[2] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        if bool(library[1]):
            if not remove_media_from_default_intrinsic(
                db, default_library_id=library_id, media_id=media_id
            ):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found in library")
        else:
            if not library_entries.entry_exists(
                db, library_id, library_entries.media_target(media_id)
            ):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found in library")
            library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
            remove_media_from_non_default_closure(db, library_id, media_id)

        library_entries.normalize_positions(db, library_id)

        remaining_reference_count = _total_reference_count(db, media_id)
        if remaining_reference_count == 0:
            paths = delete_document_media_if_unreferenced(db, media_id)
            if paths is not None:
                storage_paths = paths
                hard_deleted = True

    _delete_storage_objects(storage_paths, storage_client)

    return DeleteDocumentResponse(
        status="deleted" if hard_deleted else "removed",
        hard_deleted=hard_deleted,
        removed_from_library_ids=[library_id],
        hidden_for_viewer=False,
        remaining_reference_count=remaining_reference_count,
    )


def clear_user_media_deletion(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    db.execute(
        text("""
            DELETE FROM user_media_deletions
            WHERE user_id = :viewer_id
              AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def delete_duplicate_document_media(db: Session, media_id: UUID) -> list[str]:
    """Hard-delete a duplicate document row after its replacement is reachable."""
    return _delete_document_media_with_references(
        db,
        media_id,
        defect_context="duplicate document media cleanup",
    )


def delete_abandoned_document_media(db: Session, media_id: UUID) -> list[str]:
    """Hard-delete an abandoned document row that never became readable."""
    return _delete_document_media_with_references(
        db,
        media_id,
        defect_context="abandoned document media cleanup",
    )


def _delete_document_media_with_references(
    db: Session,
    media_id: UUID,
    *,
    defect_context: str,
) -> list[str]:
    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return []

    purge_media_default_references(db, media_id)
    affected_library_ids = library_entries.delete_all_entries_for_media(db, media_id)

    storage_paths = delete_document_media_if_unreferenced(db, media_id)
    if storage_paths is None:
        raise RuntimeError(f"{defect_context} left references behind")

    for library_id in affected_library_ids:
        library_entries.normalize_positions(db, library_id)
    return storage_paths


def delete_document_storage_objects(
    storage_paths: list[str],
    storage_client: StorageClientBase | None = None,
) -> None:
    _delete_storage_objects(storage_paths, storage_client)


def delete_document_media_if_unreferenced(db: Session, media_id: UUID) -> list[str] | None:
    """Hard-delete one unreferenced document media row and return storage paths."""
    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return None
    if _total_reference_count(db, media_id) != 0:
        return None

    storage_paths: list[str] = []
    for (storage_path,) in db.execute(
        text("""
            SELECT storage_path
            FROM media_file
            WHERE media_id = :media_id
            UNION
            SELECT storage_path
            FROM epub_resources
            WHERE media_id = :media_id
            UNION
            SELECT source_payload->>'storage_path' AS storage_path
            FROM media_source_attempts
            WHERE media_id = :media_id
              AND source_payload ? 'storage_path'
              AND source_payload->>'storage_path' IS NOT NULL
            ORDER BY storage_path
        """),
        {"media_id": media_id},
    ).fetchall():
        if storage_path not in storage_paths:
            storage_paths.append(storage_path)

    db.execute(
        text("""
            DELETE FROM object_links
            WHERE (a_type = 'media' AND a_id = :media_id)
               OR (b_type = 'media' AND b_id = :media_id)
               OR (a_type = 'highlight' AND a_id IN (
                    SELECT id FROM highlights WHERE anchor_media_id = :media_id
               ))
               OR (b_type = 'highlight' AND b_id IN (
                    SELECT id FROM highlights WHERE anchor_media_id = :media_id
               ))
               OR (a_type = 'content_chunk' AND a_id IN (
                    SELECT id FROM content_chunks WHERE media_id = :media_id
               ))
               OR (b_type = 'content_chunk' AND b_id IN (
                    SELECT id FROM content_chunks WHERE media_id = :media_id
               ))
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM conversation_media WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("UPDATE message_retrievals SET media_id = NULL WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_pdf_quads
            WHERE highlight_id IN (
                SELECT id FROM highlights WHERE anchor_media_id = :media_id
            )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_pdf_anchors
            WHERE media_id = :media_id
               OR highlight_id IN (
                    SELECT id FROM highlights WHERE anchor_media_id = :media_id
               )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_fragment_anchors
            WHERE fragment_id IN (
                SELECT id FROM fragments WHERE media_id = :media_id
            )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM highlights WHERE anchor_media_id = :media_id"),
        {"media_id": media_id},
    )
    delete_media_content_index(db, media_id=media_id)
    db.execute(
        text("""
            DELETE FROM fragment_blocks
            WHERE fragment_id IN (
                SELECT id FROM fragments WHERE media_id = :media_id
            )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_fragment_sources WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_toc_nodes WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_nav_locations WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_resources WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM pdf_page_text_spans WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_transcript_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM podcast_transcript_request_audits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM podcast_transcription_jobs WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM podcast_episode_chapters WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM podcast_listening_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM playback_queue_items WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM reader_media_state WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM user_media_deletions WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            UPDATE external_provider_events
            SET source_attempt_id = NULL
            WHERE source_attempt_id IN (
                SELECT id
                FROM media_source_attempts
                WHERE media_id = :media_id
            )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("UPDATE external_provider_events SET media_id = NULL WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_source_attempts WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM media_file WHERE media_id = :media_id"), {"media_id": media_id})
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
    db.execute(
        text("DELETE FROM podcast_episodes WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM media WHERE id = :media_id"), {"media_id": media_id})
    return storage_paths


def _delete_viewer_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    db.execute(
        text("""
            DELETE FROM object_links
            WHERE user_id = :viewer_id
              AND (
                    (a_type = 'media' AND a_id = :media_id)
                 OR (b_type = 'media' AND b_id = :media_id)
                 OR (a_type = 'highlight' AND a_id IN (
                        SELECT id
                        FROM highlights
                        WHERE user_id = :viewer_id
                          AND anchor_media_id = :media_id
                    ))
                 OR (b_type = 'highlight' AND b_id IN (
                        SELECT id
                        FROM highlights
                        WHERE user_id = :viewer_id
                          AND anchor_media_id = :media_id
                    ))
                 OR (a_type = 'content_chunk' AND a_id IN (
                        SELECT id
                        FROM content_chunks
                        WHERE media_id = :media_id
                    ))
                 OR (b_type = 'content_chunk' AND b_id IN (
                        SELECT id
                        FROM content_chunks
                        WHERE media_id = :media_id
                    ))
              )
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM conversation_media cm
            USING conversations c
            WHERE cm.conversation_id = c.id
              AND c.owner_user_id = :viewer_id
              AND cm.media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
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
    db.execute(
        text("""
            DELETE FROM highlight_pdf_quads hpq
            USING highlights h
            WHERE hpq.highlight_id = h.id
              AND h.user_id = :viewer_id
              AND h.anchor_media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_pdf_anchors hpa
            USING highlights h
            WHERE hpa.highlight_id = h.id
              AND h.user_id = :viewer_id
              AND h.anchor_media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlight_fragment_anchors hfa
            USING highlights h
            WHERE hfa.highlight_id = h.id
              AND h.user_id = :viewer_id
              AND h.anchor_media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM highlights
            WHERE user_id = :viewer_id
              AND anchor_media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM reader_media_state
            WHERE user_id = :viewer_id
              AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM playback_queue_items
            WHERE user_id = :viewer_id
              AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    db.execute(
        text("""
            DELETE FROM podcast_listening_states
            WHERE user_id = :viewer_id
              AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def _delete_storage_objects(
    storage_paths: list[str],
    storage_client: StorageClientBase | None,
) -> None:
    if not storage_paths:
        return
    client = storage_client or get_storage_client()
    for storage_path in storage_paths:
        try:
            client.delete_object(storage_path)
        except StorageError as exc:
            # Storage deletion happens after the DB commit; the document is
            # already unreachable and retryable cleanup is operational.
            logger.warning(
                "document_storage_delete_failed storage_path=%s error=%s",
                storage_path,
                exc,
            )
