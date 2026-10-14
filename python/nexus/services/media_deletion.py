"""Removing a media from a viewer's workspace, and deleting a document nobody holds.

Removal is immediate for the viewer (I5). A document left with no reference gets a
teardown intent and one ``media_teardown`` job in the same transaction: the intent hides
it and blocks new references (I6); the job deletes every row in one transaction, then its
stored objects. An object a failed delete leaves behind is unowned, and the storage
orphan sweep reclaims it (I7).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, non_system_media_ref_exists_sql
from nexus.db.models import Highlight
from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode, ForbiddenError
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobExecutionContext, JobResult, enqueue_job
from nexus.logging import get_logger
from nexus.services import (
    contributors,
    libraries,
    library_entries,
    media_intelligence_lifecycle,
    metadata_operations,
    passage_anchors,
    resource_grants,
)
from nexus.services.consumption import state as consumption_state
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.contributor_writes import MediaTarget
from nexus.services.import_history import (
    delete_processing_history_in_current_transaction,
    rehome_source_supersessions,
)
from nexus.services.reader_apparatus import delete_media_apparatus
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.source_types import stored_artifact_path
from nexus.storage.client import StorageError, get_storage_client

logger = get_logger(__name__)

_DOCUMENT_KINDS = ("pdf", "epub", "web_article")
# Rows keyed plainly by media_id, deleted after the content index and before the media.
_CHILD_TABLES = (
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
_HIGHLIGHTS_OF_MEDIA = "SELECT id FROM highlights WHERE anchor_media_id = :m"


def _run(db: Session, sql: str, **params: object) -> None:
    db.execute(text(sql), params)


def _lock_kind(db: Session, media_id: UUID) -> str | None:
    return db.scalar(text("SELECT kind FROM media WHERE id = :m FOR UPDATE"), {"m": media_id})


def _references(db: Session, media_id: UUID) -> int:
    """Library entries and grants: every path that holds the media."""
    return library_entries.count_entries_for_media(db, media_id) + resource_grants.count_for_media(
        db, media_id
    )


def _claim_teardown(db: Session, media_id: UUID) -> None:
    """One intent and one job per media (I6); the caller holds the media lock."""
    intent_id = db.scalar(
        text("""
            INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :m)
            ON CONFLICT (media_id) DO NOTHING RETURNING id
        """),
        {"id": new_uuid7(), "m": media_id},
    )
    if intent_id is not None:
        enqueue_job(
            db,
            kind="media_teardown",
            payload={"media_id": str(media_id), "intent_id": str(intent_id)},
        )


def claim_document_teardown_if_unreferenced_locked(db: Session, media_id: UUID) -> bool:
    """After the caller removed a reference under the media lock: claim an orphaned document."""
    kind = db.scalar(text("SELECT kind FROM media WHERE id = :m"), {"m": media_id})
    if kind not in _DOCUMENT_KINDS or _references(db, media_id) != 0:
        return False
    _claim_teardown(db, media_id)
    return True


def clear_user_media_deletion(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    _run(
        db,
        "DELETE FROM user_media_deletions WHERE user_id = :u AND media_id = :m",
        u=viewer_id,
        m=media_id,
    )


def remove_media_for_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Drop the media from the viewer's whole workspace (I5). Idempotent: a media the viewer
    cannot read is already removed. One reachable only through a system library is 403."""
    retry_read_committed(db, "remove_media_for_viewer", lambda: _remove(db, viewer_id, media_id))


def _remove(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    from nexus.services import highlights
    from nexus.services.document_embeds import (
        reconcile_document_embed_edges_for_viewer,
        reconcile_document_embed_parent_edges_for_viewer,
    )
    from nexus.services.dossier import engine as dossier_engine

    with transaction(db):
        kind = _lock_kind(db, media_id)
        if kind is None or not can_read_media(db, viewer_id, media_id):
            return
        # A corpus the viewer reaches only through a system library is not theirs to drop.
        controlled = db.execute(
            text(f"SELECT 1 WHERE {non_system_media_ref_exists_sql(':m')}"),
            {"viewer_id": viewer_id, "m": media_id},
        ).first()
        if controlled is None and not resource_grants.media_grant_path_exists(
            db, viewer_user_id=viewer_id, media_id=media_id
        ):
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "System-only media cannot be deleted")

        default_id = db.scalar(
            text("SELECT id FROM libraries WHERE owner_user_id = :u AND is_default"),
            {"u": viewer_id},
        )
        library_ids = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=media_id
        )
        if default_id is not None:
            library_ids.append(default_id)
        library_ids.sort()
        libraries.lock_library_rows_in_order(db, library_ids)
        for library_id in library_ids:
            library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
        resource_grants.delete_viewer_media_paths(db, viewer_user_id=viewer_id, media_id=media_id)

        # The viewer's own reviews, highlights, anchors and retrieval references; the media
        # may live on for other holders, so graph cleanup stays scoped to what goes here.
        metadata_operations.delete_viewer_media_reviews(db, viewer_id=viewer_id, media_id=media_id)
        own_highlights = db.scalars(
            select(Highlight)
            .where(Highlight.user_id == viewer_id, Highlight.anchor_media_id == media_id)
            .order_by(Highlight.id)
        ).all()
        passage_anchors.delete_for_owner(
            db, owner_scheme="media", owner_id=media_id, user_id=viewer_id
        )
        _run(
            db,
            """
            UPDATE message_retrievals mr SET media_id = NULL
            FROM messages msg, conversations c
            WHERE mr.assistant_message_id = msg.id AND msg.conversation_id = c.id
              AND c.owner_user_id = :u AND mr.media_id = :m
            """,
            u=viewer_id,
            m=media_id,
        )
        for highlight in own_highlights:
            highlights.delete_highlight_rows(db, highlight)

        if kind in _DOCUMENT_KINDS and _references(db, media_id) == 0:
            _claim_teardown(db, media_id)
        elif can_read_media(db, viewer_id, media_id):
            # A system-library membership is a path the viewer cannot remove: hide it.
            _run(
                db,
                """
                INSERT INTO user_media_deletions (user_id, media_id) VALUES (:u, :m)
                ON CONFLICT DO NOTHING
                """,
                u=viewer_id,
                m=media_id,
            )
        # Embeds are global source artifacts: reproject only what this viewer now sees.
        reconcile_document_embed_parent_edges_for_viewer(
            db, viewer_id=viewer_id, target_media_id=media_id
        )
        reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=media_id)
        dossier_engine.on_visibility_lost(db, user_id=viewer_id)


def delete_duplicate_document_media(
    db: Session, *, loser_media_id: UUID, winner_media_id: UUID
) -> None:
    """Hand a duplicate document's grants to its winner, then claim it for teardown.

    Grants on the loser's own highlights cannot follow (a highlight is exact to its
    source), so they are revoked first.
    """
    library_entries.lock_media_rows_in_order(db, [loser_media_id, winner_media_id])
    resource_grants.repoint_media_subjects(
        db, loser_media_id=loser_media_id, winner_media_id=winner_media_id
    )
    resource_grants.delete_media_and_child_highlight_subjects(db, loser_media_id)
    rehome_source_supersessions(db, loser_media_id=loser_media_id, winner_media_id=winner_media_id)
    if _lock_kind(db, loser_media_id) not in _DOCUMENT_KINDS:
        return
    libraries.lock_library_rows_in_order(
        db, library_entries.library_ids_for_media(db, loser_media_id)
    )
    library_entries.delete_all_entries_for_media(db, loser_media_id)
    _claim_teardown(db, loser_media_id)


def _storage_paths(db: Session, media_id: UUID) -> list[str]:
    """The file, the epub resources and every attempt's stored source: what the delete owns."""
    paths = db.scalars(
        text("""
            SELECT storage_path FROM media_file WHERE media_id = :m
            UNION SELECT storage_path FROM epub_resources WHERE media_id = :m
        """),
        {"m": media_id},
    ).all()
    payloads = db.scalars(
        text("SELECT source_payload FROM media_source_attempts WHERE media_id = :m"),
        {"m": media_id},
    ).all()
    stored = (stored_artifact_path(payload) for payload in payloads)
    return sorted({*paths, *(path for path in stored if path is not None)})


def _hard_delete(db: Session, media_id: UUID) -> list[str]:
    """Every row of one unreferenced, locked document, in the load-bearing order (I7): owner
    hooks before the rows they own, the content index before the media (claims cite its
    spans), highlight children before their roots. Returns the objects it leaves unowned."""
    from nexus.services import media_upload_sessions
    from nexus.services.dossier import engine as dossier_engine
    from nexus.services.reader_publication import delete_reader_publication

    paths = _storage_paths(db, media_id)
    metadata_operations.delete_media_reviews(db, media_id=media_id)
    dossier_engine.on_subject_deleted(db, ResourceRef(scheme="media", id=media_id))
    resource_grants.delete_media_and_child_highlight_subjects(db, media_id)
    _run(db, "DELETE FROM document_embeds WHERE media_id = :m", m=media_id)
    _run(db, "DELETE FROM document_embed_artifact_states WHERE media_id = :m", m=media_id)
    # Embeds elsewhere that resolved to this media now fail: their target is gone.
    _run(
        db,
        """
        UPDATE document_embeds SET target_media_id = NULL, resolution_status = 'failed',
            error_code = COALESCE(error_code, 'E_MEDIA_DELETED'),
            error_message = COALESCE(error_message, 'Embedded media target was deleted.'),
            updated_at = now()
        WHERE target_media_id = :m
        """,
        m=media_id,
    )
    # One graph cleanup per destroyed ref; cited edges sourced elsewhere keep their snapshots.
    highlight_ids = db.scalars(text(_HIGHLIGHTS_OF_MEDIA), {"m": media_id}).all()
    fragment_ids = db.scalars(
        text("SELECT id FROM fragments WHERE media_id = :m"), {"m": media_id}
    ).all()
    for ref in (
        ResourceRef(scheme="media", id=media_id),
        *(ResourceRef(scheme="highlight", id=highlight_id) for highlight_id in highlight_ids),
        *(ResourceRef(scheme="fragment", id=fragment_id) for fragment_id in fragment_ids),
    ):
        cleanup.delete_edges_for_deleted_resource(db, ref=ref)
    _run(db, "UPDATE message_retrievals SET media_id = NULL WHERE media_id = :m", m=media_id)
    passage_anchors.delete_for_owner(db, owner_scheme="media", owner_id=media_id)
    _run(
        db,
        f"DELETE FROM highlight_pdf_quads WHERE highlight_id IN ({_HIGHLIGHTS_OF_MEDIA})",
        m=media_id,
    )
    _run(
        db,
        f"""DELETE FROM highlight_pdf_anchors
            WHERE media_id = :m OR highlight_id IN ({_HIGHLIGHTS_OF_MEDIA})""",
        m=media_id,
    )
    # By highlight, not fragment: a refresh can leave anchors on replaced fragments.
    _run(
        db,
        f"DELETE FROM highlight_fragment_anchors WHERE highlight_id IN ({_HIGHLIGHTS_OF_MEDIA})",
        m=media_id,
    )
    _run(db, "DELETE FROM highlights WHERE anchor_media_id = :m", m=media_id)
    media_intelligence_lifecycle.delete_media_unit(db, media_id=media_id)
    delete_media_apparatus(db, media_id)
    delete_content_index(db, owner=IndexOwner("media", media_id))
    _run(
        db,
        """DELETE FROM fragment_blocks
            WHERE fragment_id IN (SELECT id FROM fragments WHERE media_id = :m)""",
        m=media_id,
    )
    for table in _CHILD_TABLES:
        _run(db, f"DELETE FROM {table} WHERE media_id = :m", m=media_id)  # noqa: S608
    consumption_state.delete_media_consumption_state_in_txn(db, media_id=media_id)
    _run(db, "DELETE FROM user_media_deletions WHERE media_id = :m", m=media_id)
    contributors.cleanup_credits_for_deleted_target(db, target=MediaTarget(media_id))
    media_upload_sessions.delete_published_media_support_in_current_transaction(
        db, media_id=media_id
    )
    delete_processing_history_in_current_transaction(db, media_id=media_id)
    for table in (
        "x_source_snapshots",
        "media_source_attempts",
        "media_file",
        "fragments",
        "podcast_episodes",
        "media_teardown_intents",
    ):
        _run(db, f"DELETE FROM {table} WHERE media_id = :m", m=media_id)  # noqa: S608
    delete_reader_publication(db, media_id=media_id)
    _run(db, "DELETE FROM media WHERE id = :m", m=media_id)
    return paths


def delete_document_storage_objects(paths: list[str]) -> None:
    """Best effort, after commit: the rows that named these objects are gone (I7)."""
    if not paths:
        return
    client = get_storage_client()
    for path in paths:
        try:
            client.delete_object(path)
        except StorageError as exc:
            logger.warning("document_storage_delete_failed storage_path=%s error=%s", path, exc)


def run_teardown_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """The ``media_teardown`` job; it acts only on its exact (intent, media) (I6).

    ``Stale``: the intent is gone or another's. ``Voided``: a reference reappeared, so the
    intent goes and the media stays. ``Deleted``: every row in one serializable
    transaction, then the objects.
    """
    media_id, intent_id = UUID(payload["media_id"]), UUID(payload["intent_id"])
    with get_session_factory()() as db:

        def op() -> tuple[str, list[str]]:
            _lock_kind(db, media_id)
            intent = db.scalar(
                text("SELECT id FROM media_teardown_intents WHERE media_id = :m"), {"m": media_id}
            )
            if intent != intent_id:
                db.rollback()
                return "Stale", []
            if _references(db, media_id) > 0:
                _run(db, "DELETE FROM media_teardown_intents WHERE id = :i", i=intent_id)
                db.commit()
                return "Voided", []
            paths = _hard_delete(db, media_id)
            db.commit()
            return "Deleted", paths

        disposition, paths = retry_serializable(db, "media_teardown", op)
    delete_document_storage_objects(paths)
    return {"disposition": disposition, "deleted_paths": len(paths)}
