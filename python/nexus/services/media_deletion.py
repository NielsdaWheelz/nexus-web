"""Document deletion service.

Media teardown (spec ``lectern-player-lifecycle-hard-cutover.md`` §3.1): removing
the last lifetime reference no longer deletes storage or child state inline. The
claim (:func:`claim_media_teardown`) locks only the media row, checks zero
committed references, inserts a UUIDv7 teardown intent, and enqueues one
addressable ``media_teardown`` job in that same transaction. The job
(:mod:`nexus.tasks.media_teardown`) owns the checkpointed physical deletion and
storage sweep. Child-state deletion composes through the consumption owner
(never direct consumption/listening/engagement DML here). Viewer-scoped
removal/hide preserves consumption and latent Lectern rows; the visibility
projection hides them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, non_system_media_ref_exists_sql
from nexus.db.models import MediaKind
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
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
    media_intelligence,
    passage_anchors,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.document_embeds import detach_document_embed_targets_for_owner
from nexus.services.reader_apparatus import delete_media_apparatus
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.source_attempt_artifacts import source_attempt_storage_paths
from nexus.storage.client import StorageError, get_storage_client

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

logger = get_logger(__name__)

# The durable teardown job kind + its retry policy live in the registry; this is
# the one enqueue site for the claim.
_MEDIA_TEARDOWN_JOB_KIND = "media_teardown"


def claim_media_teardown(db: Session, media_id: UUID) -> UUID:
    """Claim a media for physical teardown: intent + one addressable job, one txn.

    Locks only the media row, checks zero committed references, inserts the UUIDv7
    intent, and enqueues one ``media_teardown`` job — all inside the caller's open
    transaction, so creator-first makes this observe a reference and claim-first makes
    a creator raise ``E_MEDIA_DELETING`` (they linearize on the media row). Idempotent:
    if the exact intent already exists (concurrent/replayed delete of an already-
    tearing-down media), it returns that intent id without enqueuing a second job.
    Callers must have already confirmed zero references under the media lock.
    """
    db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    )
    existing = db.execute(
        text("SELECT id FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if existing is not None:
        return UUID(str(existing[0]))
    if _total_reference_count(db, media_id) != 0:
        # justify-defect: the claim doorway is only reached after the caller removed
        # the last reference under the media lock. A reference here is an impossible
        # state, not a modeled outcome.
        raise RuntimeError("claim_media_teardown reached with references still present")

    intent_id = new_uuid7()
    db.execute(
        text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
        {"id": intent_id, "media_id": media_id},
    )
    enqueue_job(
        db,
        kind=_MEDIA_TEARDOWN_JOB_KIND,
        payload={
            "mediaId": str(media_id),
            "intentId": str(intent_id),
            "checkpoint": {"kind": "Unprepared"},
        },
        max_attempts=5,
    )
    return intent_id


_DOCUMENT_KINDS = {
    MediaKind.pdf.value,
    MediaKind.epub.value,
    MediaKind.web_article.value,
}


def _total_reference_count(db: Session, media_id: UUID) -> int:
    """All remaining references to a media (spec S4.3/AC5): physical
    ``library_entries`` rows are the sole reference count — no closure/intrinsic
    count survives."""
    return library_entries.count_entries_for_media(db, media_id)


def _viewer_has_non_system_media_reference(db: Session, *, viewer_id: UUID, media_id: UUID) -> bool:
    """True iff the viewer's current memberships reach this media through at least
    one non-system library (default or otherwise) — a path a viewer delete could
    actually remove or hide. Its complement is "system-only media" (spec S4.3/S5):
    when this is False the viewer's only relationship to the media is a system
    (e.g. Oracle) library they never control and whose corpus data a viewer action
    never deletes, so a direct delete is a rejection, not a successful no-op.

    Shares the reachability predicate with ``media.py``'s ``can_delete`` column
    via :func:`nexus.auth.permissions.non_system_media_ref_exists_sql` so the two
    forms cannot drift."""
    return bool(
        db.execute(
            text(f"SELECT 1 WHERE {non_system_media_ref_exists_sql(':media_id')}"),
            {"viewer_id": viewer_id, "media_id": media_id},
        ).first()
    )


def delete_document_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> MediaDeleteResult:
    """Remove a document from the viewer's whole workspace (spec §4.3).

    Truthful viewer deletion: system-only media (the viewer's only path is a
    system library they never control) is ``E_FORBIDDEN`` with no mutation —
    corpus data is never deleted through a viewer action. Otherwise removes the
    viewer's own default/administered-non-default entries, preserves latent
    consumption/listening rows, then: last physical reference gone -> claim
    (intent + job), return ``Deleting``; a non-system reference the viewer
    doesn't control still reaches the media -> record the viewer hide marker and
    return ``Hidden``; only a system-library reference remains -> ``Removed``
    without a hide marker. Storage and child-state teardown are owned by the
    ``media_teardown`` job, not this transaction.
    """
    removed_from_library_ids: list[UUID] = []

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
        if not _viewer_has_non_system_media_reference(db, viewer_id=viewer_id, media_id=media_id):
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "System-only media cannot be deleted")

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
            if library_entries.delete_entry(
                db, default_library_id, library_entries.media_target(media_id)
            ):
                removed_from_library_ids.append(UUID(str(default_library_id)))
                library_entries.normalize_positions(db, default_library_id)

        controlled_libraries = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=media_id
        )
        for library_id in controlled_libraries:
            library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
            library_entries.normalize_positions(db, library_id)
            removed_from_library_ids.append(UUID(str(library_id)))

        _delete_viewer_media_state(db, viewer_id, media_id)

        remaining_reference_count = _total_reference_count(db, media_id)
        if remaining_reference_count == 0:
            claim_media_teardown(db, media_id)
            return MediaDeletingResult()

        # The viewer's own document embeds targeting this media now point at a
        # media they can no longer resolve — mark them unavailable regardless of
        # whether the outcome is Hidden or Removed (owner-scoped cleanup, not a
        # tombstone concern).
        detach_document_embed_targets_for_owner(
            db, owner_user_id=viewer_id, target_media_id=media_id
        )

        # A remaining reference the viewer could not remove is either a shared
        # non-system library still reachable by them (hide it per-viewer) or a
        # reference they can no longer reach — a system-only library, or another
        # user's private library (never surfaced to the viewer → nothing to
        # hide). Branch on whether the viewer retains a reachable NON-SYSTEM
        # path, not on the presence of a system one: a media with BOTH a system
        # reference AND a remaining reachable non-system shared reference must
        # still be Hidden, else it stays visible with no tombstone (AC5
        # "truthful" violation).
        if not _viewer_has_non_system_media_reference(db, viewer_id=viewer_id, media_id=media_id):
            return MediaRemovedResult(
                removed_from_library_ids=removed_from_library_ids,
                remaining_reference_count=remaining_reference_count,
            )

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
        return MediaHiddenResult(
            removed_from_library_ids=removed_from_library_ids,
            remaining_reference_count=remaining_reference_count,
        )


def remove_document_from_library(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> MediaDeleteResult:
    """Remove a document from one viewer-administered library (spec §3.1).

    Scoped removal returns ``Removed`` while any lifetime reference remains, and
    ``Deleting`` (claim: intent + job) when it removes the last one. It never records a
    viewer hide marker.
    """
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
                SELECT m.role, l.system_key
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
        if library[0] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")
        library_governance.require_not_system(library[1])

        if not library_entries.entry_exists(db, library_id, library_entries.media_target(media_id)):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found in library")
        library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))

        library_entries.normalize_positions(db, library_id)

        remaining_reference_count = _total_reference_count(db, media_id)
        if remaining_reference_count == 0:
            claim_media_teardown(db, media_id)
            return MediaDeletingResult()

        return MediaRemovedResult(
            removed_from_library_ids=[library_id],
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
    """Claim a duplicate document row for teardown after its replacement is reachable.

    Routes through the claim doorway (spec §3.1): purge the loser's references, then
    claim (intent + ``media_teardown`` job) so the durable job owns the physical
    deletion and storage sweep. Returns an empty path list — the job, not the caller,
    deletes storage.
    """
    return _claim_document_media_teardown(db, media_id)


def delete_abandoned_document_media(db: Session, media_id: UUID) -> list[str]:
    """Claim an abandoned document row (never became readable) for teardown.

    Same claim doorway as :func:`delete_duplicate_document_media`; returns an empty path
    list because the ``media_teardown`` job owns storage deletion.
    """
    return _claim_document_media_teardown(db, media_id)


def _claim_document_media_teardown(db: Session, media_id: UUID) -> list[str]:
    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return []

    affected_library_ids = library_entries.delete_all_entries_for_media(db, media_id)
    for library_id in affected_library_ids:
        library_entries.normalize_positions(db, library_id)

    claim_media_teardown(db, media_id)
    return []


def delete_document_storage_objects(
    storage_paths: list[str],
    storage_client: StorageClientBase | None = None,
) -> None:
    """Best-effort delete of already-unreachable storage objects.

    Legacy synchronous helper kept for non-teardown cleanup (extraction-artifact GC on
    source requeue). Media teardown no longer produces paths here — its callers now
    claim + enqueue and pass an empty list — so this is a no-op on the teardown paths.
    """
    _delete_storage_objects(storage_paths, storage_client)


def enumerate_media_storage_paths(db: Session, media_id: UUID) -> list[str]:
    """Every storage object a media hard-delete owns: file, EPUB resources, and
    source-attempt artifacts, sorted and de-duplicated.

    The pure path enumerator reused by the ``media_teardown`` job's preparation
    checkpoint and by :func:`delete_document_media_if_unreferenced`. It reads rows only;
    it never touches storage or deletes anything.
    """
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
            ORDER BY storage_path
        """),
        {"media_id": media_id},
    ).fetchall():
        if storage_path not in storage_paths:
            storage_paths.append(storage_path)
    for (source_payload,) in db.execute(
        text("""
            SELECT source_payload
            FROM media_source_attempts
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
    """Hard-delete one unreferenced document media row and return storage paths.

    Deletes the four in-scope consumption/attention child families through their owners
    (never direct consumption/listening DML), then the remaining child tables, the
    teardown intent, and the media row. Composed by the ``media_teardown`` job inside
    its deletion transaction, and by library teardown. Returns ``None`` (deleting
    nothing) when the media is missing, non-document, or still referenced.
    """
    media = db.execute(
        text("SELECT kind FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if media is None or media[0] not in _DOCUMENT_KINDS:
        return None
    if _total_reference_count(db, media_id) != 0:
        return None

    storage_paths = enumerate_media_storage_paths(db, media_id)

    db.execute(
        text("DELETE FROM document_embeds WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM document_embed_artifact_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    affected_embed_parent_ids = {
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
    for embed_parent_id in affected_embed_parent_ids:
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
            {"media_id": embed_parent_id},
        )

    # Graph cleanup, one call per resource ref this deletion destroys (§9.6,
    # AC12): the media row, its highlights, and its fragments. The media's
    # evidence spans and content chunks are cleaned inside delete_content_index
    # by their owner; its passage anchors (and edges/view states touching them)
    # by delete_for_owner below. Bare edges touching a destroyed ref die; cited
    # edges sourced elsewhere survive on their snapshots (the evidence
    # invariant). Attached note prose is never deleted here — highlight/link
    # notes lose only their edges and survive as standalone notes.
    for ref in _destroyed_media_refs(db, media_id):
        cleanup.delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(
        text("UPDATE message_retrievals SET media_id = NULL WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    # True owner deletion: all users' passage anchors on this media, then the
    # Highlight children/root (explicit child-first — no DB cascades remain).
    passage_anchors.delete_for_owner(db, owner_scheme="media", owner_id=media_id)
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
    # Scope by highlight, not the disposable fragment_id cache: a refresh that
    # replaced fragments leaves anchors pointing at deleted fragment rows, and
    # those must die here too or the Highlight-root delete below hits its FK.
    db.execute(
        text("""
            DELETE FROM highlight_fragment_anchors
            WHERE highlight_id IN (
                SELECT id FROM highlights WHERE anchor_media_id = :media_id
            )
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM highlights WHERE anchor_media_id = :media_id"),
        {"media_id": media_id},
    )
    # Tear down the per-media intelligence unit through its sole owner before the
    # content index removes this media's evidence_spans (media_claims FK them) and
    # before the media row goes (both unit tables FK media, non-cascading).
    media_intelligence.delete_media_unit(db, media_id=media_id)
    delete_media_apparatus(db, media_id)
    delete_content_index(db, owner=IndexOwner("media", media_id))
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
    # Four in-scope child families through the one consumption owner (spec §3,
    # §8.15): all users' Lectern/override/listening/reader-engagement rows.
    # media_deletion never writes those tables directly.
    consumption_service.delete_media_consumption_state_in_txn(db, media_id=media_id)
    db.execute(
        text("DELETE FROM reader_media_state WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM user_media_deletions WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    # Removes the credits, deletes this media's author-edit replay memos, and
    # prunes any contributor left with no other reference (spec §2.8). Runs on
    # this deletion transaction — the documented composition exception (§3).
    contributors.cleanup_credits_for_deleted_target(db, target=contributors.MediaTarget(media_id))
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
    # A committed deletion deletes the teardown intent together with the media row it
    # claimed (the intent FKs media). Only one intent per media (unique media_id), and
    # the caller verified the exact intent before reaching this point.
    db.execute(
        text("DELETE FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM media WHERE id = :media_id"), {"media_id": media_id})
    return storage_paths


def _destroyed_media_refs(db: Session, media_id: UUID) -> list[ResourceRef]:
    """Every resource ref the media hard-delete destroys, scheme-mapped (§9.6)."""
    highlight_ids = (
        db.execute(
            text("SELECT id FROM highlights WHERE anchor_media_id = :media_id"),
            {"media_id": media_id},
        )
        .scalars()
        .all()
    )
    fragment_ids = (
        db.execute(
            text("SELECT id FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .scalars()
        .all()
    )
    return [
        ResourceRef(scheme="media", id=media_id),
        *(ResourceRef(scheme="highlight", id=highlight_id) for highlight_id in highlight_ids),
        *(ResourceRef(scheme="fragment", id=fragment_id) for fragment_id in fragment_ids),
    ]


def _delete_viewer_media_state(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    # The viewer's highlights and passage anchors are the only resources this
    # path destroys; the media itself may survive for other holders, so graph
    # cleanup is scoped to the deleted refs (§9.6). When the media is
    # hard-deleted right after, its own edges die in
    # delete_document_media_if_unreferenced.
    highlight_ids = (
        db.execute(
            text(
                "SELECT id FROM highlights "
                "WHERE user_id = :viewer_id AND anchor_media_id = :media_id"
            ),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .scalars()
        .all()
    )
    for highlight_id in highlight_ids:
        cleanup.delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="highlight", id=highlight_id)
        )
    # The viewer's own passage anchors on this media die with their workspace
    # removal (their edges/view states first, inside delete_for_owner); other
    # users' anchors survive until true media deletion.
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
    # Behavior change (spec §3): viewer-scoped removal/hide preserves the viewer's
    # latent Lectern and listening rows (owned by the consumption stores). The
    # visibility projection hides them while the media is out of the viewer's
    # workspace; explicit re-add restores them after clearing the hide marker. Only the
    # last-reference physical teardown removes them, through the consumption owner.


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
