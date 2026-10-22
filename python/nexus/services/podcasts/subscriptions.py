"""library-owned ongoing rules, atomic admission and scoped stopping.

create reuses its client id and bound initial import: an extant matching resource
returns current state without repeating acquisition. fresh admission checks exact
library/account guards before any placement. scoped stop compares the complete
frozen destination set and identities atomically. keep ignores arriving-entry
revisions; remove requires them. cancellation never waits on queue rows.
"""

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import podcast as wire
from nexus.services import libraries, library_entries, users
from nexus.services.browse.targets import ResolvedPodcast
from nexus.services.podcasts import imports, sync
from nexus.services.podcasts.shows import upsert_show
from nexus.services.suggestion_changes import record_input_change


def admit(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    body: wire.PodcastSubscriptionCreateRequest | wire.PodcastImportCreateRequest,
) -> wire.PodcastAdmissionOut:
    """Create one finite operation, optionally its ongoing rule, with one frozen intent."""
    from nexus.services.browse.service import resolve_podcast_discovery_target

    if isinstance(body.target, wire.PodcastCanonicalCommitTarget):
        show: UUID | ResolvedPodcast = body.target.podcast_id
    else:
        resolved = resolve_podcast_discovery_target(body.target.target)
        if not isinstance(resolved, ResolvedPodcast):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast"
            )
        show = resolved

    def attempt() -> wire.PodcastAdmissionOut:
        with transaction(db):
            users.lock_viewer(db, viewer_id)
            podcast_id = show if isinstance(show, UUID) else upsert_show(db, show)
            return admit_in_current_transaction(
                db,
                viewer_id=viewer_id,
                library_id=library_id,
                podcast_id=podcast_id,
                id=body.id,
                import_id=body.import_id
                if isinstance(body, wire.PodcastSubscriptionCreateRequest)
                else None,
                expected_order_revision=int(body.expected_order_revision),
                expected_removal_revision=int(body.expected_removal_revision),
            )

    return retry_read_committed(db, "admit_podcast_library", attempt)


def admit_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
    id: UUID,
    import_id: UUID | None,
    expected_order_revision: int,
    expected_removal_revision: int,
) -> wire.PodcastAdmissionOut:
    """Canonical admission shared with approved tools; caller owns the transaction."""
    from nexus.services.podcasts import traversal

    following = import_id is not None
    operation_id = id if import_id is None else import_id

    def result(podcast_id: UUID) -> wire.PodcastAdmissionOut:
        libraries.lock_library_rows_in_order(db, [library_id])
        subscription = None
        if following:
            row = db.execute(
                text("SELECT * FROM library_podcast_subscriptions WHERE id=:id"), {"id": id}
            ).one()
            subscription = wire.PodcastSubscriptionOut(
                id=row.id,
                library_id=row.library_id,
                podcast_id=row.podcast_id,
                initial_import_id=row.initial_import_id,
                created_at=row.created_at,
            )
        library = libraries.access(db, viewer_id, library_id, lock=False)
        removal = db.execute(
            text("SELECT removal_revision FROM users WHERE id=:id"), {"id": viewer_id}
        ).scalar_one()
        return wire.PodcastAdmissionOut.model_validate(
            {
                "podcast_id": podcast_id,
                "href": f"/podcasts/{podcast_id}",
                "subscription": subscription,
                "import": imports.get_import(db, viewer_id, library_id, operation_id),
                "order_revision": str(library.order_revision),
                "removal_revision": str(removal),
            }
        )

    users.lock_viewer(db, viewer_id)
    libraries.access(db, viewer_id, library_id, lock=False)
    if (
        db.scalar(text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    if following:
        existing = db.execute(
            text("SELECT * FROM library_podcast_subscriptions WHERE id=:id"), {"id": id}
        ).first()
        if existing is not None:
            if (
                existing.library_id != library_id
                or existing.podcast_id != podcast_id
                or existing.initial_import_id != operation_id
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Subscription id is taken")
            return result(podcast_id)
    existing_import = db.execute(
        text("""
        SELECT i.library_id,r.podcast_id FROM podcast_library_imports i
        JOIN podcast_feed_runs r ON r.id=i.run_id WHERE i.id=:id
    """),
        {"id": operation_id},
    ).first()
    if existing_import is not None:
        if (
            following
            or existing_import.library_id != library_id
            or existing_import.podcast_id != podcast_id
        ):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Import id is taken")
        return result(podcast_id)
    if db.scalar(
        text("""
        SELECT 1 FROM podcast_library_imports i JOIN podcast_feed_runs r ON r.id=i.run_id
        WHERE i.library_id=:library AND r.podcast_id=:podcast
          AND r.completed_at IS NULL AND r.cancelled_at IS NULL
    """),
        {"library": library_id, "podcast": podcast_id},
    ):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Review or cancel the existing import"
        )
    if following and db.scalar(
        text("""SELECT 1 FROM library_podcast_subscriptions
                                       WHERE library_id=:library AND podcast_id=:podcast"""),
        {"library": library_id, "podcast": podcast_id},
    ):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast is already followed here")
    media = list(
        db.scalars(
            text("""
        SELECT pe.media_id FROM podcast_episodes pe
        WHERE pe.podcast_id=:id AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id=pe.media_id)
        ORDER BY pe.media_id
    """),
            {"id": podcast_id},
        )
    )
    library_entries.lock_media_rows_in_order(db, media)
    for media_id in media:
        library_entries.lock_media_for_reference(db, media_id)
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, library_id])
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_add_content(viewer_id)
    users.require_removal_revision(db, viewer_id, expected_removal_revision)
    if library.order_revision != expected_order_revision:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed")
    run_id = new_uuid7()
    db.execute(
        text("""
        INSERT INTO podcast_feed_runs(id,podcast_id,pending_urls)
        SELECT :run,id,ARRAY[feed_url] FROM podcasts WHERE id=:podcast
    """),
        {"run": run_id, "podcast": podcast_id},
    )
    created = db.scalar(
        text("""
        INSERT INTO podcast_library_imports(id,library_id,run_id)
        VALUES (:id,:library,:run) ON CONFLICT (id) DO NOTHING RETURNING id
    """),
        {"id": operation_id, "library": library_id, "run": run_id},
    )
    if created is None:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Import id is taken")
    if following:
        created = db.scalar(
            text("""
            INSERT INTO library_podcast_subscriptions(id,library_id,podcast_id,initial_import_id)
            VALUES (:id,:library,:podcast,:import) ON CONFLICT (id) DO NOTHING RETURNING id
        """),
            {"id": id, "library": library_id, "podcast": podcast_id, "import": operation_id},
        )
        if created is None:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Subscription id is taken")
        sync.ensure_scheduled(db, podcast_id=podcast_id)
    added, present = library_entries.acquire_podcast_episodes_locked(
        db, viewer_id=viewer_id, library_id=library_id, media_ids=media
    )
    db.execute(
        text("""
        INSERT INTO podcast_import_processed_episodes(import_id,media_id)
        SELECT :id,unnest(CAST(:media AS uuid[]))
    """),
        {"id": operation_id, "media": media},
    )
    db.execute(
        text("""UPDATE podcast_library_imports SET added_count=:added,
                       already_present_count=:present WHERE id=:id"""),
        {"id": operation_id, "added": added, "present": present},
    )
    if (
        libraries.access(db, viewer_id, library_id, lock=False).order_revision
        == expected_order_revision
    ):
        libraries.advance_order_revision(db, library_id)
    traversal.enqueue_step(db, run_id=run_id)
    record_input_change(db)
    return result(podcast_id)


def removal_preview(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    scope: Literal["all", "library"],
    episodes: Literal["keep", "remove"],
    library_id: UUID | None,
) -> wire.PodcastRemovalPreviewOut:
    """One statement snapshots the full selected scope, counts and all command guards."""
    if (scope == "library") != (library_id is not None):
        raise InvalidRequestError(message="Library scope requires a library id")
    if library_id is not None:
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_mutable()
    rows = db.execute(
        text("""
        WITH destinations AS (
            SELECT l.id AS library_id,l.name,l.is_default,l.order_revision,
                   (l.is_default AND l.owner_user_id=:viewer) OR m.role='admin' AS can_add_content,
                   (SELECT count(*)>1 FROM memberships all_m WHERE all_m.library_id=l.id) AS is_shared,
                   s.id AS subscription_id,i.id AS import_id,r.attempt_version AS import_attempt_version,
                   (SELECT count(*) FROM library_entries le JOIN podcast_episodes pe ON pe.media_id=le.media_id
                    WHERE le.library_id=l.id AND pe.podcast_id=:podcast) AS episode_count
            FROM libraries l JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer
            LEFT JOIN library_podcast_subscriptions s ON s.library_id=l.id AND s.podcast_id=:podcast
            LEFT JOIN LATERAL (
                SELECT candidate.* FROM podcast_library_imports candidate
                JOIN podcast_feed_runs run ON run.id=candidate.run_id
                WHERE candidate.library_id=l.id AND run.podcast_id=:podcast
                  AND run.completed_at IS NULL AND run.cancelled_at IS NULL
            ) i ON true
            LEFT JOIN podcast_feed_runs r ON r.id=i.run_id
            WHERE l.system_key IS NULL AND (NOT l.is_default OR l.owner_user_id=:viewer)
        ), selected AS (
            SELECT * FROM destinations d WHERE
                (:scope='library' AND d.library_id=:library) OR
                (:scope='all' AND (d.subscription_id IS NOT NULL OR d.import_id IS NOT NULL OR
                                  (:episodes='remove' AND d.episode_count>0)))
        )
        SELECT u.removal_revision,p.id AS podcast_exists,
               (SELECT count(DISTINCT le.media_id) FROM library_entries le
                JOIN podcast_episodes pe ON pe.media_id=le.media_id AND pe.podcast_id=:podcast
                WHERE le.library_id IN (SELECT library_id FROM selected)) AS distinct_count,
               selected.*
        FROM users u LEFT JOIN podcasts p ON p.id=:podcast LEFT JOIN selected ON true
        WHERE u.id=:viewer ORDER BY selected.library_id
    """),
        {
            "viewer": viewer_id,
            "podcast": podcast_id,
            "scope": scope,
            "episodes": episodes,
            "library": library_id,
        },
    ).all()
    if not rows or rows[0].podcast_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    destinations = [
        wire.PodcastRemovalDestinationOut(
            library_id=row.library_id,
            name=row.name,
            is_default=row.is_default,
            is_shared=row.is_shared,
            subscription_id=row.subscription_id,
            import_id=row.import_id,
            import_attempt_version=row.import_attempt_version,
            order_revision=str(row.order_revision),
            episode_count=row.episode_count,
            can_add_content=row.can_add_content,
        )
        for row in rows
        if row.library_id is not None
    ]
    blocked = [
        wire.PodcastRemovalBlockedOut(library_id=d.library_id, name=d.name, reason="requires_admin")
        for d in destinations
        if not d.can_add_content
    ]
    return wire.PodcastRemovalPreviewOut(
        scope=scope,
        episodes=episodes,
        podcast_id=podcast_id,
        removal_revision=str(rows[0].removal_revision),
        episode_count=rows[0].distinct_count,
        destinations=destinations,
        can_execute=not blocked,
        blocked=blocked,
    )


def stop(
    db: Session, viewer_id: UUID, podcast_id: UUID, body: wire.PodcastStopRequest
) -> wire.PodcastStopOut:
    """Apply a frozen complete scope, or refuse without partial effects."""
    from nexus.services import media_deletion

    def attempt() -> wire.PodcastStopOut:
        with transaction(db):
            users.lock_viewer(db, viewer_id)
            if (
                db.scalar(
                    text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id}
                )
                is None
            ):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
            db.execute(
                text(
                    "SELECT id FROM podcast_feed_runs WHERE podcast_id=:id ORDER BY id FOR UPDATE"
                ),
                {"id": podcast_id},
            )
            library_id = body.destinations[0].library_id if body.scope == "library" else None
            before = removal_preview(
                db,
                viewer_id,
                podcast_id,
                scope=body.scope,
                episodes=body.episodes,
                library_id=library_id,
            )
            selected = [d.library_id for d in before.destinations]
            media = (
                list(
                    db.scalars(
                        text("""
                SELECT DISTINCT le.media_id FROM library_entries le
                JOIN podcast_episodes pe ON pe.media_id=le.media_id
                WHERE pe.podcast_id=:podcast AND le.library_id=ANY(:libraries) ORDER BY le.media_id
            """),
                        {"podcast": podcast_id, "libraries": selected},
                    )
                )
                if body.episodes == "remove"
                else []
            )
            library_entries.lock_media_rows_in_order(db, media)
            if body.scope == "library":
                for media_id in media:
                    library_entries.lock_media_for_reference(db, media_id)
            default_id = libraries.default_library_id(db, viewer_id)
            libraries.lock_library_rows_in_order(db, [default_id, *selected])
            current = removal_preview(
                db,
                viewer_id,
                podcast_id,
                scope=body.scope,
                episodes=body.episodes,
                library_id=library_id,
            )
            users.require_removal_revision(db, viewer_id, int(body.expected_removal_revision))
            expected = {d.library_id: d for d in body.destinations}
            if set(expected) != {d.library_id for d in current.destinations}:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast destinations changed"
                )
            for destination in current.destinations:
                guard = expected[destination.library_id]
                if (
                    destination.subscription_id != guard.expected_subscription_id
                    or destination.import_id != guard.expected_import_id
                    or destination.import_attempt_version != guard.expected_import_attempt_version
                    or (
                        body.episodes == "remove"
                        and destination.order_revision != guard.expected_order_revision
                    )
                ):
                    raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed")
                libraries.access(
                    db, viewer_id, destination.library_id, lock=False
                ).require_add_content(viewer_id)
            for destination in current.destinations:
                if destination.import_id is not None:
                    run_id = db.execute(
                        text("SELECT run_id FROM podcast_library_imports WHERE id=:id"),
                        {"id": destination.import_id},
                    ).scalar_one()
                    imports.cancel_in_current_transaction(db, run_id=run_id)
                if destination.subscription_id is not None:
                    db.execute(
                        text("DELETE FROM library_podcast_subscriptions WHERE id=:id"),
                        {"id": destination.subscription_id},
                    )
            if body.episodes == "remove":
                library_entries.remove_podcast_episodes_locked(
                    db,
                    viewer_id=viewer_id,
                    library_ids=selected,
                    media_ids=media,
                    preserve_personal=body.scope == "library",
                )
                if body.scope == "all":
                    media_deletion.remove_podcast_workspace_access_locked(
                        db, viewer_id=viewer_id, media_ids=media
                    )
            if body.episodes == "remove" and media:
                from nexus.services.dossier import engine as dossier

                affected_members = list(
                    db.scalars(
                        text("""
                    SELECT DISTINCT user_id FROM memberships
                    WHERE library_id=ANY(:ids) AND user_id<>:viewer ORDER BY user_id
                """),
                        {"ids": selected, "viewer": viewer_id},
                    )
                )
                for member_id in affected_members:
                    dossier.on_visibility_lost(db, user_id=member_id)
            for destination in current.destinations:
                libraries.advance_order_revision(db, destination.library_id)
            sync.stop_if_unused(db, podcast_id=podcast_id)
            removal = users.advance_removal_revision(db, viewer_id)
            record_input_change(db)
            return wire.PodcastStopOut(
                podcast_id=podcast_id,
                removal_revision=str(removal),
                destinations=[
                    wire.PodcastStoppedDestinationOut(
                        library_id=d.library_id,
                        order_revision=str(
                            libraries.access(db, viewer_id, d.library_id, lock=False).order_revision
                        ),
                    )
                    for d in current.destinations
                ],
            )

    return retry_read_committed(db, "stop_podcast", attempt)
