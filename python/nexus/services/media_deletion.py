"""Removing a media from a viewer's workspace, and deleting a document nobody holds.

Removal is immediate for the viewer (I5) and takes the viewer's Lectern row with it, under
the lectern's lock order (viewer, then media). A document left with no rooted reference gets a
teardown intent and one ``media_teardown`` job in the same transaction: the intent hides
it and blocks new references (I6); the job deletes every row in one transaction, then its
stored objects. An object a failed delete leaves behind is unowned, and the storage
orphan sweep reclaims it (I7). capture evidence and archived x assets outlive
media publications and are never deleted here. settled actor-owned x capture
acceptance receipts retain their original target id after physical teardown, so
response-loss replay cannot reacquire or refile. ordinary source attempts die with
the media. accepted pieces
pin one source publication, but only external roots retain the family. visibility
never follows the reverse storage dependency. final family teardown deletes bound
candidates and child identities before releasing source fragments/publication. Teardown locks
contained candidates in media-id order and claims newly unrooted children through
the same jobs. Retry rule: removal is idempotent; teardown acts on its exact intent.
episode removal is a separate guarded placement command. it preserves canonical
identity, authored work, listening, queue and device state. active rules refuse;
unfinished finite additions retain a processed exclusion. an absent retry is inert
only when every current unfinished addition already excludes the episode. newer
placements or unprocessed additions must pass the original guards.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    contained_media_ids_cte_sql,
    personal_media_removal_allowed_sql,
    requested_media_ids_cte_sql,
)
from nexus.db.retries import (
    TransactionRestart,
    integrity_constraint_name,
    retry_serializable,
)
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobExecutionContext, JobResult, enqueue_job, lock_running_job_claim
from nexus.logging import get_logger
from nexus.schemas import feed as wire
from nexus.schemas.media import MediaRemovalPreviewOut
from nexus.services import (
    contributors,
    libraries,
    library_entries,
    media_discoveries,
    media_intelligence_lifecycle,
    media_locks,
    resource_grants,
    source_attempts,
    users,
)
from nexus.services import source_types as st
from nexus.services.consumption import state as consumption_state
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.contributor_writes import MediaTarget
from nexus.services.import_history import delete_processing_history_in_current_transaction
from nexus.services.reader_apparatus import delete_media_apparatus
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection
from nexus.services.source_types import stored_artifact_path
from nexus.services.suggestion_changes import record_input_change
from nexus.storage.client import get_storage_client
from nexus.storage.errors import StorageError

logger = get_logger(__name__)

_DOCUMENT_KINDS = ("pdf", "epub", "web_article", "text_part")
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
    "media_source_supersessions",
)
_HIGHLIGHTS_OF_MEDIA_SQL = text("SELECT id FROM highlights WHERE anchor_media_id = :m")


def _run(db: Session, sql: str, **params: object) -> None:
    db.execute(text(sql), params)


def _lock_kind(db: Session, media_id: UUID) -> str | None:
    media_locks.lock_media_rows_in_order(db, [media_id])
    return db.scalar(text("SELECT kind FROM media WHERE id = :m"), {"m": media_id})


def _references(db: Session, media_id: UUID) -> bool:
    """whether a durable external root retains this source family.

    Incidental cycles have no root and cannot retain themselves. Tombstones hide
    one viewer's content; they do not erase another holder's durable reference.
    """
    roots = """
        SELECT media_id FROM library_entries WHERE media_id IS NOT NULL
        UNION
        SELECT media_id FROM feed_entries
        UNION
        SELECT subject_id FROM resource_grants WHERE subject_scheme = 'media'
        UNION
        SELECT h.anchor_media_id FROM resource_grants g
        JOIN highlights h ON g.subject_scheme = 'highlight' AND g.subject_id = h.id
        WHERE h.authored_visible
    """
    retained = contained_media_ids_cte_sql(roots, include_tearing_down=True)
    return bool(
        db.scalar(
            text(f"SELECT EXISTS (SELECT 1 FROM ({retained}) held WHERE media_id = ANY(:family))"),
            {"family": media_locks.media_family_ids(db, [media_id])},
        )
    )


def _claim_teardown(db: Session, media_id: UUID) -> None:
    """One intent and one job per media (I6); the caller holds the media lock."""
    source = db.scalar(
        text("SELECT source_media_id FROM media_parts WHERE media_id=:m"), {"m": media_id}
    )
    if source is not None:
        media_id = source
    # The reference writer may already have its serializable snapshot while
    # waiting on this row. Touch the tuple so it restarts and sees the intent.
    db.execute(
        text("UPDATE media SET updated_at = updated_at WHERE id = ANY(:ids)"),
        {"ids": media_locks.media_family_ids(db, [media_id])},
    )
    db.execute(
        text("UPDATE podcast_episodes SET chapters_job_id=NULL WHERE media_id=:m"), {"m": media_id}
    )
    intent_id = db.scalar(
        text("""
            INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :m)
            ON CONFLICT (media_id) DO NOTHING RETURNING id
        """),
        {"id": new_uuid7(), "m": media_id},
    )
    # The standalone presentation ends at this commit. Its hidden physical
    # shell and collector no longer reserve the retained logical post identity.
    _run(db, "DELETE FROM x_post_media WHERE media_id = :m", m=media_id)
    if intent_id is not None:
        enqueue_job(
            db,
            kind="media_teardown",
            payload={"media_id": str(media_id), "intent_id": str(intent_id)},
        )


def claim_document_teardown_if_unreferenced_locked(db: Session, media_id: UUID) -> bool:
    """After the caller removed a reference under the media lock: claim an orphaned document."""
    kind = db.scalar(text("SELECT kind FROM media WHERE id = :m"), {"m": media_id})
    if kind not in _DOCUMENT_KINDS or _references(db, media_id):
        return False
    _claim_teardown(db, media_id)
    return True


def lock_highlight_sources(db: Session, highlight_ids: Sequence[UUID]) -> list[UUID]:
    """Lock the source families of highlights about to become hidden; return their media.

    The authored projection calls this under the account head and before it writes those
    highlights or publishes keywords: a live highlight on an X post, or a live highlight
    carrying a grant, is a teardown root. Flush-free; may raise ``TransactionRestart``.
    """
    media_ids = db.scalars(
        text(
            "SELECT DISTINCT anchor_media_id FROM highlights"
            " WHERE id = ANY(:ids) AND anchor_media_id IS NOT NULL"
        ),
        {"ids": list(highlight_ids)},
    ).all()
    return media_locks.lock_media_rows_in_order(db, list(media_ids)) if media_ids else []


def release_highlight_sources(db: Session, media_ids: Sequence[UUID]) -> None:
    """After the projection hid the highlights: claim each source whose final retainer they
    were. Another library entry, grant, live highlight or passage root keeps the bytes;
    the caller still holds the locks taken by ``lock_highlight_sources``."""
    for media_id in sorted(set(media_ids)):
        claim_document_teardown_if_unreferenced_locked(db, media_id)


def clear_user_media_deletion(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    _run(
        db,
        "DELETE FROM user_media_deletions WHERE user_id = :u AND media_id = :m",
        u=viewer_id,
        m=media_id,
    )


def feed_entry_removal_preview(
    db: Session, viewer_id: UUID, media_id: UUID
) -> wire.FeedEntryRemovalPreviewOut:
    """One library guard plus every overlapping source rule and unfinished import."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if not db.scalar(
        text("SELECT 1 FROM feed_entries WHERE media_id=:id LIMIT 1"), {"id": media_id}
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Expected a feed entry")
    rows = db.execute(
        text("""
        WITH protecting_rules AS (
            SELECT s.library_id,s.id AS subscription_id,f.id AS feed_id,f.title
            FROM library_feed_subscriptions s JOIN feeds f ON f.id=s.feed_id
            WHERE EXISTS(SELECT 1 FROM feed_entries e WHERE e.media_id=:media AND e.feed_id=s.feed_id)
        )
        SELECT l.id,l.name,l.is_default,l.order_revision,
            ((l.is_default AND l.owner_user_id=:viewer) OR m.role='admin') AS can_add_content,
            (SELECT count(*)>1 FROM memberships member WHERE member.library_id=l.id) AS is_shared,
            (SELECT count(*)::int FROM library_entries held
                WHERE held.library_id=l.id AND held.media_id=:media) AS item_count,
            ARRAY(SELECT subscription_id FROM protecting_rules WHERE library_id=l.id
                ORDER BY subscription_id) AS subscriptions,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',feed_id,'title',title) ORDER BY feed_id)
                FROM protecting_rules WHERE library_id=l.id),'[]'::jsonb) AS protecting_feeds,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('import_id',i.id,'attempt_version',r.attempt_version)
                ORDER BY i.id) FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
                WHERE i.library_id=l.id AND r.completed_at IS NULL AND r.cancelled_at IS NULL
                AND EXISTS(SELECT 1 FROM feed_entries e WHERE e.media_id=:media AND e.feed_id=r.feed_id)),
                '[]'::jsonb) AS imports
        FROM libraries l JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer
        WHERE l.system_key IS NULL AND (NOT l.is_default OR l.owner_user_id=:viewer)
        ORDER BY l.id
    """),
        {"viewer": viewer_id, "media": media_id},
    ).all()
    rows = [row for row in rows if row.item_count or row.subscriptions or row.imports]
    destinations = [
        wire.FeedEntryRemovalDestinationOut(
            library_id=row.id,
            name=row.name,
            is_default=row.is_default,
            is_shared=row.is_shared,
            order_revision=str(row.order_revision),
            item_count=row.item_count,
            can_add_content=row.can_add_content,
            subscriptions=row.subscriptions,
            imports=[wire.FeedEntryImportGuardOut.model_validate(item) for item in row.imports],
        )
        for row in rows
    ]
    blocked = [
        wire.FeedRemovalBlockedOut(
            library_id=row.id,
            name=row.name,
            reason="subscription_active" if row.subscriptions else "requires_admin",
            feeds=[
                wire.FeedRemovalSourceOut.model_validate(source) for source in row.protecting_feeds
            ],
        )
        for row in rows
        if row.subscriptions or not row.can_add_content
    ]
    return wire.FeedEntryRemovalPreviewOut(
        media_id=media_id,
        removal_revision=str(
            db.scalar(text("SELECT removal_revision FROM users WHERE id=:id"), {"id": viewer_id})
        ),
        destinations=destinations,
        can_execute=not blocked,
        blocked=blocked,
    )


def remove_feed_entry(
    db: Session, viewer_id: UUID, media_id: UUID, body: wire.FeedEntryRemovalRequest
) -> wire.FeedEntryRemovalOut:
    """Exact retained-identity unfiling; never delete authored or consumption state."""
    from nexus.services.feeds import imports

    def attempt() -> wire.FeedEntryRemovalOut:
        users.lock_viewer(db, viewer_id)
        feeds = library_entries.lock_parent_feeds(db, media_id)
        db.execute(
            text("SELECT id FROM feed_runs WHERE feed_id=ANY(:ids) ORDER BY id FOR UPDATE"),
            {"ids": list(feeds)},
        )
        media_locks.lock_media_rows_in_order(db, [media_id])
        before = feed_entry_removal_preview(db, viewer_id, media_id)
        selected = [d.library_id for d in before.destinations]
        libraries.lock_library_rows_in_order(db, selected)
        current = feed_entry_removal_preview(db, viewer_id, media_id)
        if current.blocked:
            blocker = current.blocked[0]
            raise ConflictError(
                ApiErrorCode.E_FEED_SUBSCRIPTION_ACTIVE
                if blocker.reason == "subscription_active"
                else ApiErrorCode.E_RESOURCE_CONFLICT,
                "A library rule or permission prevents removing this entry.",
            )
        can_restore = db.scalar(
            text("""
            SELECT 1 FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
            WHERE i.library_id=ANY(:libraries) AND r.completed_at IS NULL AND r.cancelled_at IS NULL
              AND EXISTS(SELECT 1 FROM feed_entries e WHERE e.feed_id=r.feed_id AND e.media_id=:media)
              AND NOT EXISTS(SELECT 1 FROM feed_import_processed_media done
                             WHERE done.import_id=i.id AND done.media_id=:media) LIMIT 1
        """),
            {"libraries": selected, "media": media_id},
        )
        if not any(d.item_count for d in current.destinations) and not can_restore:
            return wire.FeedEntryRemovalOut(
                media_id=media_id, removal_revision=current.removal_revision
            )
        users.require_removal_revision(db, viewer_id, int(body.expected_removal_revision))
        expected = {d.library_id: d for d in body.destinations}
        if set(expected) != {d.library_id for d in current.destinations}:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Entry destinations changed")
        for destination in current.destinations:
            guard = expected[destination.library_id]
            if guard.expected_order_revision != destination.order_revision or (
                {(g.import_id, g.expected_attempt_version) for g in guard.imports}
                != {(i.import_id, i.attempt_version) for i in destination.imports}
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library or import changed")
            libraries.access(db, viewer_id, destination.library_id, lock=False).require_add_content(
                viewer_id
            )
        imports.mark_processed(db, library_ids=selected, media_id=media_id)
        library_entries.remove_feed_media_locked(db, library_ids=selected, media_ids=[media_id])
        for library_id in selected:
            libraries.advance_order_revision(db, library_id)
        removal = users.advance_removal_revision(db, viewer_id)
        projection.refresh_viewer_contributors(
            db,
            list(
                db.scalars(
                    text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
                    {"ids": selected},
                )
            ),
        )
        record_input_change(db, owners=[f"media:{media_id}", *(f"feed:{feed}" for feed in feeds)])
        return wire.FeedEntryRemovalOut(media_id=media_id, removal_revision=str(removal))

    return retry_serializable(db, "remove_feed_entry", attempt)


def media_removal_preview(db: Session, viewer_id: UUID, media_id: UUID) -> MediaRemovalPreviewOut:
    """Freeze the visible target and acquisition guard before consequence review."""
    row = db.execute(
        text(f"""
            SELECT m.id,m.title,m.kind,m.acquisition_revision,
                   {personal_media_removal_allowed_sql("m.id")} AS allowed
            FROM media m WHERE m.id=:media_id AND m.id IN ({requested_media_ids_cte_sql()})
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if db.scalar(text("SELECT 1 FROM feed_entries WHERE media_id=:id LIMIT 1"), {"id": media_id}):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Feed entry removal requires a reviewed scope"
        )
    if not row.allowed:
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "System-only media cannot be deleted")
    return MediaRemovalPreviewOut(
        media_id=row.id, title=row.title, acquisition_revision=str(row.acquisition_revision)
    )


def remove_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    expected_acquisition_revision: int,
    allowed_kinds: frozenset[str] | None = None,
) -> None:
    """Drop the media from the viewer's whole workspace (I5). Idempotent: a media the viewer
    cannot read is already removed. One reachable only through a system library is 403."""
    retry_serializable(
        db,
        "remove_media_for_viewer",
        lambda: _remove(db, viewer_id, media_id, expected_acquisition_revision, allowed_kinds),
    )


def _remove(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    expected_acquisition_revision: int,
    allowed_kinds: frozenset[str] | None,
) -> None:
    from nexus.services.consumption import lectern
    from nexus.services.document_embeds import (
        reconcile_document_embed_edges_for_viewer,
        reconcile_document_embed_parent_edges_for_viewer,
    )

    # The lectern's lock order, as teardown takes it: the viewer before the media.
    users.lock_viewer(db, viewer_id)
    kind = _lock_kind(db, media_id)
    if kind is None or not can_read_media(db, viewer_id, media_id):
        return
    if allowed_kinds is not None and kind not in allowed_kinds:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Unsupported media kind")
    if db.scalar(text("SELECT 1 FROM feed_entries WHERE media_id=:id LIMIT 1"), {"id": media_id}):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Feed entry removal requires a reviewed scope"
        )
    family_ids = media_locks.media_family_ids(db, [media_id])
    if not db.scalar(
        text(f"SELECT {personal_media_removal_allowed_sql(':m')}"),
        {"viewer_id": viewer_id, "m": media_id},
    ):
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "System-only media cannot be deleted")
    revision = db.execute(
        text("SELECT acquisition_revision FROM media WHERE id=:id"), {"id": media_id}
    ).scalar_one()
    if revision != expected_acquisition_revision:
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Media was acquired again; review removal again"
        )
    users.advance_removal_revision(db, viewer_id)

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
    affected_viewers = db.scalars(
        text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
        {"ids": library_ids},
    ).all()
    libraries.lock_library_rows_in_order(db, library_ids)
    for library_id in library_ids:
        library_entries.delete_entry(db, library_id, library_entries.media_target(media_id))
    if kind == "text_part":
        resource_grants.decline_received_media_paths(
            db, viewer_user_id=viewer_id, media_id=media_id
        )
    else:
        resource_grants.delete_viewer_media_paths(db, viewer_user_id=viewer_id, media_id=media_id)
    # The Lectern is workspace too; like any lectern remove, an absent row still fences.
    lectern.remove_media_in_txn(db, viewer_id=viewer_id, media_id=media_id)

    # Removal is personal and precedes scope recomputation. A retained piece
    # keeps canonical authored evidence, including evidence outside today's scope.
    _run(
        db,
        "INSERT INTO user_media_deletions (user_id,media_id) VALUES (:u,:m) ON CONFLICT DO NOTHING",
        u=viewer_id,
        m=media_id,
    )
    from nexus.services.media_parts import reject_removed_part

    reject_removed_part(db, viewer_id=viewer_id, media_id=media_id)
    if kind in _DOCUMENT_KINDS and not _references(db, media_id):
        _claim_teardown(db, media_id)
    elif can_read_media(db, viewer_id, media_id):
        # Retained media need hiding when a path the viewer cannot remove stays.
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
    projection.refresh_viewer_contributors(db, [viewer_id, *affected_viewers])
    record_input_change(db, owners=(f"media:{member}" for member in family_ids))


def delete_duplicate_document_media(
    db: Session,
    *,
    loser_media_id: UUID,
    winner_media_id: UUID,
    public_capture_manifests: Mapping[UUID, Sequence[UUID]],
) -> None:
    """Hand a duplicate document's grants to its winner, then claim it for teardown.

    Grants on the loser's own highlights cannot follow (a highlight is exact to its
    source), so they are revoked first. Public manifests come from before the
    caller transferred holdings, so a new placement cannot widen an old token.
    """
    media_locks.lock_media_rows_in_order(db, [loser_media_id, winner_media_id])
    resource_grants.repoint_media_subjects(
        db,
        loser_media_id=loser_media_id,
        winner_media_id=winner_media_id,
        public_capture_manifests=public_capture_manifests,
    )
    resource_grants.delete_media_and_child_highlight_subjects(db, loser_media_id)
    source_attempts.rehome_supersessions(
        db, loser_media_id=loser_media_id, winner_media_id=winner_media_id
    )
    if _lock_kind(db, loser_media_id) not in _DOCUMENT_KINDS:
        return
    libraries.lock_library_rows_in_order(
        db, library_entries.library_ids_for_media(db, loser_media_id)
    )
    library_entries.delete_all_entries_for_media(db, loser_media_id)
    db.execute(
        text("UPDATE feed_entries SET media_id=:winner WHERE media_id=:loser"),
        {"winner": winner_media_id, "loser": loser_media_id},
    )
    media_discoveries.transfer(db, source_id=loser_media_id, target_id=winner_media_id)
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
    from nexus.services.reader_publication import delete_reader_publication

    paths = _storage_paths(db, media_id)
    part_source_id = db.scalar(
        text("SELECT source_media_id FROM media_parts WHERE media_id=:id"), {"id": media_id}
    )
    child_ids = list(
        db.scalars(
            text("SELECT media_id FROM media_parts WHERE source_media_id=:m ORDER BY media_id"),
            {"m": media_id},
        )
    )
    if child_ids:
        _run(db, "DELETE FROM media_part_candidates WHERE source_media_id=:m", m=media_id)
        for child_id in child_ids:
            paths.extend(_hard_delete(db, child_id))
    _run(db, "DELETE FROM media_part_candidates WHERE source_media_id=:m OR part_id=:m", m=media_id)
    _run(db, "DELETE FROM media_part_sets WHERE source_media_id=:m", m=media_id)
    _run(db, "DELETE FROM media_parts WHERE media_id=:m", m=media_id)
    if part_source_id is not None:
        projection.refresh_source_highlights(db, part_source_id)
    _run(db, "UPDATE podcast_episodes SET chapters_job_id=NULL WHERE media_id=:m", m=media_id)
    resource_grants.delete_media_and_child_highlight_subjects(db, media_id)
    _run(db, "DELETE FROM document_embeds WHERE media_id = :m", m=media_id)
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
    # One machine-fact cleanup per destroyed ref; cited edges sourced elsewhere keep their
    # snapshots. Authored highlights, their anchor projections, passages and links are
    # independent writing: they keep their literal captures and dangle unreadably here, so
    # only their search occurrences withdraw.
    highlight_ids = db.scalars(_HIGHLIGHTS_OF_MEDIA_SQL, {"m": media_id}).all()
    fragment_ids = db.scalars(
        text("SELECT id FROM fragments WHERE media_id = :m"), {"m": media_id}
    ).all()
    apparatus_ids = db.scalars(
        text("SELECT id FROM reader_apparatus_items WHERE media_id = :m"), {"m": media_id}
    ).all()
    for ref in (
        ResourceRef(scheme="media", id=media_id),
        *(ResourceRef(scheme="fragment", id=fragment_id) for fragment_id in fragment_ids),
    ):
        cleanup.delete_edges_for_deleted_resource(db, ref=ref)
    media_intelligence_lifecycle.delete_media_unit(db, media_id=media_id)
    delete_media_apparatus(db, media_id)
    delete_content_index(db, owner=IndexOwner("media", media_id))
    projection.withdraw(db, "media", [media_id])
    projection.withdraw(db, "fragment", fragment_ids)
    projection.withdraw(db, "highlight", highlight_ids)
    projection.withdraw(db, "reader_apparatus_item", apparatus_ids)
    _run(
        db,
        """DELETE FROM fragment_tables
            WHERE fragment_id IN (SELECT id FROM fragments WHERE media_id = :m)""",
        m=media_id,
    )
    _run(
        db,
        """DELETE FROM fragment_blocks
            WHERE fragment_id IN (SELECT id FROM fragments WHERE media_id = :m)""",
        m=media_id,
    )
    for table in _CHILD_TABLES:
        _run(db, f"DELETE FROM {table} WHERE media_id = :m", m=media_id)  # noqa: S608
    _run(db, "DELETE FROM viewer_media_discoveries WHERE media_id=:m", m=media_id)
    consumption_state.delete_media_consumption_state_in_txn(db, media_id=media_id)
    _run(db, "DELETE FROM user_media_deletions WHERE media_id = :m", m=media_id)
    contributors.cleanup_credits_for_deleted_target(db, target=MediaTarget(media_id))
    media_upload_sessions.delete_published_media_support_in_current_transaction(
        db, media_id=media_id
    )
    delete_processing_history_in_current_transaction(db, media_id=media_id)
    # Bindings and primary occurrences are deletable presentations of retained captures.
    _run(db, "DELETE FROM x_thread_posts WHERE thread_media_id = :m", m=media_id)
    for table in (
        "x_thread_sources",
        "x_article_sources",
        "media_file",
        "fragments",
        "podcast_episodes",
        "media_teardown_intents",
    ):
        _run(db, f"DELETE FROM {table} WHERE media_id = :m", m=media_id)  # noqa: S608
    delete_reader_publication(db, media_id=media_id)
    # Capture-input acceptance is historical even when its reading presentation is gone.
    _run(
        db,
        """
        DELETE FROM media_source_attempts attempt WHERE attempt.media_id=:m
          AND NOT (
              attempt.created_by_user_id IS NOT NULL AND (
                  (attempt.source_type=:x_thread
                    AND EXISTS (SELECT 1 FROM x_post_captures capture
                        WHERE capture.id::text=attempt.source_payload #>> '{capture_input,capture_id}'))
                  OR (attempt.source_type=:x_post AND attempt.status=:succeeded
                    AND attempt.job_id IS NULL AND attempt.finished_at IS NOT NULL
                    AND EXISTS (SELECT 1 FROM x_post_captures capture
                        WHERE attempt.source_payload=jsonb_build_object('capture_id',capture.id::text)))
              )
          )
    """,
        m=media_id,
        x_post=st.X_POST,
        x_thread=st.X_AUTHOR_THREAD,
        succeeded=st.SUCCEEDED,
    )
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
    discovery_jobs = text("""SELECT id FROM background_jobs
        WHERE kind='discover_document_parts'
          AND payload->>'source_media_id'=ANY(:media_ids) ORDER BY id""")
    with get_session_factory()() as db:
        from nexus.services.generation.native_execution import NativeFinalityPending, confirm_job

        intent = db.scalar(
            text("SELECT id FROM media_teardown_intents WHERE media_id=:m"), {"m": media_id}
        )
        job_ids = (
            list(
                db.scalars(
                    discovery_jobs,
                    {
                        "media_ids": [
                            str(id_) for id_ in media_locks.media_family_ids(db, [media_id])
                        ]
                    },
                )
            )
            if intent == intent_id and not _references(db, media_id)
            else []
        )
        db.rollback()
        for job_id in job_ids:
            if confirm_job(job_id, claim=None) == "pending":
                raise NativeFinalityPending()

        def op() -> tuple[str, list[str]]:
            from nexus.services.consumption import lectern
            from nexus.services.generation.ledger import lock_generation_owner

            family_ids = media_locks.media_family_ids(db, [media_id])
            params = {"media_ids": [str(id_) for id_ in family_ids]}
            job_ids = list(db.scalars(discovery_jobs, params))
            # As in turn deletion, owner locks prevent a late opener between this
            # row-set lock and deletion. All generations precede media and job locks.
            for job_id in job_ids:
                lock_generation_owner(db, kind="part_discovery", id=job_id)
            db.execute(
                text("""SELECT id FROM llm_calls
                WHERE job_id=ANY(:ids) AND outcome IS NULL ORDER BY id FOR UPDATE"""),
                {"ids": job_ids},
            ).all()
            viewer_ids = lectern.lock_viewers_for_media_in_txn(db, media_ids=family_ids)
            candidates = list(
                db.scalars(
                    text(
                        contained_media_ids_cte_sql(
                            "SELECT CAST(:m AS uuid) AS media_id", include_tearing_down=True
                        )
                    ),
                    {"m": media_id},
                )
            )
            media_locks.lock_media_rows_in_order(db, candidates)
            intent = db.scalar(
                text("SELECT id FROM media_teardown_intents WHERE media_id = :m"), {"m": media_id}
            )
            if intent != intent_id or lock_running_job_claim(db, context=context) is None:
                return "Stale", []
            if list(db.scalars(discovery_jobs, params)) != job_ids:
                raise TransactionRestart
            if _references(db, media_id):
                _run(db, "DELETE FROM media_teardown_intents WHERE id = :i", i=intent_id)
                record_input_change(db, owners=(f"media:{member}" for member in family_ids))
                return "Voided", []
            for family_id in family_ids:
                lectern.delete_media_in_txn(db, media_id=family_id, locked_viewer_ids=viewer_ids)
            try:
                paths = _hard_delete(db, media_id)
                for child_id in sorted(set(candidates) - {media_id}):
                    claim_document_teardown_if_unreferenced_locked(db, child_id)
            except IntegrityError as exc:
                if integrity_constraint_name(exc) != "fk_consumption_queue_items_media":
                    raise
                # A read-committed writer inserted for an unseen viewer after enumeration.
                # Restart the whole attempt to lock, remove and fence that membership.
                raise TransactionRestart from exc
            record_input_change(db, owners=(f"media:{member}" for member in family_ids))
            return "Deleted", paths

        disposition, paths = retry_serializable(db, "media_teardown", op)
    delete_document_storage_objects(paths)
    return {"disposition": disposition, "deleted_paths": len(paths)}
