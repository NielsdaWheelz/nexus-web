"""Library entries: the `library_entries` table, its sole writer.

An entry files one media or one show in one library at a position. Positions only
order a library: gaps are fine, `move_entry` rewrites them densely. Every writer
takes locks in one order: podcast, then media (uuid asc), then library (uuid asc);
`ensure_entry` takes its own media and library locks and answers 404 for a row
deleted meanwhile, so every caller is safe.
Readers elsewhere only SELECT; the view lenses live in `library_listing.py`.
effective named-library content expands filed shows over already visible episodes;
this read relation grants no access and never determines physical retention.

Retry rules: filing and unfiling are keyed by (library, item), so resending either
is a no-op; a move compares its captured order revision under the library lock.
automatic acquisition preserves viewer removal markers; explicit filing clears them.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    active_podcast_subscription_exists_sql,
    can_read_media,
    can_restore_media,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.library import LibraryOrderOut, LibraryPlacementOut
from nexus.services import libraries
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.suggestion_changes import record_input_change

# Mirrors ix_library_entries_library_order: the one entry order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"


@dataclass(frozen=True)
class EntryTarget:
    """What an entry files: exactly one media or one show."""

    kind: Literal["media", "podcast"]
    id: UUID

    @property
    def column(self) -> str:
        return "media_id" if self.kind == "media" else "podcast_id"


def media_target(media_id: UUID) -> EntryTarget:
    return EntryTarget("media", media_id)


def podcast_target(podcast_id: UUID) -> EntryTarget:
    return EntryTarget("podcast", podcast_id)


# Relations composed inline by atlas, search scope and suggestions.


def library_entry_media_rows_sql(*, library_param: str = ":library_id") -> str:
    """Expand physical entries into media_id, position, lane and published_at.

    direct media precede inherited episodes at a position. callers own visibility
    and deduplication; this expansion is neither an access nor a retention rule.
    """
    return f"""
        SELECT le.media_id, le.position, 0 AS lane, NULL::timestamptz AS published_at
        FROM library_entries le
        WHERE le.library_id = {library_param} AND le.media_id IS NOT NULL

        UNION ALL

        SELECT pe.media_id, le.position, 1 AS lane, pe.published_at
        FROM library_entries le
        JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
        WHERE le.library_id = {library_param}
    """


def library_media_ids_cte_sql(*, library_param: str = ":library_id") -> str:
    """The media one library holds for :viewer_id. A named member library gives its
    direct media and filed shows' episodes; the viewer's own default gives every
    media in their non-system memberships (All); anything else gives nothing.
    both intersect visibility, excluding tombstoned and tearing-down media."""
    return f"""
        SELECT expanded.media_id
        FROM ({library_entry_media_rows_sql(library_param=library_param)}) expanded
        JOIN libraries l ON l.id = {library_param}
        JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
        WHERE l.is_default = false
          AND expanded.media_id IN ({visible_media_ids_cte_sql()})

        UNION

        SELECT DISTINCT le.media_id
        FROM library_entries le
        JOIN memberships m ON m.library_id = le.library_id AND m.user_id = :viewer_id
        JOIN libraries l ON l.id = le.library_id AND l.system_key IS NULL
        WHERE le.media_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM libraries dl
              WHERE dl.id = {library_param}
                AND dl.is_default = true
                AND dl.system_key IS NULL
                AND dl.owner_user_id = :viewer_id
          )
          AND le.media_id IN ({visible_media_ids_cte_sql()})
    """


def destination_membership_rows_sql() -> str:
    """Everything one destination holds for :viewer_id and :library_id. Columns:
    target_scheme, target_id, media_id, podcast_id."""
    return f"""
        SELECT
            CASE WHEN le.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
                AS target_scheme,
            COALESCE(le.media_id, le.podcast_id) AS target_id,
            le.media_id,
            le.podcast_id
        FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        JOIN memberships membership
          ON membership.library_id = l.id AND membership.user_id = :viewer_id
        WHERE l.id = :library_id
          AND l.is_default = false

        UNION ALL

        SELECT
            'media' AS target_scheme,
            default_media.media_id AS target_id,
            default_media.media_id,
            NULL::uuid AS podcast_id
        FROM ({library_media_ids_cte_sql()}) default_media
        WHERE EXISTS (
            SELECT 1
            FROM libraries destination
            JOIN memberships membership
              ON membership.library_id = destination.id
             AND membership.user_id = :viewer_id
            WHERE destination.id = :library_id
              AND destination.is_default = true
              AND destination.system_key IS NULL
        )
    """


def engagement_anchor_library_ids(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> tuple[UUID, ...]:
    """Editable destinations whose ordered anchors can change with this media's engagement.

    Named libraries hold the media or its show. All holds physical media reached
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
                            le.media_id = :media_id OR le.podcast_id = (
                                SELECT podcast_id FROM podcast_episodes
                                WHERE media_id = :media_id
                            )
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
            candidate AS (
                SELECT d.target_scheme, d.target_id, le.id AS entry_id, le.created_at,
                       (le.library_id = :library_id) AS is_direct
                FROM destination d
                JOIN library_entries le
                  ON (d.media_id IS NOT NULL AND le.media_id = d.media_id)
                  OR (d.podcast_id IS NOT NULL AND le.podcast_id = d.podcast_id)
                JOIN memberships m ON m.library_id = le.library_id AND m.user_id = :viewer_id
                JOIN libraries src ON src.id = le.library_id AND src.system_key IS NULL
            ),
            canonical AS (
                SELECT DISTINCT ON (target_scheme, target_id) target_scheme, target_id, created_at
                FROM candidate
                ORDER BY target_scheme, target_id, is_direct DESC, created_at ASC, entry_id ASC
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


def _lock_parent_podcast(db: Session, media_id: UUID) -> UUID | None:
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
        text(f"SELECT id FROM library_entries WHERE library_id = :lib AND {target.column} = :tid"),
        {"lib": library_id, "tid": target.id},
    )


def entry_exists(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    return entry_id(db, library_id, target) is not None


def ensure_entry(
    db: Session, library_id: UUID, target: EntryTarget, *, position: int | None = None
) -> bool:
    """File the target if absent (last, or at `position`); the sole inserter. The
    library row lock serializes appends, so two never read the same MAX(position).
    A library or media deleted while this waited on its lock is a 404."""
    if target.kind == "media":
        lock_media_for_reference(db, target.id)
    if not libraries.lock_library_rows_in_order(db, [library_id]):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    if entry_exists(db, library_id, target):
        return False
    db.execute(
        text(f"""
            INSERT INTO library_entries (library_id, {target.column}, position)
            VALUES (
                :lib, :tid,
                COALESCE(
                    CAST(:position AS integer),
                    (SELECT COALESCE(MAX(position), -1) + 1
                     FROM library_entries WHERE library_id = :lib)
                )
            )
        """),
        {"lib": library_id, "tid": target.id, "position": position},
    )
    libraries.advance_order_revision(db, library_id)
    return True


def delete_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    deleted = db.scalar(
        text(
            f"DELETE FROM library_entries WHERE library_id = :lib AND {target.column} = :tid "
            "RETURNING id"
        ),
        {"lib": library_id, "tid": target.id},
    )
    if deleted is not None:
        libraries.advance_order_revision(db, library_id)
    return deleted is not None


def delete_all_entries_for_media(db: Session, media_id: UUID) -> list[UUID]:
    """Delete every entry of a media; return the libraries it left."""
    library_ids = list(
        db.scalars(
            text("DELETE FROM library_entries WHERE media_id = :id RETURNING library_id"),
            {"id": media_id},
        )
    )
    for library_id in sorted(library_ids):
        libraries.advance_order_revision(db, library_id)
    return library_ids


def delete_library_entries(db: Session, library_id: UUID) -> None:
    db.execute(text("DELETE FROM library_entries WHERE library_id = :id"), {"id": library_id})


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


def count_entries_for_media(db: Session, media_id: UUID) -> int:
    """How many libraries (any kind) file the media."""
    return db.execute(
        text("SELECT COUNT(*) FROM library_entries WHERE media_id = :id"), {"id": media_id}
    ).scalar_one()


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
    """Shows filed in the viewer's named libraries, or in one of them."""
    return set(
        db.scalars(
            text("""
                SELECT DISTINCT le.podcast_id FROM library_entries le
                JOIN libraries l ON l.id = le.library_id AND l.is_default = false
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE le.podcast_id IS NOT NULL
                  AND (CAST(:library_id AS uuid) IS NULL
                       OR le.library_id = CAST(:library_id AS uuid))
            """),
            {"viewer_id": viewer_id, "library_id": library_id},
        )
    )


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> list[LibraryPlacementOut]:
    """Where one visible media or show sits among the viewer's libraries: All first
    (a show has no All row: following it files it there), then by name."""
    if target.kind == "media":
        if not can_read_media(db, viewer_id, target.id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        addable = True
        inherited_sql = """EXISTS (
            SELECT 1 FROM podcast_episodes e
            JOIN library_entries show ON show.podcast_id = e.podcast_id
                                     AND show.library_id = l.id
            WHERE e.media_id = :target_id
        )"""
    else:
        subscribed = db.scalar(
            text(f"""
                SELECT {active_podcast_subscription_exists_sql()} FROM podcasts p
                WHERE p.id = :target_id
            """),
            {"viewer_id": viewer_id, "target_id": target.id},
        )
        if subscribed is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        addable, inherited_sql = subscribed, "false"
    rows = db.execute(
        text(f"""
            SELECT l.id, l.name, l.owner_user_id, l.is_default, l.system_key, m.role,
                   EXISTS (
                       SELECT 1 FROM library_entries le
                       WHERE le.library_id = l.id AND le.{target.column} = :target_id
                   ) AS direct,
                   {inherited_sql} AS inherited
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            ORDER BY l.is_default DESC, lower(l.name), l.name, l.id
        """),
        {"viewer_id": viewer_id, "target_id": target.id},
    ).all()
    placements = []
    for row in rows:
        if row.is_default and (target.kind != "media" or row.owner_user_id != viewer_id):
            continue
        relation = "Direct" if row.direct else "Inherited" if row.inherited else "Absent"
        blocked = (
            "SystemManaged"
            if row.system_key is not None
            else "RequiresSubscription"
            if not addable
            else "RequiresAdmin"
            if row.role != "admin"
            else None
        )
        placements.append(
            LibraryPlacementOut(
                library_id=row.id,
                name=row.name,
                is_default=row.is_default,
                relation=relation,
                blocked=blocked,
            )
        )
    return placements


# Media filing and removal.


def _file_media(db: Session, viewer_id: UUID, media_id: UUID, library_ids: Sequence[UUID]) -> bool:
    """File a media the viewer may read (or restore) into libraries they admin; an
    episode whose show a named library holds is filed through the show. Clears the
    viewer's tombstone. Returns whether an entry was inserted."""
    from nexus.services.media_deletion import clear_user_media_deletion

    parent = _lock_parent_podcast(db, media_id)
    # Authorize under the row lock and before the barrier: a viewer who cannot
    # reach the media learns nothing, not even that it is being deleted.
    lock_media_rows_in_order(db, [media_id])
    if not (
        can_restore_media(db, viewer_id, media_id)
        or can_read_media(db, viewer_id, media_id, include_tearing_down=True)
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    lock_media_for_reference(db, media_id)
    inserted = False
    for library_id in sorted(library_ids):
        library = libraries.access(db, viewer_id, library_id, lock=True)
        library.require_admin()
        library.require_not_system()
        if (
            parent is not None
            and not library.is_default
            and entry_exists(db, library_id, podcast_target(parent))
        ):
            continue
        inserted = ensure_entry(db, library_id, media_target(media_id)) or inserted
    clear_user_media_deletion(db, viewer_id, media_id)
    return inserted


def ensure_media_in_library_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, media_id: UUID
) -> bool:
    """File one media into one library the viewer admins (All included)."""
    return _file_media(db, viewer_id, media_id, [library_id])


def assign_libraries_for_media_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """File media the viewer just ingested into their All and the named destinations
    they chose (an episode whose show a destination holds is filed through it)."""
    from nexus.services.media_deletion import clear_user_media_deletion

    targets = libraries.resolve_writable_destinations(db, viewer_id, library_ids)
    parent = _lock_parent_podcast(db, media_id)
    lock_media_for_reference(db, media_id)
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, *targets])
    ensure_entry(db, default_id, media_target(media_id))
    for library_id in targets:
        if parent is None or not entry_exists(db, library_id, podcast_target(parent)):
            ensure_entry(db, library_id, media_target(media_id))
    clear_user_media_deletion(db, viewer_id, media_id)


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> bool:
    """Automatically acquire into All unless the viewer explicitly removed this media."""
    # Removal locks this same row before changing placements and its marker.
    lock_media_rows_in_order(db, [media_id])
    if db.scalar(
        text("SELECT 1 FROM user_media_deletions WHERE user_id = :u AND media_id = :m"),
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
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID, *, allow_default: bool = False
) -> None:
    """Unfile from a library the viewer admins; absent is success. The last entry
    anywhere is refused: unfiling never tears a media down, only deleting it does.
    `allow_default` admits All (Saved in Nexus, the assistant's undo)."""
    if not lock_media_rows_in_order(db, [media_id]):
        return
    library = libraries.access(db, viewer_id, library_id, lock=True)
    library.require_admin()
    library.require_not_system()
    if not allow_default:
        library.require_named()
    if not entry_exists(db, library_id, media_target(media_id)):
        return
    lock_media_for_reference(db, media_id)
    if count_entries_for_media(db, media_id) == 1:
        raise ConflictError(
            ApiErrorCode.E_MEDIA_LAST_REFERENCE, "Media must remain in at least one library"
        )
    delete_entry(db, library_id, media_target(media_id))


# Show placement.


def place_podcast_in_named_libraries_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    library_ids: list[UUID],
    replace_episodes: bool,
) -> tuple[UUID, ...]:
    """Place a show in named libraries the viewer admins; return those it was added
    to. Where a library files some of its episodes directly, refuse with the counts
    (409 E_PODCAST_REPLACES_EPISODES) unless `replace_episodes`: then the show takes
    the earliest episode's position, those episode rows go and the episodes stay in
    the viewer's All. Every episode filer locks the show first, so no episode row
    appears while it is held; unfiling and library deletion do not, so the rows are
    read again under the media and library locks and only that read is acted on."""
    targets = libraries.resolve_writable_destinations(db, viewer_id, library_ids)
    if not targets:
        return ()
    if (
        db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id FOR UPDATE"), {"id": podcast_id})
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    episodes_sql = text("""
        SELECT le.id, le.library_id, le.media_id, le.position
        FROM library_entries le JOIN podcast_episodes pe ON pe.media_id = le.media_id
        WHERE pe.podcast_id = :podcast_id AND le.library_id = ANY(:ids)
    """)
    params = {"podcast_id": podcast_id, "ids": targets}
    lock_media_rows_in_order(db, [row.media_id for row in db.execute(episodes_sql, params)])
    default_id = libraries.default_library_id(db, viewer_id)
    libraries.lock_library_rows_in_order(db, [default_id, *targets])
    episodes = db.execute(episodes_sql, params).all()
    if episodes and not replace_episodes:
        counts: dict[UUID, int] = {}
        for row in episodes:
            counts[row.library_id] = counts.get(row.library_id, 0) + 1
        names = {
            row.id: row.name
            for row in db.execute(
                text("SELECT id, name FROM libraries WHERE id = ANY(:ids)"), {"ids": list(counts)}
            )
        }
        raise ConflictError(
            ApiErrorCode.E_PODCAST_REPLACES_EPISODES,
            "Placing this show replaces episodes filed in the library",
            details={
                "conflicts": [
                    {"library_id": str(lib), "library_name": names[lib], "episode_count": n}
                    for lib, n in counts.items()
                ]
            },
        )
    added = tuple(
        library_id
        for library_id in targets
        if ensure_entry(
            db,
            library_id,
            podcast_target(podcast_id),
            position=min(
                (r.position for r in episodes if r.library_id == library_id), default=None
            ),
        )
    )
    for row in episodes:
        ensure_entry(db, default_id, media_target(row.media_id))
    db.execute(
        text("DELETE FROM library_entries WHERE id = ANY(:ids)"),
        {"ids": [row.id for row in episodes]},
    )
    for library_id in sorted({row.library_id for row in episodes}):
        libraries.advance_order_revision(db, library_id)
    return added


def place_subscribed_podcast_in_named_library_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, podcast_id: UUID, replace_episodes: bool
) -> bool:
    """File a show the viewer follows into one named library; never subscribes. A
    library the viewer cannot see is a 404 before anything about the show."""
    libraries.access(db, viewer_id, library_id, lock=False)
    subscribed = db.scalar(
        text("""
            SELECT 1 FROM podcast_subscriptions
            WHERE user_id = :viewer_id AND podcast_id = :podcast_id FOR UPDATE
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    )
    if subscribed is None:
        raise ConflictError(
            ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED,
            "Subscribe to this podcast before adding it to a library",
        )
    return bool(
        place_podcast_in_named_libraries_in_current_transaction(
            db,
            viewer_id=viewer_id,
            podcast_id=podcast_id,
            library_ids=[library_id],
            replace_episodes=replace_episodes,
        )
    )


def undo_podcast_filing_for_viewer_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> bool:
    """Remove a show from a named library the viewer admins; its episodes are not
    re-filed. Returns whether it was there."""
    db.execute(text("SELECT 1 FROM podcasts WHERE id = :id FOR UPDATE"), {"id": podcast_id})
    library = libraries.access(db, viewer_id, library_id, lock=True)
    library.require_admin()
    library.require_mutable()
    return delete_entry(db, library_id, podcast_target(podcast_id))


def remove_unsubscribed_podcast_placements(
    db: Session, *, viewer_id: UUID, podcast_id: UUID
) -> tuple[int, int]:
    """On unsubscribe: named libraries the viewer owns alone lose the show, shared
    ones keep it. Returns (removed, retained shared). The show's row lock first, as
    every show placement takes it, so the libraries read here are all of them."""
    db.execute(text("SELECT 1 FROM podcasts WHERE id = :id FOR UPDATE"), {"id": podcast_id})
    held = db.scalars(
        text("""
            SELECT le.library_id FROM library_entries le
            JOIN libraries l ON l.id = le.library_id AND l.is_default = false
            JOIN memberships m ON m.library_id = le.library_id AND m.user_id = :viewer_id
            WHERE le.podcast_id = :podcast_id
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).all()
    removable = db.scalars(
        text("""
            SELECT l.id FROM libraries l
            WHERE l.id = ANY(:ids) AND l.owner_user_id = :viewer_id
              AND (SELECT COUNT(*) FROM memberships m WHERE m.library_id = l.id) = 1
            ORDER BY l.id
        """),
        {"ids": libraries.lock_library_rows_in_order(db, held), "viewer_id": viewer_id},
    ).all()
    for library_id in removable:
        delete_entry(db, library_id, podcast_target(podcast_id))
    return len(removable), len(held) - len(removable)


# The placement routes: one item in one library.


def place_item(
    db: Session, viewer_id: UUID, library_id: UUID, target: EntryTarget, *, replace_episodes: bool
) -> None:
    """File a media (All is Saved in Nexus) or a followed show (named only)."""

    def attempt() -> None:
        with transaction(db):
            if target.kind == "media":
                _file_media(db, viewer_id, target.id, [library_id])
            else:
                place_subscribed_podcast_in_named_library_in_current_transaction(
                    db,
                    viewer_id=viewer_id,
                    library_id=library_id,
                    podcast_id=target.id,
                    replace_episodes=replace_episodes,
                )
            record_input_change(db)

    retry_read_committed(db, "place_item", attempt)


def unplace_item(db: Session, viewer_id: UUID, library_id: UUID, target: EntryTarget) -> None:
    """Unfile a media (All included; never its last entry) or a show; absent is
    success."""

    def attempt() -> None:
        with transaction(db):
            if target.kind == "media":
                remove_media_from_library_in_current_transaction(
                    db, viewer_id, target.id, library_id, allow_default=True
                )
            else:
                undo_podcast_filing_for_viewer_in_current_transaction(
                    db, viewer_id=viewer_id, library_id=library_id, podcast_id=target.id
                )
            record_input_change(db)

    retry_read_committed(db, "unplace_item", attempt)


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
