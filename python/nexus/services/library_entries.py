"""physical library media membership and its sole writer.

named and all membership are physical media relations. active podcast rules have
separate roots; they never expand or replace entries. callers lock show, complete
media set and complete library set in that order. bulk helpers ending in locked
never acquire earlier locks. explicit acquisition clears actor markers; automatic
retention/delivery respects them. strict placement retries compare frozen guards
before desired-state equality and advance accepted no-op revisions.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    can_restore_media,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.acquisition import DestinationGuard
from nexus.schemas.library import LibraryOrderOut, LibraryPlacementOut, LibraryPlacementsOut
from nexus.services import libraries, resource_grants, users
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change

# Mirrors ix_library_entries_library_order: the one entry order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"


@dataclass(frozen=True)
class EntryTarget:
    """A physical media placement target."""

    id: UUID


def media_target(media_id: UUID) -> EntryTarget:
    return EntryTarget(media_id)


# Relations composed inline by atlas, search scope and suggestions.


def _library_entry_media_rows_sql(*, library_param: str = ":library_id") -> str:
    return f"""
        SELECT le.media_id,le.position,0 AS lane,NULL::timestamptz AS published_at,
               le.created_at AS added_at,le.id AS source_entry_id
        FROM library_entries le WHERE le.library_id = {library_param}
    """


def library_media_rows_sql(
    *, library_param: str = ":library_id", visible_media_sql: str | None = None
) -> str:
    """Canonical readable media and ordering facts for a named library or own all.

    all contains physical non-system memberships only; a default holding supplies
    its date first, otherwise the earliest qualifying entry does. named membership
    has the same physical media boundary and grants no additional access.
    """
    visible = visible_media_sql if visible_media_sql is not None else visible_media_ids_cte_sql()
    return f"""
        WITH named AS (
            SELECT DISTINCT ON (expanded.media_id) expanded.media_id, expanded.position,
                   expanded.lane, expanded.published_at, expanded.added_at
            FROM ({_library_entry_media_rows_sql(library_param=library_param)}) expanded
            JOIN libraries l ON l.id = {library_param} AND NOT l.is_default
            JOIN memberships membership
              ON membership.library_id = l.id AND membership.user_id = :viewer_id
            WHERE expanded.media_id IN ({visible})
            ORDER BY expanded.media_id, expanded.position, expanded.lane,
                     expanded.published_at DESC NULLS LAST, expanded.source_entry_id
        )
        SELECT * FROM named
        UNION ALL
        SELECT ranked.media_id, NULL::integer, 0, NULL::timestamptz, ranked.created_at
        FROM (
            SELECT DISTINCT ON (le.media_id) le.media_id, le.created_at
            FROM library_entries le
            JOIN libraries source ON source.id = le.library_id AND source.system_key IS NULL
            JOIN memberships membership
              ON membership.library_id = source.id AND membership.user_id = :viewer_id
            WHERE le.media_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM libraries destination
                  WHERE destination.id = {library_param} AND destination.is_default
                    AND destination.system_key IS NULL AND destination.owner_user_id = :viewer_id)
              AND le.media_id IN ({visible})
            ORDER BY le.media_id, (le.library_id = {library_param}) DESC,
                     le.created_at, le.id
        ) ranked
    """


def library_media_ids_cte_sql(*, library_param: str = ":library_id") -> str:
    """The narrow media-id projection of canonical membership."""
    return f"SELECT DISTINCT media_id FROM ({library_media_rows_sql(library_param=library_param)}) members"


def library_podcast_rows_sql(*, library_param: str = ":library_id") -> str:
    """Active library rules; own all aggregates current non-system memberships."""
    return f"""
        SELECT s.podcast_id,min(s.created_at) AS added_at
        FROM library_podcast_subscriptions s
        JOIN libraries source ON source.id = s.library_id AND source.system_key IS NULL
        JOIN memberships m ON m.library_id = source.id AND m.user_id = :viewer_id
        JOIN libraries destination ON destination.id = {library_param}
        WHERE (NOT destination.is_default AND s.library_id = destination.id)
           OR (destination.is_default AND destination.owner_user_id = :viewer_id
               AND destination.system_key IS NULL)
        GROUP BY s.podcast_id
    """


def unfiled_media_ids_sql() -> str:
    """Default-held media without a physical named placement in current membership."""
    return f"""
        SELECT member.media_id FROM ({library_media_ids_cte_sql()}) member
        WHERE EXISTS (SELECT 1 FROM library_entries held
            WHERE held.library_id = :library_id AND held.media_id = member.media_id)
          AND NOT EXISTS (
            SELECT 1 FROM library_entries placement
            JOIN libraries named ON named.id = placement.library_id
              AND NOT named.is_default AND named.system_key IS NULL
            JOIN memberships membership
              ON membership.library_id = named.id AND membership.user_id = :viewer_id
            WHERE placement.media_id = member.media_id)
    """


def destination_membership_rows_sql() -> str:
    """Physical media inputs and active show roots of one authorized destination."""
    return f"""
        SELECT 'media' AS target_scheme,member.media_id AS target_id,
               member.media_id,NULL::uuid AS podcast_id,member.added_at
        FROM ({library_media_rows_sql()}) member
        UNION ALL
        SELECT 'podcast',show.podcast_id,NULL::uuid,show.podcast_id,show.added_at
        FROM ({library_podcast_rows_sql()}) show
        JOIN libraries l ON l.id = :library_id AND NOT l.is_default
    """


def engagement_anchor_library_ids(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> tuple[UUID, ...]:
    """Editable destinations whose ordered anchors can change with this media's engagement.

    Named libraries hold physical media. All holds physical media reached
    through any non-system membership; it never has podcast anchors. Registration
    is irrelevant: a destination's first suggestions request may overlap this write.
    """
    return tuple(
        db.scalars(
            text("""
                SELECT l.id
                FROM libraries l
                JOIN memberships membership ON membership.library_id = l.id
                WHERE membership.user_id = :viewer_id AND membership.role = 'admin'
                  AND l.system_key IS NULL
                  AND (
                    (NOT l.is_default AND EXISTS (
                        SELECT 1 FROM library_entries le
                        WHERE le.library_id = l.id AND (
                            le.media_id = :media_id
                        )
                    )) OR (l.is_default AND l.owner_user_id = :viewer_id AND EXISTS (
                        SELECT 1 FROM library_entries le
                        JOIN memberships source_member ON source_member.library_id = le.library_id
                        JOIN libraries source_library ON source_library.id = le.library_id
                        WHERE le.media_id = :media_id AND source_member.user_id = :viewer_id
                          AND source_library.system_key IS NULL
                    ))
                  )
                ORDER BY l.id
            """),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
    )


def library_anchor_facts(
    db: Session, *, viewer_id: UUID, library_id: UUID, limit: int
) -> tuple[ResourceRef, ...]:
    """The newest-engaged readable items a destination holds."""
    if limit <= 0:
        return ()
    from nexus.services.consumption import projection
    from nexus.services.podcasts.episodes import episode_publication_rows_sql

    rows = db.execute(
        text(f"""
            WITH destination AS ({destination_membership_rows_sql()}),
            engagement AS ({projection.engagement_fact_rows_sql()}),
            episodes AS ({episode_publication_rows_sql()}),
            visible_media AS ({visible_media_ids_cte_sql()}),
            visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
            canonical AS (
                SELECT target_scheme, target_id, added_at AS created_at FROM destination
            ),
            podcast_engagement AS (
                SELECT e.podcast_id,
                       MAX(g.last_engaged_at) FILTER (WHERE g.last_engaged_at <= now())
                           AS last_engaged_at
                FROM episodes e
                JOIN visible_media vm ON vm.media_id = e.media_id
                JOIN engagement g ON g.media_id = e.media_id
                GROUP BY e.podcast_id
            )
            SELECT c.target_scheme, c.target_id,
                   CASE WHEN c.target_scheme = 'media'
                        THEN CASE WHEN me.last_engaged_at <= now() THEN me.last_engaged_at END
                        ELSE pe.last_engaged_at
                   END AS last_engaged_at
            FROM canonical c
            LEFT JOIN engagement me ON c.target_scheme = 'media' AND me.media_id = c.target_id
            LEFT JOIN podcast_engagement pe
              ON c.target_scheme = 'podcast' AND pe.podcast_id = c.target_id
            WHERE (c.target_scheme = 'media'
                   AND c.target_id IN (SELECT media_id FROM visible_media))
               OR (c.target_scheme = 'podcast'
                   AND c.target_id IN (SELECT podcast_id FROM visible_podcasts))
            ORDER BY last_engaged_at DESC NULLS LAST, c.created_at DESC,
                     c.target_scheme ASC, c.target_id ASC
            LIMIT :anchor_limit
        """),
        {"viewer_id": viewer_id, "library_id": library_id, "anchor_limit": limit},
    ).all()
    return tuple(
        ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
        for row in rows
    )


# Locks and primitives.


def lock_media_rows_in_order(db: Session, media_ids: Sequence[UUID]) -> list[UUID]:
    """Lock the existing media rows in uuid order; return those that exist."""
    ordered = sorted(set(media_ids))
    if not ordered:
        return []
    return list(
        db.scalars(
            text("SELECT id FROM media WHERE id = ANY(:ids) ORDER BY id FOR UPDATE"),
            {"ids": ordered},
        )
    )


def lock_media_for_reference(db: Session, media_id: UUID) -> None:
    """The reference barrier: lock the media row (gone: 404), then refuse a pending
    teardown. The teardown claim locks the same row and checks for zero references,
    so a new reference and a teardown never both commit."""
    if not lock_media_rows_in_order(db, [media_id]):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if db.scalar(
        text("SELECT 1 FROM media_teardown_intents WHERE media_id = :id"), {"id": media_id}
    ):
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")
    # A serializable collector may have taken its snapshot before waiting on
    # this lock. Write the tuple without changing metadata so that collector
    # must restart and see the new reference, rather than claim from stale facts.
    db.execute(text("UPDATE media SET updated_at = updated_at WHERE id = :id"), {"id": media_id})


def lock_parent_podcast(db: Session, media_id: UUID) -> UUID | None:
    """Lock an episode's show (the first lock of the order); None for other media."""
    return db.scalar(
        text("""
            SELECT p.id FROM podcast_episodes pe JOIN podcasts p ON p.id = pe.podcast_id
            WHERE pe.media_id = :media_id FOR UPDATE OF p
        """),
        {"media_id": media_id},
    )


def entry_id(db: Session, library_id: UUID, target: EntryTarget) -> UUID | None:
    return db.scalar(
        text("SELECT id FROM library_entries WHERE library_id = :lib AND media_id = :tid"),
        {"lib": library_id, "tid": target.id},
    )


def entry_exists(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    return entry_id(db, library_id, target) is not None


def ensure_entry(
    db: Session, library_id: UUID, target: EntryTarget, *, position: int | None = None
) -> bool:
    """Acquire the reference barrier and library lock, then file if absent."""
    lock_media_for_reference(db, target.id)
    if not libraries.lock_library_rows_in_order(db, [library_id]):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return _ensure_entry_locked(db, library_id, target.id, position=position)


def _ensure_entry_locked(
    db: Session, library_id: UUID, media_id: UUID, *, position: int | None = None
) -> bool:
    """Sole inserter; caller already holds its complete media/library lock set."""
    inserted = db.scalar(
        text("""
        INSERT INTO library_entries(library_id,media_id,position)
        VALUES (:library,:media,COALESCE(CAST(:position AS integer),
            (SELECT COALESCE(max(position),-1)+1 FROM library_entries WHERE library_id=:library)))
        ON CONFLICT (library_id,media_id) DO NOTHING RETURNING id
    """),
        {"library": library_id, "media": media_id, "position": position},
    )
    if inserted is None:
        return False
    libraries.advance_order_revision(db, library_id)
    resource_grants.invalidate_annotation_visibility(
        db, resource_grants.library_annotation_visibility(db, library_id, media_ids={media_id})
    )
    return True


def deliver_podcast_episode_locked(
    db: Session, *, library_id: UUID, media_id: UUID
) -> Literal["added", "present", "suppressed"]:
    """Background delivery never clears suppression or creates an initiator holding."""
    suppressed = db.scalar(
        text("""
        SELECT 1 WHERE EXISTS (SELECT 1 FROM media_teardown_intents WHERE media_id=:media)
        OR EXISTS (SELECT 1 FROM libraries l JOIN user_media_deletions d
                   ON d.user_id=l.owner_user_id AND d.media_id=:media
                   WHERE l.id=:library AND l.is_default)
    """),
        {"media": media_id, "library": library_id},
    )
    if suppressed:
        return "suppressed"
    return "added" if _ensure_entry_locked(db, library_id, media_id) else "present"


def acquire_podcast_episodes_locked(
    db: Session, *, viewer_id: UUID, library_id: UUID, media_ids: Sequence[UUID]
) -> tuple[int, int]:
    """Explicit acquisition retains the actor, files physically and clears markers.

    caller locks the actor, show, complete media set/reference barriers and both
    libraries, and validates destination/removal revisions before calling.
    """
    from nexus.services.media_deletion import clear_user_media_deletion

    default_id = libraries.default_library_id(db, viewer_id)
    added = present = 0
    for media_id in media_ids:
        existing = entry_exists(db, library_id, media_target(media_id))
        _ensure_entry_locked(db, default_id, media_id)
        if library_id != default_id:
            _ensure_entry_locked(db, library_id, media_id)
        clear_user_media_deletion(db, viewer_id, media_id)
        added += not existing
        present += existing
    return added, present


def remove_podcast_episodes_locked(
    db: Session,
    *,
    viewer_id: UUID,
    library_ids: Sequence[UUID],
    media_ids: Sequence[UUID],
    preserve_personal: bool,
) -> None:
    """Remove this scoped placement set; all/remove never recreates default holdings."""
    for library_id in library_ids:
        for media_id in media_ids:
            if not entry_exists(db, library_id, media_target(media_id)):
                continue
            if preserve_personal:
                # The caller already owns the default library and all media rows.
                default_id = libraries.default_library_id(db, viewer_id)
                deliver_podcast_episode_locked(db, library_id=default_id, media_id=media_id)
            delete_entry(db, library_id, media_target(media_id))


def delete_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    projections = resource_grants.library_annotation_visibility(
        db, library_id, media_ids={target.id}
    )
    deleted = db.scalar(
        text(
            "DELETE FROM library_entries WHERE library_id = :lib AND media_id = :tid RETURNING id"
        ),
        {"lib": library_id, "tid": target.id},
    )
    if deleted is not None:
        libraries.advance_order_revision(db, library_id)
        resource_grants.invalidate_annotation_visibility(db, projections)
    return deleted is not None


def delete_all_entries_for_media(db: Session, media_id: UUID) -> list[UUID]:
    """Delete every entry of a media; return the libraries it left."""
    previous = list(
        db.scalars(
            text("SELECT library_id FROM library_entries WHERE media_id=:id"), {"id": media_id}
        )
    )
    projections = {
        pair
        for library_id in previous
        for pair in resource_grants.library_annotation_visibility(
            db, library_id, media_ids={media_id}
        )
    }
    library_ids = list(
        db.scalars(
            text("DELETE FROM library_entries WHERE media_id = :id RETURNING library_id"),
            {"id": media_id},
        )
    )
    for library_id in sorted(library_ids):
        libraries.advance_order_revision(db, library_id)
    resource_grants.invalidate_annotation_visibility(db, projections)
    return library_ids


def delete_library_entries(db: Session, library_id: UUID) -> None:
    projections = resource_grants.library_annotation_visibility(db, library_id)
    db.execute(text("DELETE FROM library_entries WHERE library_id = :id"), {"id": library_id})
    resource_grants.invalidate_annotation_visibility(db, projections)


def transfer_current_media_references(
    db: Session, *, loser_media_id: UUID, winner_media_id: UUID
) -> None:
    """Transfer current physical holdings under media/library locks, without a viewer lock.

    winner suppression survives. loser suppression follows unless independent
    winner access existed before transfer. no suppressed default holding is created.
    loser-only entries retain identity, position and time; duplicates retain the
    winner position and earliest time. admission payloads never participate.
    """
    lock_media_rows_in_order(db, [loser_media_id, winner_media_id])
    lock_media_for_reference(db, winner_media_id)
    library_ids = sorted(
        {*library_ids_for_media(db, loser_media_id), *library_ids_for_media(db, winner_media_id)}
    )
    libraries.lock_library_rows_in_order(db, library_ids)
    projections = {
        pair
        for library_id in library_ids
        for pair in resource_grants.library_annotation_visibility(
            db, library_id, media_ids={loser_media_id, winner_media_id}
        )
    }
    suppressed = db.scalars(
        text("SELECT user_id FROM user_media_deletions WHERE media_id = :m ORDER BY user_id"),
        {"m": loser_media_id},
    ).all()
    for viewer_id in suppressed:
        if not can_read_media(db, viewer_id, winner_media_id):
            db.execute(
                text(
                    "INSERT INTO user_media_deletions(user_id,media_id) VALUES(:u,:m) "
                    "ON CONFLICT DO NOTHING"
                ),
                {"u": viewer_id, "m": winner_media_id},
            )
    entries = db.execute(
        text("""
        SELECT le.id, le.library_id, le.created_at, l.is_default, l.owner_user_id
        FROM library_entries le JOIN libraries l ON l.id = le.library_id
        WHERE le.media_id = :m ORDER BY le.library_id
    """),
        {"m": loser_media_id},
    ).all()
    for entry in entries:
        hidden = entry.is_default and db.scalar(
            text("SELECT 1 FROM user_media_deletions WHERE user_id = :u AND media_id = :m"),
            {"u": entry.owner_user_id, "m": winner_media_id},
        )
        winner = db.execute(
            text("SELECT id FROM library_entries WHERE library_id = :l AND media_id = :m"),
            {"l": entry.library_id, "m": winner_media_id},
        ).one_or_none()
        if hidden or winner is not None:
            if winner is not None:
                db.execute(
                    text(
                        "UPDATE library_entries SET created_at = least(created_at,:at) "
                        "WHERE id = :id"
                    ),
                    {"id": winner.id, "at": entry.created_at},
                )
            db.execute(text("DELETE FROM library_entries WHERE id = :id"), {"id": entry.id})
        else:
            db.execute(
                text("UPDATE library_entries SET media_id = :m WHERE id = :id"),
                {"m": winner_media_id, "id": entry.id},
            )
        libraries.advance_order_revision(db, entry.library_id)

    for library_id in library_ids:
        projections.update(
            resource_grants.library_annotation_visibility(
                db, library_id, media_ids={loser_media_id, winner_media_id}
            )
        )
    db.execute(
        text("""
        INSERT INTO podcast_import_processed_episodes(import_id,media_id,created_at)
        SELECT import_id,:winner,created_at FROM podcast_import_processed_episodes
        WHERE media_id=:loser ON CONFLICT (import_id,media_id) DO NOTHING
    """),
        {"winner": winner_media_id, "loser": loser_media_id},
    )
    db.execute(
        text("DELETE FROM podcast_import_processed_episodes WHERE media_id=:loser"),
        {"loser": loser_media_id},
    )
    resource_grants.invalidate_annotation_visibility(db, projections)


# Readers.


def media_ids_in_library(db: Session, library_id: UUID) -> list[UUID]:
    """Every media a library files, by id (the lock order)."""
    return list(
        db.scalars(
            text("""
                SELECT media_id FROM library_entries
                WHERE library_id = :id AND media_id IS NOT NULL ORDER BY media_id
            """),
            {"id": library_id},
        )
    )


def library_ids_for_media(db: Session, media_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            text("SELECT library_id FROM library_entries WHERE media_id = :id ORDER BY library_id"),
            {"id": media_id},
        )
    )


def count_entries_by_library(db: Session, library_ids: Sequence[UUID]) -> dict[UUID, int]:
    """Entry counts by library; a library with no entries is absent."""
    if not library_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT library_id, COUNT(*) FROM library_entries
            WHERE library_id = ANY(:ids) GROUP BY library_id
        """),
        {"ids": list(library_ids)},
    ).all()
    return {row[0]: row[1] for row in rows}


def admin_non_default_library_ids_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[UUID]:
    """Named libraries the viewer admins that hold the media, oldest first."""
    return list(
        db.scalars(
            text("""
                SELECT l.id FROM library_entries le
                JOIN libraries l ON l.id = le.library_id
                JOIN memberships m
                  ON m.library_id = l.id AND m.user_id = :viewer_id AND m.role = 'admin'
                WHERE le.media_id = :media_id AND l.is_default = false
                  AND l.system_key IS NULL
                ORDER BY l.created_at, l.id
            """),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
    )


def podcast_ids_in_libraries_for_viewer(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> set[UUID]:
    if library_id is not None:
        libraries.access(db, viewer_id, library_id, lock=False)
        return set(
            db.scalars(
                text(f"SELECT podcast_id FROM ({library_podcast_rows_sql()}) shows"),
                {"viewer_id": viewer_id, "library_id": library_id},
            )
        )
    return set(
        db.scalars(
            text("""
        SELECT DISTINCT s.podcast_id FROM library_podcast_subscriptions s
        JOIN libraries l ON l.id=s.library_id AND NOT l.is_default AND l.system_key IS NULL
        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
    """),
            {"viewer_id": viewer_id},
        )
    )


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> LibraryPlacementsOut:
    """Named physical placements and both guards from one statement snapshot."""
    rows = db.execute(
        text(f"""
        SELECT u.removal_revision,placement.* FROM users u
        LEFT JOIN LATERAL (
            SELECT l.id,l.name,l.system_key,l.order_revision,m.role,
                   EXISTS (SELECT 1 FROM library_entries le
                           WHERE le.library_id=l.id AND le.media_id=:target_id) AS direct
            FROM libraries l JOIN memberships m ON m.library_id=l.id AND m.user_id=u.id
            WHERE NOT l.is_default
        ) placement ON true
        WHERE u.id=:viewer_id AND :target_id IN ({visible_media_ids_cte_sql()})
        ORDER BY lower(placement.name),placement.name,placement.id
    """),
        {"viewer_id": viewer_id, "target_id": target.id},
    ).all()
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return LibraryPlacementsOut(
        removal_revision=str(rows[0].removal_revision),
        placements=[
            LibraryPlacementOut(
                library_id=row.id,
                name=row.name,
                order_revision=str(row.order_revision),
                relation="Direct" if row.direct else "Absent",
                blocked="SystemManaged"
                if row.system_key is not None
                else "RequiresAdmin"
                if row.role != "admin"
                else None,
            )
            for row in rows
            if row.id is not None
        ],
    )


def validate_acquisition_destinations(
    db: Session,
    *,
    viewer_id: UUID,
    expected_removal_revision: int,
    destinations: Sequence[DestinationGuard],
) -> list[UUID]:
    """Fence an atomic acquisition after its viewer, identity, podcast and media locks.

    locks the complete default and named library set; effects belong to the caller.
    """
    ids = [guard.library_id for guard in destinations]
    if len(set(ids)) != len(ids):
        raise InvalidRequestError(message="Duplicate library ids")
    libraries.lock_library_rows_in_order(db, [libraries.default_library_id(db, viewer_id), *ids])
    held = {}
    for library_id in ids:
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_mutable()
        library.require_admin()
        held[library_id] = library.order_revision
    users.require_removal_revision(db, viewer_id, expected_removal_revision)
    for guard in destinations:
        if held[guard.library_id] != int(guard.expected_order_revision):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed")
    return ids


def finish_acquisition_destinations(
    db: Session, *, destinations: Sequence[DestinationGuard]
) -> None:
    """Every accepted named intent advances, including already-present no-ops."""
    for guard in destinations:
        current = db.execute(
            text("SELECT order_revision FROM libraries WHERE id = :id"), {"id": guard.library_id}
        ).scalar_one()
        if current == int(guard.expected_order_revision):
            libraries.advance_order_revision(db, guard.library_id)


# Media filing and removal.


def _file_media(db: Session, viewer_id: UUID, media_id: UUID, library_ids: Sequence[UUID]) -> bool:
    """Explicit filing retains the actor's default holding and clears suppression.

    the caller owns the viewer lock; parent, media and complete library locks precede effects.
    """
    from nexus.services.media_deletion import clear_user_media_deletion

    lock_parent_podcast(db, media_id)
    lock_media_rows_in_order(db, [media_id])
    if not (
        can_restore_media(db, viewer_id, media_id)
        or can_read_media(db, viewer_id, media_id, include_tearing_down=True)
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    lock_media_for_reference(db, media_id)
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, *library_ids])
    for library_id in library_ids:
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_admin()
        library.require_mutable()
    _ensure_entry_locked(db, default_id, media_id)
    inserted = False
    for library_id in library_ids:
        inserted = _ensure_entry_locked(db, library_id, media_id) or inserted
    clear_user_media_deletion(db, viewer_id, media_id)
    return inserted


def assign_libraries_for_media_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """Retain newly ingested media and file each named physical destination."""
    from nexus.services.media_deletion import clear_user_media_deletion

    targets = libraries.resolve_writable_destinations(db, viewer_id, library_ids)
    lock_parent_podcast(db, media_id)
    lock_media_for_reference(db, media_id)
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, *targets])
    libraries.resolve_writable_destinations(db, viewer_id, targets)
    _ensure_entry_locked(db, default_id, media_id)
    for library_id in targets:
        _ensure_entry_locked(db, library_id, media_id)
    clear_user_media_deletion(db, viewer_id, media_id)


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> bool:
    """Automatically acquire into All unless the viewer explicitly removed this media."""
    # Removal locks this same row before changing placements and its marker.
    lock_media_rows_in_order(db, [media_id])
    if db.scalar(
        text(
            "SELECT 1 FROM user_media_deletions WHERE user_id = :u AND media_id = :m "
            "UNION ALL SELECT 1 FROM media_teardown_intents WHERE media_id = :m"
        ),
        {"u": user_id, "m": media_id},
    ):
        return False
    return ensure_entry(db, libraries.default_library_id(db, user_id), media_target(media_id))


def seed_media_into_system_library(db: Session, library_id: UUID, media_id: UUID) -> bool:
    """Trusted corpus seeding; no actor."""
    system = db.scalar(
        text("SELECT 1 FROM libraries WHERE id = :id AND system_key IS NOT NULL"),
        {"id": library_id},
    )
    if system is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "System library not found")
    return ensure_entry(db, library_id, media_target(media_id))


def remove_media_from_library_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID
) -> None:
    """Unfile an actual named entry while preserving the actor's eligible holding.

    absence acquires nothing; incidental retention never clears removal markers.
    caller owns the viewer lock and the complete ordered lock set.
    """
    lock_media_rows_in_order(db, [media_id])
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, library_id])
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_admin()
    library.require_mutable()
    if not entry_exists(db, library_id, media_target(media_id)):
        return
    ensure_media_in_default_library(db, viewer_id, media_id)
    delete_entry(db, library_id, media_target(media_id))


# The placement routes: one item in one library.


def parse_entry_target(ref: str) -> EntryTarget:
    parsed = parse_resource_ref(ref)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != "media":
        raise InvalidRequestError(message="Expected media:<id>")
    return media_target(parsed.id)


def _lock_placement_target(
    db: Session, *, viewer_id: UUID, library_id: UUID, target: EntryTarget
) -> None:
    libraries.access(db, viewer_id, library_id, lock=False)
    lock_parent_podcast(db, target.id)
    lock_media_rows_in_order(db, [target.id])
    libraries.lock_library_rows_in_order(
        db, [libraries.default_library_id(db, viewer_id), library_id]
    )


def set_item_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    target: EntryTarget,
    *,
    included: bool,
    expected_order_revision: int,
    expected_removal_revision: int | None,
) -> tuple[LibraryPlacementOut, UUID | None]:
    """One strict named intent; return its authoritative placement and new entry ownership.

    stale guards refuse before desired-state equality. every accepted intent advances
    the named revision; no-op retention creates no assistant undo ownership.
    """
    users.lock_viewer(db, viewer_id)
    _lock_placement_target(db, viewer_id=viewer_id, library_id=library_id, target=target)
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_mutable()
    library.require_admin()
    if not (
        can_read_media(db, viewer_id, target.id, include_tearing_down=True)
        or (included and can_restore_media(db, viewer_id, target.id))
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if library.order_revision != expected_order_revision:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed")
    if included:
        if expected_removal_revision is None:
            raise InvalidRequestError(message="Inclusion requires a removal revision")
        users.require_removal_revision(db, viewer_id, expected_removal_revision)
    elif expected_removal_revision is not None:
        raise InvalidRequestError(message="Exclusion requires a null removal revision")
    before = entry_id(db, library_id, target)
    if included:
        _file_media(db, viewer_id, target.id, [library_id])
    else:
        from nexus.services.podcasts import imports

        imports.mark_processed(db, library_ids=[library_id], media_id=target.id)
        remove_media_from_library_in_current_transaction(db, viewer_id, target.id, library_id)
    current = libraries.access(db, viewer_id, library_id, lock=False)
    if current.order_revision == expected_order_revision:
        libraries.advance_order_revision(db, library_id)
    snapshot = list_item_libraries(db, viewer_id=viewer_id, target=target)
    placement = next(p for p in snapshot.placements if p.library_id == library_id)
    inserted_id = entry_id(db, library_id, target) if included and before is None else None
    return placement, inserted_id


def set_item(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    target: EntryTarget,
    *,
    included: bool,
    expected_order_revision: int,
    expected_removal_revision: int | None,
) -> LibraryPlacementOut:
    """Strict replay keeps the original guards and can conflict after landing."""

    def attempt() -> LibraryPlacementOut:
        placement, _ = set_item_in_current_transaction(
            db,
            viewer_id,
            library_id,
            target,
            included=included,
            expected_order_revision=expected_order_revision,
            expected_removal_revision=expected_removal_revision,
        )
        record_input_change(db, owners=(f"library:{library_id}", f"media:{target.id}"))
        projection.refresh_viewer_contributors(
            db,
            list(
                db.scalars(
                    text("SELECT user_id FROM memberships WHERE library_id=:id"),
                    {"id": library_id},
                )
            ),
        )
        return placement

    return retry_serializable(db, "set_library_item", attempt)


def library_entry_undo_eligible(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    target: EntryTarget,
    entry_id: UUID,
    order_revision: int | None,
) -> bool:
    """The same exact receipt predicate for assistant history and execution."""
    if order_revision is None:
        return False
    return bool(
        db.scalar(
            text("""
        SELECT 1 FROM libraries l
        JOIN memberships membership ON membership.library_id = l.id
          AND membership.user_id = :u AND membership.role = 'admin'
        JOIN library_entries le ON le.library_id = l.id
        WHERE l.id = :l AND NOT l.is_default AND l.system_key IS NULL
          AND l.order_revision = :revision AND le.id = :entry
          AND le.media_id = :target
    """),
            {
                "u": viewer_id,
                "l": library_id,
                "revision": order_revision,
                "entry": entry_id,
                "target": target.id,
            },
        )
    )


def undo_library_entry_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    target: EntryTarget,
    entry_id: UUID,
    order_revision: int | None,
) -> None:
    """Undo only a proved unchanged named insertion; default retention survives."""
    users.lock_viewer(db, viewer_id)
    try:
        _lock_placement_target(db, viewer_id=viewer_id, library_id=library_id, target=target)
    except NotFoundError as exc:
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed; filing cannot be undone"
        ) from exc
    if not library_entry_undo_eligible(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        target=target,
        entry_id=entry_id,
        order_revision=order_revision,
    ):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Library changed; filing cannot be undone"
        )
    from nexus.services.podcasts import imports

    imports.mark_processed(db, library_ids=[library_id], media_id=target.id)
    remove_media_from_library_in_current_transaction(db, viewer_id, target.id, library_id)


def move_entry(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    moved_id: UUID,
    before_id: UUID | None,
    expected_order_revision: int,
) -> LibraryOrderOut:
    """Move an existing visible entry at the captured revision; preserve all stored rows."""
    from nexus.services.library_listing import get_library_order

    with transaction(db):
        library = libraries.access(db, viewer_id, library_id, lock=True)
        library.require_admin()
        library.require_mutable()
        if moved_id == before_id:
            raise InvalidRequestError(message="An entry cannot be moved before itself")
        if library.order_revision != expected_order_revision:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library order changed")
        visible_ids = get_library_order(db, viewer_id, library_id).entry_ids
        if moved_id not in visible_ids or (before_id is not None and before_id not in visible_ids):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "A visible entry is gone")
        ids = list(
            db.scalars(
                text(
                    f"SELECT id FROM library_entries WHERE library_id = :id ORDER BY {_ENTRY_ORDER}"
                ),
                {"id": library_id},
            )
        )
        ids.remove(moved_id)
        ids.insert(len(ids) if before_id is None else ids.index(before_id), moved_id)
        db.execute(
            text("""
                UPDATE library_entries le SET position = o.ord - 1
                FROM unnest(CAST(:ids AS uuid[])) WITH ORDINALITY AS o(id, ord)
                WHERE le.id = o.id AND le.position <> o.ord - 1
            """),
            {"ids": ids},
        )
        libraries.advance_order_revision(db, library_id)
        result = get_library_order(db, viewer_id, library_id)
    return result


def catalog_entry_rows_sql() -> str:
    """Complete non-system member-library edges; visibility is materialized once.

    All's nullable entry id/date and named physical positions retain the listing's
    canonical membership semantics. The caller ranks these edges per library.
    """
    return f"""
        WITH catalog_visible AS MATERIALIZED ({visible_media_ids_cte_sql()})
        SELECT catalog_library.id AS library_id, catalog_library.is_default, members.media_id,
               CASE WHEN catalog_library.is_default THEN NULL::uuid ELSE physical.id END AS entry_id,
               members.position, members.added_at
        FROM libraries catalog_library
        JOIN memberships membership ON membership.library_id=catalog_library.id AND membership.user_id=:viewer_id
        CROSS JOIN LATERAL (
            {library_media_rows_sql(library_param="catalog_library.id", visible_media_sql="SELECT media_id FROM catalog_visible")}
        ) members
        LEFT JOIN library_entries physical
          ON NOT catalog_library.is_default AND physical.library_id=catalog_library.id AND physical.media_id=members.media_id
        WHERE catalog_library.system_key IS NULL
    """
