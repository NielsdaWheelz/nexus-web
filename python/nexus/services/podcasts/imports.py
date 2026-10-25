"""finite library imports and their processed identities.

a client id identifies one retained operation; duplicate admission never recopies.
retry compares the frozen attempt and library revision, retaining processed rows;
cancel compares the attempt and keeps committed entries. publication runs under
the caller's show/run lock and locks the complete media/library set before filing.
terminal completion/cancel clears processed identities only after fencing workers.
module imports stay light because queue dead letters call finish_run.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from nexus.schemas import podcast as wire


_ROW_SQL = """
    SELECT l.name AS library_name,l.is_default AS library_is_default,i.id,i.library_id,i.run_id,i.added_count,i.already_present_count,i.created_at,
           p.title AS podcast_title,r.podcast_id,r.attempt_version,r.updated_at,r.started_at,r.completed_at,
           r.failed_at,r.cancelled_at,r.error_code,r.error_detail,
           (SELECT s.id FROM library_podcast_subscriptions s
            WHERE s.initial_import_id=i.id) AS subscription_id
    FROM podcast_library_imports i JOIN podcast_feed_runs r ON r.id = i.run_id
    JOIN podcasts p ON p.id=r.podcast_id
    JOIN libraries l ON l.id=i.library_id
"""


def import_from_row(
    row: RowMapping | Mapping[str, Any], *, can_manage: bool, order_revision: int | str
) -> wire.PodcastImportOut:
    from nexus.schemas.podcast import PodcastImportOut

    terminal = [row[key] is not None for key in ("completed_at", "failed_at", "cancelled_at")]
    if sum(terminal) > 1:
        # justify-defect: the run owner permits one terminal fact, never conflicting outcomes.
        raise RuntimeError(f"Invalid podcast run terminal state: {row['run_id']}")
    state: wire.PodcastImportState = (
        "cancelled"
        if row["cancelled_at"] is not None
        else "complete"
        if row["completed_at"] is not None
        else "failed"
        if row["failed_at"] is not None
        else "running"
        if row["started_at"] is not None
        else "pending"
    )
    return PodcastImportOut(
        library_name=row["library_name"],
        library_is_default=row["library_is_default"],
        podcast_title=row["podcast_title"],
        id=row["id"],
        library_id=row["library_id"],
        podcast_id=row["podcast_id"],
        run_id=row["run_id"],
        subscription_id=row["subscription_id"],
        state=state,
        attempt_version=row["attempt_version"],
        added_count=row["added_count"],
        already_present_count=row["already_present_count"],
        error_code=row["error_code"],
        error_detail=row["error_detail"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        can_cancel=can_manage
        and row["subscription_id"] is None
        and state in ("pending", "running", "failed"),
        can_retry=can_manage and state == "failed",
        order_revision=str(order_revision),
    )


def get_import(
    db: Session, viewer_id: UUID, library_id: UUID, import_id: UUID
) -> wire.PodcastImportOut:
    from nexus.errors import ApiErrorCode, NotFoundError
    from nexus.services import libraries

    library = libraries.access(db, viewer_id, library_id, lock=False)
    row = (
        db.execute(
            text(_ROW_SQL + " WHERE i.id = :id AND i.library_id = :library"),
            {"id": import_id, "library": library_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast import not found")
    return import_from_row(
        row,
        can_manage=library.out(viewer_id).can_add_content,
        order_revision=library.order_revision,
    )


def mark_processed(db: Session, *, library_ids: Sequence[UUID], media_id: UUID) -> None:
    """Validated unfiling supersedes every unfinished import, including paused ones.

    the caller holds the show and has checked its exact placement guard first.
    """
    db.execute(
        text("""
        INSERT INTO podcast_import_processed_episodes(import_id,media_id)
        SELECT i.id,:media FROM podcast_library_imports i
        JOIN podcast_feed_runs r ON r.id = i.run_id
        JOIN podcast_episodes pe ON pe.podcast_id = r.podcast_id AND pe.media_id = :media
        WHERE i.library_id = ANY(:libraries) AND r.completed_at IS NULL AND r.cancelled_at IS NULL
        ON CONFLICT (import_id,media_id) DO NOTHING
    """),
        {"media": media_id, "libraries": list(library_ids)},
    )


def finish_run(db: Session, *, run_id: UUID) -> None:
    """Publish an import lifecycle change after its run owner fenced the old job."""
    row = db.execute(
        text("""
        SELECT i.id,i.library_id,r.completed_at,r.cancelled_at FROM podcast_library_imports i
        JOIN podcast_feed_runs r ON r.id = i.run_id WHERE r.id = :run
    """),
        {"run": run_id},
    ).first()
    if row is None:
        return
    if row.completed_at is not None or row.cancelled_at is not None:
        db.execute(
            text("DELETE FROM podcast_import_processed_episodes WHERE import_id = :id"),
            {"id": row.id},
        )
    db.execute(
        text("""UPDATE libraries SET order_revision = nextval('collection_order_revision_seq')
                       WHERE id = :id"""),
        {"id": row.library_id},
    )


def publish_episodes(
    db: Session,
    *,
    podcast_id: UUID,
    media_ids: Sequence[UUID],
    new_media_ids: Sequence[UUID],
    import_id: UUID | None = None,
) -> None:
    """Process this traversal's observations, then insertion-only ongoing delivery.

    each rule/addition files only its destination. metadata refresh never supplies
    ongoing placement authority; episode hiding markers do not exist.
    """
    from nexus.services import libraries, library_entries
    from nexus.services.search import projection

    finite = None
    if import_id is not None:
        finite = db.execute(
            text("""
            SELECT i.id,i.library_id FROM podcast_library_imports i
            JOIN podcast_feed_runs r ON r.id = i.run_id
            WHERE i.id = :id AND r.podcast_id = :podcast AND r.completed_at IS NULL
              AND r.cancelled_at IS NULL AND r.failed_at IS NULL
        """),
            {"id": import_id, "podcast": podcast_id},
        ).first()
        if finite is None:
            return
    ongoing: list[UUID] = list(
        db.scalars(
            text("""
        SELECT library_id FROM library_podcast_subscriptions WHERE podcast_id = :id
    """),
            {"id": podcast_id},
        )
    )
    media = sorted(set(media_ids) | set(new_media_ids))
    held_media = library_entries.lock_media_rows_in_order(db, media)
    held_media = list(
        db.scalars(
            text("""
        SELECT id FROM media WHERE id=ANY(:ids) AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id=media.id) ORDER BY id
    """),
            {"ids": held_media},
        )
    )
    library_entries.lock_media_for_references(db, held_media)
    target_library_ids: set[UUID] = set(ongoing)
    if finite is not None:
        target_library_ids.add(finite.library_id)
    target_libraries = sorted(target_library_ids)
    libraries.lock_library_rows_in_order(db, target_libraries)
    if finite is not None:
        observed = set(media_ids)
        first = list(
            db.scalars(
                text("""
                INSERT INTO podcast_import_processed_episodes(import_id,media_id)
                SELECT :id,unnest(CAST(:media AS uuid[]))
                ON CONFLICT (import_id,media_id) DO NOTHING RETURNING media_id
            """),
                {"id": finite.id, "media": [media for media in held_media if media in observed]},
            )
        )
        added, present = library_entries.add_podcast_episodes_locked(
            db, library_id=finite.library_id, media_ids=sorted(first)
        )
        db.execute(
            text("""UPDATE podcast_library_imports SET added_count = added_count + :added,
                           already_present_count = already_present_count + :present WHERE id = :id"""),
            {"id": finite.id, "added": added, "present": present},
        )
    arrivals = sorted(set(new_media_ids) & set(held_media))
    for library_id in ongoing:
        library_entries.add_podcast_episodes_locked(db, library_id=library_id, media_ids=arrivals)
    if held_media and target_libraries:
        projection.refresh_viewer_contributors(
            db,
            list(
                db.scalars(
                    text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
                    {"ids": target_libraries},
                )
            ),
        )


def cancel(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    import_id: UUID,
    body: wire.PodcastImportCancelRequest,
) -> wire.PodcastImportOut:
    from nexus.db.retries import retry_read_committed
    from nexus.errors import ApiErrorCode, ConflictError
    from nexus.services import libraries, users

    def attempt() -> wire.PodcastImportOut:
        users.lock_viewer(db, viewer_id)
        row = _lock_import(db, viewer_id, library_id, import_id)
        libraries.lock_library_rows_in_order(db, [library_id])
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_add_content(viewer_id)
        if row["subscription_id"] is not None:
            raise ConflictError(
                ApiErrorCode.E_PODCAST_SUBSCRIPTION_ACTIVE,
                "Unsubscribe before cancelling initial history",
            )
        if row["attempt_version"] != body.expected_attempt_version:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast import changed")
        if row["completed_at"] is None and row["cancelled_at"] is None:
            cancel_in_current_transaction(db, run_id=row["run_id"])
            users.advance_removal_revision(db, viewer_id)
        return get_import(db, viewer_id, library_id, import_id)

    return retry_read_committed(db, "cancel_podcast_import", attempt)


def cancel_in_current_transaction(db: Session, *, run_id: UUID) -> None:
    """Show/run locks precede this transition; obsolete queue work settles as stale."""
    changed = db.scalar(
        text("""
        UPDATE podcast_feed_runs SET cancelled_at = now(),failed_at = NULL,job_id = NULL,
            error_code = NULL,error_detail = NULL,updated_at = now()
        WHERE id = :id AND completed_at IS NULL AND cancelled_at IS NULL RETURNING id
    """),
        {"id": run_id},
    )
    if changed is not None:
        finish_run(db, run_id=run_id)


def retry(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    import_id: UUID,
    body: wire.PodcastImportRetryRequest,
) -> wire.PodcastImportOut:
    from nexus.db.retries import retry_read_committed
    from nexus.errors import ApiErrorCode, ConflictError
    from nexus.services import libraries, users
    from nexus.services.podcasts import traversal

    def attempt() -> wire.PodcastImportOut:
        users.lock_viewer(db, viewer_id)
        row = _lock_import(db, viewer_id, library_id, import_id)
        libraries.lock_library_rows_in_order(db, [library_id])
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_add_content(viewer_id)
        if (
            row["attempt_version"] != body.expected_attempt_version
            or library.order_revision != int(body.expected_order_revision)
            or row["failed_at"] is None
        ):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast import changed")
        db.execute(
            text("""
            UPDATE podcast_feed_runs r SET attempt_version = attempt_version + 1,
                failed_at = NULL,error_code = NULL,error_detail = NULL,job_id = NULL,
                pending_urls = CASE WHEN cardinality(pending_urls) = 0 THEN ARRAY[p.feed_url]
                                    ELSE pending_urls END,
                visited_urls = CASE WHEN cardinality(pending_urls) = 0 THEN '{}'::text[]
                                    ELSE visited_urls END,
                had_coverage_gaps = CASE WHEN cardinality(pending_urls) = 0 THEN false
                                        ELSE had_coverage_gaps END,
                updated_at = now()
            FROM podcasts p WHERE r.id = :id AND p.id = r.podcast_id
        """),
            {"id": row["run_id"]},
        )
        traversal.enqueue_step(db, run_id=row["run_id"])
        libraries.advance_order_revision(db, library_id)
        return get_import(db, viewer_id, library_id, import_id)

    return retry_read_committed(db, "retry_podcast_import", attempt)


def _lock_import(db: Session, viewer_id: UUID, library_id: UUID, import_id: UUID) -> RowMapping:
    from nexus.errors import ApiErrorCode, NotFoundError
    from nexus.services import libraries

    libraries.access(db, viewer_id, library_id, lock=False)
    row = (
        db.execute(
            text(_ROW_SQL + " WHERE i.id = :id AND i.library_id = :library"),
            {"id": import_id, "library": library_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast import not found")
    db.execute(text("SELECT id FROM podcasts WHERE id = :id FOR UPDATE"), {"id": row["podcast_id"]})
    return (
        db.execute(text(_ROW_SQL + " WHERE i.id = :id FOR UPDATE OF i,r"), {"id": import_id})
        .mappings()
        .one()
    )


def delete_for_libraries(db: Session, *, library_ids: Sequence[UUID]) -> None:
    """Explicit child cleanup; caller holds the complete show/run/library lock set."""
    params = {"libraries": list(library_ids)}
    run_ids = list(
        db.scalars(
            text("SELECT run_id FROM podcast_library_imports WHERE library_id = ANY(:libraries)"),
            params,
        )
    )
    db.execute(
        text("DELETE FROM library_podcast_subscriptions WHERE library_id = ANY(:libraries)"), params
    )
    db.execute(
        text("""DELETE FROM podcast_import_processed_episodes WHERE import_id IN
                       (SELECT id FROM podcast_library_imports WHERE library_id = ANY(:libraries))"""),
        params,
    )
    db.execute(
        text("DELETE FROM podcast_library_imports WHERE library_id = ANY(:libraries)"), params
    )
    db.execute(text("DELETE FROM podcast_feed_runs WHERE id = ANY(:ids)"), {"ids": run_ids})
