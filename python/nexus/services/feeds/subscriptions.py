"""library-owned ongoing rules, atomic admission and scoped stopping.

create reuses its client id and bound initial import: an extant matching resource
returns current state without repeating acquisition. fresh admission checks library
authority and the account's removal fence before any placement; an addition compares
no library order. discovery replay validates its sealed source against retained
identities before provider work; a removed rule's retained initial import refuses
recreation. preflight ends before provider reads, and the final locked owner rechecks
identity and authority. scoped stop compares the complete frozen destination set and
identities atomically. keep ignores arriving-entry revisions and independent
additions; remove requires them and fences all selected additions. rules leave before
placements. bulk addition and cleanup touch only their chosen destinations, never
manufacture personal holdings, and preserve authored work, listening state and
queue/device state. cancellation never waits on queue rows.
"""

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import feed as wire
from nexus.services import libraries, library_entries, media_locks, users
from nexus.services.browse.targets import PodcastIndexPodcastTarget, ResolvedPodcast, unseal_target
from nexus.services.feeds import imports, sync
from nexus.services.feeds.catalog import adopt_resolved, from_podcast
from nexus.services.feeds.queries import require_feed_access
from nexus.services.podcasts.provider import PROVIDER
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change


def admit(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    body: wire.FeedSubscriptionCreateRequest | wire.FeedImportCreateRequest,
) -> wire.FeedAdmissionOut:
    """Create one finite operation, optionally its ongoing rule, with one frozen intent."""
    from nexus.services.browse.service import resolve_podcast_discovery_target

    discovery_ref = None
    if isinstance(body.target, wire.FeedCanonicalCommitTarget):
        show: UUID | ResolvedPodcast = body.target.feed_id
    else:
        handle = body.target.target
        target = unseal_target(handle)
        if not isinstance(target, PodcastIndexPodcastTarget):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast"
            )
        discovery_ref = target.podcast_ref

        def existing_identity() -> UUID | None:
            libraries.access(db, viewer_id, library_id, lock=False)
            if isinstance(body, wire.FeedSubscriptionCreateRequest):
                existing = db.execute(
                    text("""
                    SELECT s.library_id,s.initial_import_id,p.id AS feed_id,
                           p.provider,p.provider_podcast_id
                    FROM library_feed_subscriptions s JOIN feeds p ON p.id=s.feed_id
                    WHERE s.id=:id
                """),
                    {"id": body.id},
                ).first()
                if existing is not None:
                    if (
                        existing.library_id != library_id
                        or existing.initial_import_id != body.import_id
                        or existing.provider != PROVIDER
                        or existing.provider_podcast_id != discovery_ref
                    ):
                        raise ConflictError(
                            ApiErrorCode.E_RESOURCE_CONFLICT, "Subscription id is taken"
                        )
                    return existing.feed_id
            existing = db.execute(
                text("""
                SELECT i.library_id,p.id AS feed_id,p.provider,p.provider_podcast_id
                FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
                JOIN feeds p ON p.id=r.feed_id WHERE i.id=:id
            """),
                {
                    "id": body.import_id
                    if isinstance(body, wire.FeedSubscriptionCreateRequest)
                    else body.id
                },
            ).first()
            if existing is None:
                return None
            if (
                isinstance(body, wire.FeedSubscriptionCreateRequest)
                or existing.library_id != library_id
                or existing.provider != PROVIDER
                or existing.provider_podcast_id != discovery_ref
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Import id is taken")
            return existing.feed_id

        known = retry_serializable(db, "read_feed_admission_identity", existing_identity)
        if known is not None:
            show = known
        else:
            resolved = resolve_podcast_discovery_target(handle)
            if not isinstance(resolved, ResolvedPodcast):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast"
                )
            show = resolved

    def attempt() -> wire.FeedAdmissionOut:
        users.lock_viewer(db, viewer_id)
        feed_id = (
            show if isinstance(show, UUID) else adopt_resolved(db, viewer_id, from_podcast(show))
        )
        if discovery_ref is not None and isinstance(show, UUID):
            identity = db.execute(
                text("""SELECT provider,provider_podcast_id FROM feeds
                        WHERE id=:id FOR UPDATE"""),
                {"id": feed_id},
            ).first()
            if identity is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
            if identity.provider != PROVIDER or identity.provider_podcast_id != discovery_ref:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Feed identity changed")
        return admit_in_current_transaction(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            feed_id=feed_id,
            id=body.id,
            import_id=body.import_id
            if isinstance(body, wire.FeedSubscriptionCreateRequest)
            else None,
            expected_removal_revision=int(body.expected_removal_revision),
        )

    return retry_serializable(db, "admit_feed_library", attempt)


def admit_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    feed_id: UUID,
    id: UUID,
    import_id: UUID | None,
    expected_removal_revision: int,
) -> wire.FeedAdmissionOut:
    """Canonical admission shared with approved tools; caller owns the transaction."""
    from nexus.services.feeds import traversal

    following = import_id is not None
    operation_id = id if import_id is None else import_id

    def result(feed_id: UUID) -> wire.FeedAdmissionOut:
        libraries.lock_library_rows_in_order(db, [library_id])
        subscription = None
        if following:
            row = db.execute(
                text("SELECT * FROM library_feed_subscriptions WHERE id=:id"), {"id": id}
            ).one()
            subscription = wire.FeedSubscriptionOut(
                id=row.id,
                library_id=row.library_id,
                feed_id=row.feed_id,
                initial_import_id=row.initial_import_id,
                created_at=row.created_at,
            )
        library = libraries.access(db, viewer_id, library_id, lock=False)
        removal = db.execute(
            text("SELECT removal_revision FROM users WHERE id=:id"), {"id": viewer_id}
        ).scalar_one()
        return wire.FeedAdmissionOut.model_validate(
            {
                "feed_id": feed_id,
                "href": f"/{'podcasts' if db.scalar(text('SELECT kind FROM feeds WHERE id=:id'), {'id': feed_id}) == 'podcast' else 'feeds'}/{feed_id}",
                "subscription": subscription,
                "operation": imports.get_import(db, viewer_id, library_id, operation_id),
                "order_revision": str(library.order_revision),
                "removal_revision": str(removal),
            }
        )

    users.lock_viewer(db, viewer_id)
    libraries.access(db, viewer_id, library_id, lock=False)
    require_feed_access(db, viewer_id, feed_id)
    if db.scalar(text("SELECT id FROM feeds WHERE id=:id FOR UPDATE"), {"id": feed_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
    if following:
        existing = db.execute(
            text("SELECT * FROM library_feed_subscriptions WHERE id=:id"), {"id": id}
        ).first()
        if existing is not None:
            if (
                existing.library_id != library_id
                or existing.feed_id != feed_id
                or existing.initial_import_id != operation_id
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Subscription id is taken")
            return result(feed_id)
    existing_import = db.execute(
        text("""
        SELECT i.library_id,r.feed_id FROM library_feed_imports i
        JOIN feed_runs r ON r.id=i.run_id WHERE i.id=:id
    """),
        {"id": operation_id},
    ).first()
    if existing_import is not None:
        if (
            following
            or existing_import.library_id != library_id
            or existing_import.feed_id != feed_id
        ):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Import id is taken")
        return result(feed_id)
    if db.scalar(
        text("""
        SELECT 1 FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
        WHERE i.library_id=:library AND r.feed_id=:feed
          AND r.completed_at IS NULL AND r.cancelled_at IS NULL
    """),
        {"library": library_id, "feed": feed_id},
    ):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Review or cancel the existing import"
        )
    if db.scalar(
        text("""SELECT 1 FROM library_feed_subscriptions
                                       WHERE library_id=:library AND feed_id=:feed"""),
        {"library": library_id, "feed": feed_id},
    ):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT
            if following
            else ApiErrorCode.E_FEED_SUBSCRIPTION_ACTIVE,
            "Feed is already subscribed here",
        )
    media = list(
        db.scalars(
            text("""
        SELECT DISTINCT pe.media_id FROM feed_entries pe
        WHERE pe.feed_id=:id AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id=pe.media_id)
        ORDER BY pe.media_id
    """),
            {"id": feed_id},
        )
    )
    library_entries.lock_media_for_references(db, media)
    libraries.lock_library_rows_in_order(db, [library_id])
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_add_content(viewer_id)
    users.require_removal_revision(db, viewer_id, expected_removal_revision)
    run_id = new_uuid7()
    db.execute(
        text("""
        INSERT INTO feed_runs(id,feed_id,purpose,pending_urls)
        SELECT :run,id,'import',ARRAY[feed_url] FROM feeds WHERE id=:feed
    """),
        {"run": run_id, "feed": feed_id},
    )
    created = db.scalar(
        text("""
        INSERT INTO library_feed_imports(id,library_id,run_id)
        VALUES (:id,:library,:run) ON CONFLICT (id) DO NOTHING RETURNING id
    """),
        {"id": operation_id, "library": library_id, "run": run_id},
    )
    if created is None:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Import id is taken")
    if following:
        created = db.scalar(
            text("""
            INSERT INTO library_feed_subscriptions(id,library_id,feed_id,initial_import_id)
            VALUES (:id,:library,:feed,:import) ON CONFLICT (id) DO NOTHING RETURNING id
        """),
            {"id": id, "library": library_id, "feed": feed_id, "import": operation_id},
        )
        if created is None:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Subscription id is taken")
        sync.ensure_scheduled(db, feed_id=feed_id)
    eligible = library_entries.deliverable_feed_media_ids(
        db, library_id=library_id, media_ids=media
    )
    if len(eligible) != len(media):
        db.execute(
            text(
                """UPDATE feed_runs SET had_coverage_gaps=true,error_code=:code,error_detail=:detail WHERE id=:id"""
            ),
            {
                "id": run_id,
                "code": ApiErrorCode.E_FEED_PRIVATE_SOURCE.value,
                "detail": "Some entries are unavailable to this library's members",
            },
        )
    added, present = library_entries.add_feed_media_locked(
        db,
        library_id=library_id,
        media_ids=eligible,
        origin="followed_source" if following else "history",
    )
    db.execute(
        text("""
        INSERT INTO feed_import_processed_media(import_id,media_id)
        SELECT :id,unnest(CAST(:media AS uuid[]))
    """),
        {"id": operation_id, "media": eligible},
    )
    db.execute(
        text("""UPDATE library_feed_imports SET added_count=:added,
                       already_present_count=:present WHERE id=:id"""),
        {"id": operation_id, "added": added, "present": present},
    )
    traversal.enqueue_step(db, run_id=run_id)
    projection.refresh_viewer_contributors(
        db,
        list(
            db.scalars(
                text("SELECT user_id FROM memberships WHERE library_id=:id"),
                {"id": library_id},
            )
        ),
    )
    record_input_change(
        db,
        owners=(
            f"{'podcast' if db.scalar(text('SELECT kind FROM feeds WHERE id=:id'), {'id': feed_id}) == 'podcast' else 'feed'}:{feed_id}",
        ),
    )
    return result(feed_id)


def removal_preview(
    db: Session,
    viewer_id: UUID,
    feed_id: UUID,
    *,
    scope: Literal["all", "library"],
    items: Literal["keep", "remove"],
    library_id: UUID | None,
) -> wire.FeedRemovalPreviewOut:
    """One statement snapshots the full selected scope, counts and all command guards."""
    require_feed_access(db, viewer_id, feed_id)
    if (scope == "library") != (library_id is not None):
        raise InvalidRequestError(message="Library scope requires a library id")
    if library_id is not None:
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_not_system()
        if library.is_default:
            library.require_owner(viewer_id)
    rows = db.execute(
        text("""
        WITH destinations AS (
            SELECT l.id AS library_id,l.name,l.is_default,l.order_revision,
                   (l.is_default AND l.owner_user_id=:viewer) OR m.role='admin' AS can_add_content,
                   (SELECT count(*)>1 FROM memberships all_m WHERE all_m.library_id=l.id) AS is_shared,
                   s.id AS subscription_id,i.id AS import_id,r.attempt_version AS import_attempt_version,
                   (SELECT count(DISTINCT le.media_id) FROM library_entries le JOIN feed_entries pe ON pe.media_id=le.media_id
                    WHERE le.library_id=l.id AND pe.feed_id=:feed) AS entry_count
            FROM libraries l JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer
            LEFT JOIN library_feed_subscriptions s ON s.library_id=l.id AND s.feed_id=:feed
            LEFT JOIN LATERAL (
                SELECT candidate.* FROM library_feed_imports candidate
                JOIN feed_runs run ON run.id=candidate.run_id
                WHERE candidate.library_id=l.id AND run.feed_id=:feed
                  AND run.completed_at IS NULL AND run.cancelled_at IS NULL
                  AND (:items='remove' OR candidate.id=s.initial_import_id)
            ) i ON true
            LEFT JOIN feed_runs r ON r.id=i.run_id
            WHERE l.system_key IS NULL AND (NOT l.is_default OR l.owner_user_id=:viewer)
        ), selected AS (
            SELECT * FROM destinations d
            WHERE (:scope='all' OR d.library_id=:library)
              AND (d.subscription_id IS NOT NULL OR
                   (:items='remove' AND (d.import_id IS NOT NULL OR d.entry_count>0)))
        ), protecting_sources AS (
            SELECT DISTINCT le.library_id,f.id,f.title
            FROM selected d JOIN library_entries le ON le.library_id=d.library_id
            JOIN feed_entries own ON own.media_id=le.media_id AND own.feed_id=:feed
            JOIN feed_entries other ON other.media_id=le.media_id AND other.feed_id<>own.feed_id
            JOIN library_feed_subscriptions active ON active.feed_id=other.feed_id
                AND active.library_id=le.library_id
            JOIN feeds f ON f.id=active.feed_id
            WHERE :items='remove'
        )
        SELECT u.removal_revision,p.id AS feed_exists,
               (SELECT count(DISTINCT le.media_id) FROM library_entries le
                JOIN feed_entries pe ON pe.media_id=le.media_id AND pe.feed_id=:feed
                WHERE le.library_id IN (SELECT library_id FROM selected)) AS distinct_count,
               selected.*,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('id',source.id,'title',source.title)
                   ORDER BY source.id) FROM protecting_sources source
                   WHERE source.library_id=selected.library_id),'[]'::jsonb) AS protecting_feeds
        FROM users u LEFT JOIN feeds p ON p.id=:feed LEFT JOIN selected ON true
        WHERE u.id=:viewer ORDER BY selected.library_id
    """),
        {
            "viewer": viewer_id,
            "feed": feed_id,
            "scope": scope,
            "items": items,
            "library": library_id,
        },
    ).all()
    if not rows or rows[0].feed_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
    destinations = [
        wire.FeedRemovalDestinationOut(
            library_id=row.library_id,
            name=row.name,
            is_default=row.is_default,
            is_shared=row.is_shared,
            subscription_id=row.subscription_id,
            import_id=row.import_id,
            import_attempt_version=row.import_attempt_version,
            order_revision=str(row.order_revision),
            entry_count=row.entry_count,
            can_add_content=row.can_add_content,
        )
        for row in rows
        if row.library_id is not None
    ]
    blocked = [
        wire.FeedRemovalBlockedOut(
            library_id=d.library_id, name=d.name, reason="requires_admin", feeds=[]
        )
        for d in destinations
        if not d.can_add_content
    ]
    blocked += [
        wire.FeedRemovalBlockedOut(
            library_id=row.library_id,
            name=row.name,
            reason="subscription_active",
            feeds=[
                wire.FeedRemovalSourceOut.model_validate(source) for source in row.protecting_feeds
            ],
        )
        for row in rows
        if row.protecting_feeds
    ]
    return wire.FeedRemovalPreviewOut(
        scope=scope,
        items=items,
        feed_id=feed_id,
        removal_revision=str(rows[0].removal_revision),
        entry_count=rows[0].distinct_count,
        destinations=destinations,
        can_execute=not blocked,
        blocked=blocked,
    )


def stop(
    db: Session, viewer_id: UUID, feed_id: UUID, body: wire.FeedStopRequest
) -> wire.FeedStopOut:
    """Apply a frozen complete scope, or refuse without partial effects."""

    def attempt() -> wire.FeedStopOut:
        users.lock_viewer(db, viewer_id)
        db.execute(
            text("""SELECT id FROM feeds WHERE id=:id OR id IN (
            SELECT other.feed_id FROM feed_entries own JOIN feed_entries other ON other.media_id=own.media_id
            WHERE own.feed_id=:id) ORDER BY id FOR UPDATE"""),
            {"id": feed_id},
        )
        if db.scalar(text("SELECT id FROM feeds WHERE id=:id"), {"id": feed_id}) is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
        db.execute(
            text("""SELECT id FROM feed_runs WHERE feed_id=:id OR feed_id IN (
                SELECT other.feed_id FROM feed_entries own JOIN feed_entries other ON other.media_id=own.media_id
                WHERE own.feed_id=:id) ORDER BY id FOR UPDATE"""),
            {"id": feed_id},
        )
        library_id = body.destinations[0].library_id if body.scope == "library" else None
        before = removal_preview(
            db,
            viewer_id,
            feed_id,
            scope=body.scope,
            items=body.items,
            library_id=library_id,
        )
        selected = [d.library_id for d in before.destinations]
        media = (
            list(
                db.scalars(
                    text("""
            SELECT DISTINCT le.media_id FROM library_entries le
            JOIN feed_entries pe ON pe.media_id=le.media_id
            WHERE pe.feed_id=:feed AND le.library_id=ANY(:libraries) ORDER BY le.media_id
        """),
                    {"feed": feed_id, "libraries": selected},
                )
            )
            if body.items == "remove"
            else []
        )
        media_locks.lock_media_rows_in_order(db, media)
        libraries.lock_library_rows_in_order(db, selected)
        current = removal_preview(
            db,
            viewer_id,
            feed_id,
            scope=body.scope,
            items=body.items,
            library_id=library_id,
        )
        users.require_removal_revision(db, viewer_id, int(body.expected_removal_revision))
        expected = {d.library_id: d for d in body.destinations}
        if set(expected) != {d.library_id for d in current.destinations}:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Feed destinations changed")
        for destination in current.destinations:
            guard = expected[destination.library_id]
            if (
                destination.subscription_id != guard.expected_subscription_id
                or destination.import_id != guard.expected_import_id
                or destination.import_attempt_version != guard.expected_import_attempt_version
                or (
                    body.items == "remove"
                    and destination.order_revision != guard.expected_order_revision
                )
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed")
            libraries.access(db, viewer_id, destination.library_id, lock=False).require_add_content(
                viewer_id
            )
        if any(item.reason == "subscription_active" for item in current.blocked):
            raise ConflictError(
                ApiErrorCode.E_FEED_SUBSCRIPTION_ACTIVE,
                "Another followed source requires these items",
            )
        for destination in current.destinations:
            if destination.subscription_id is not None:
                db.execute(
                    text("DELETE FROM library_feed_subscriptions WHERE id=:id"),
                    {"id": destination.subscription_id},
                )
        for destination in current.destinations:
            if destination.import_id is not None:
                run_id = db.execute(
                    text("SELECT run_id FROM library_feed_imports WHERE id=:id"),
                    {"id": destination.import_id},
                ).scalar_one()
                imports.cancel_in_current_transaction(db, run_id=run_id)
        if body.items == "remove":
            for media_id in media:
                imports.mark_processed(db, library_ids=selected, media_id=media_id)
            library_entries.remove_feed_media_locked(
                db,
                library_ids=selected,
                media_ids=media,
            )
        for destination in current.destinations:
            libraries.advance_order_revision(db, destination.library_id)
        sync.stop_if_unused(db, feed_id=feed_id)
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
        record_input_change(
            db,
            owners=(
                f"{'podcast' if db.scalar(text('SELECT kind FROM feeds WHERE id=:id'), {'id': feed_id}) == 'podcast' else 'feed'}:{feed_id}",
            ),
        )
        return wire.FeedStopOut(
            feed_id=feed_id,
            removal_revision=str(removal),
            destinations=[
                wire.FeedStoppedDestinationOut(
                    library_id=d.library_id,
                    order_revision=str(
                        libraries.access(db, viewer_id, d.library_id, lock=False).order_revision
                    ),
                )
                for d in current.destinations
            ],
        )

    return retry_serializable(db, "stop_feed", attempt)
