"""Library entries: the `library_entries` table — sole writer and lifecycle owner.

Every INSERT/UPDATE/DELETE on the table, the entry-kind polymorphism, the
position total order and the item-in-library commands live here. Readers
elsewhere only SELECT; the view lenses and hydration live in
`library_entry_listing.py`.
"""

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
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
from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.library import (
    AbsentLibraryPlacementRelationOut,
    AvailableLibraryPlacementAvailabilityOut,
    BlockedLibraryPlacementAvailabilityOut,
    DirectLibraryPlacementRelationOut,
    InheritedLibraryPlacementRelationOut,
    LibraryEntryKind,
    LibraryEntryOrderRequest,
    LibraryEntryRemovalOut,
    LibraryIdentityOut,
    LibraryLibraryPlacementDestinationOut,
    LibraryPlacementAvailabilityOut,
    LibraryPlacementOptionOut,
    LibraryPlacementRelationOut,
    PodcastPlacementAdditionOut,
    PodcastPlacementRemovalOut,
    SavedInNexusLibraryPlacementDestinationOut,
)
from nexus.services import library_governance as governance
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.collection_revisions import (
    ENTRY_VISIBILITY_FAMILIES,
    CollectionFamily,
    bump_all_collection_families,
    read_collection_revision,
)
from nexus.services.consumption import projection
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

# Mirrors index ix_library_entries_library_order. The single definition of the
# entry total order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"
_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}


@dataclass(frozen=True)
class EntryTarget:
    """What an entry points at — a faithful model of the exactly-one-target check."""

    kind: LibraryEntryKind
    id: UUID


def media_target(media_id: UUID) -> EntryTarget:
    return EntryTarget("media", media_id)


def podcast_target(podcast_id: UUID) -> EntryTarget:
    return EntryTarget("podcast", podcast_id)


def _bump_entry_visibility_revisions(db: Session) -> None:
    """Invalidate every finite inventory whose membership can change via filing."""
    bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)


def _entry_revision(db: Session, viewer_id: UUID) -> LibraryEntryRemovalOut:
    return LibraryEntryRemovalOut(
        library_entries_collection_revision=read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        )
    )


# ---------------------------------------------------------------------------
# Exported SQL relations (composed inline by atlas, search scope and resonance)
# ---------------------------------------------------------------------------


def library_media_ids_cte_sql(*, library_param: str = ":library_id") -> str:
    """The sole library media-set relation, binding :viewer_id and `library_param`.

    A non-default member library contributes its own physical media entries; the
    viewer's own Default contributes every media reachable through any of their
    current non-system memberships (the personal All set). Any other pair —
    non-member, someone else's Default, a system library — contributes nothing.
    Both branches intersect `visible_media_ids_cte_sql`, so tombstoned and
    tearing-down media never surface and no caller layers those checks again.
    """
    return f"""
        SELECT le.media_id
        FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
        WHERE l.id = {library_param}
          AND l.is_default = false
          AND le.media_id IS NOT NULL
          AND le.media_id IN ({visible_media_ids_cte_sql()})

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
    """Complete membership for one viewer/destination pair, binding :viewer_id and
    :library_id. Columns: target_scheme, target_id, media_id, podcast_id."""
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


def library_anchor_facts(
    db: Session, *, viewer_id: UUID, library_id: UUID, limit: int
) -> tuple[ResourceRef, ...]:
    """Newest readable representative refs from complete destination membership."""
    if limit <= 0:
        return ()
    from nexus.services.podcasts.episodes import episode_publication_rows_sql

    rows = (
        db.execute(
            text(f"""
                WITH destination AS (
                    {destination_membership_rows_sql()}
                ),
                engagement AS (
                    {projection.engagement_fact_rows_sql()}
                ),
                episodes AS (
                    {episode_publication_rows_sql()}
                ),
                visible_media AS (
                    {visible_media_ids_cte_sql()}
                ),
                visible_podcasts AS (
                    {visible_podcast_ids_cte_sql()}
                ),
                candidate_entries AS (
                    SELECT
                        destination.target_scheme,
                        destination.target_id,
                        le.id AS entry_id,
                        le.created_at,
                        (le.library_id = :library_id) AS is_direct
                    FROM destination
                    JOIN library_entries le
                      ON (
                        destination.media_id IS NOT NULL
                        AND le.media_id = destination.media_id
                      ) OR (
                        destination.podcast_id IS NOT NULL
                        AND le.podcast_id = destination.podcast_id
                      )
                    JOIN memberships membership
                      ON membership.library_id = le.library_id
                     AND membership.user_id = :viewer_id
                    JOIN libraries source_library
                      ON source_library.id = le.library_id
                     AND source_library.system_key IS NULL
                ),
                canonical_entries AS (
                    SELECT DISTINCT ON (target_scheme, target_id)
                        target_scheme, target_id, created_at
                    FROM candidate_entries
                    ORDER BY
                        target_scheme, target_id, is_direct DESC, created_at ASC, entry_id ASC
                ),
                podcast_engagement AS (
                    SELECT
                        episodes.podcast_id,
                        MAX(engagement.last_engaged_at) FILTER (
                            WHERE engagement.last_engaged_at <= now()
                        ) AS last_engaged_at
                    FROM episodes
                    JOIN visible_media ON visible_media.media_id = episodes.media_id
                    JOIN engagement ON engagement.media_id = episodes.media_id
                    GROUP BY episodes.podcast_id
                )
                SELECT
                    canonical_entries.target_scheme,
                    canonical_entries.target_id,
                    CASE
                        WHEN canonical_entries.target_scheme = 'media'
                            THEN CASE
                                WHEN media_engagement.last_engaged_at <= now()
                                THEN media_engagement.last_engaged_at
                            END
                        ELSE podcast_engagement.last_engaged_at
                    END AS last_engaged_at
                FROM canonical_entries
                LEFT JOIN engagement media_engagement
                  ON canonical_entries.target_scheme = 'media'
                 AND media_engagement.media_id = canonical_entries.target_id
                LEFT JOIN podcast_engagement
                  ON canonical_entries.target_scheme = 'podcast'
                 AND podcast_engagement.podcast_id = canonical_entries.target_id
                WHERE (
                    canonical_entries.target_scheme = 'media'
                    AND canonical_entries.target_id IN (SELECT media_id FROM visible_media)
                ) OR (
                    canonical_entries.target_scheme = 'podcast'
                    AND canonical_entries.target_id IN (SELECT podcast_id FROM visible_podcasts)
                )
                ORDER BY
                    last_engaged_at DESC NULLS LAST,
                    canonical_entries.created_at DESC,
                    canonical_entries.target_scheme ASC,
                    canonical_entries.target_id ASC
                LIMIT :anchor_limit
            """),
            {"viewer_id": viewer_id, "library_id": library_id, "anchor_limit": limit},
        )
        .mappings()
        .all()
    )
    return tuple(
        ResourceRef(
            scheme=cast("ResourceScheme", str(row["target_scheme"])),
            id=UUID(str(row["target_id"])),
        )
        for row in rows
    )


# ---------------------------------------------------------------------------
# Primitives: locks, writes, ordering
# ---------------------------------------------------------------------------


def _raise_if_locked_media_teardown_pending(db: Session, media_id: UUID) -> None:
    intent = db.execute(
        text("SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if intent is not None:
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")


def _raise_if_media_teardown_pending(db: Session, media_id: UUID) -> None:
    """Reference barrier: lock the media row, then reject a pending teardown.

    justify-concurrency: the teardown claim locks only the media row, checks for
    zero committed references and inserts its intent, so creator-first makes the
    claim see a reference and claim-first makes the creator raise
    E_MEDIA_DELETING. The media lock is always taken before any library lock, so
    the reference path and the delete path share one media->library order.
    """
    locked = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
    ).fetchone()
    if locked is not None:
        _raise_if_locked_media_teardown_pending(db, media_id)


def _lock_authorized_media_for_filing(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Lock the media row, then reauthorize before any library lock.

    justify-concurrency: a whole-resource delete can drop the viewer's last
    reachability while this filing waits for the row, and a stale authorization
    must not become a new reference.
    """
    locked = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
    ).fetchone()
    if locked is None or not _can_file_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    _raise_if_locked_media_teardown_pending(db, media_id)


def _can_file_media(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    return can_restore_media(db, viewer_id, media_id) or can_read_media(
        db, viewer_id, media_id, include_tearing_down=True
    )


def lock_media_rows_in_order(db: Session, media_ids: Sequence[UUID]) -> list[UUID]:
    """Lock existing media rows in the repository-wide reference-mutation order."""
    ordered_ids = sorted(set(media_ids))
    if not ordered_ids:
        return []
    rows = db.execute(
        text("SELECT id FROM media WHERE id = ANY(:media_ids) ORDER BY id FOR UPDATE"),
        {"media_ids": ordered_ids},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def _lock_parent_podcast_for_media(db: Session, media_id: UUID) -> UUID | None:
    """Lock the parent podcast of an episode media, before media and library."""
    podcast_id = db.scalar(
        text("""
            SELECT p.id FROM podcast_episodes pe
            JOIN podcasts p ON p.id = pe.podcast_id
            WHERE pe.media_id = :media_id
            FOR UPDATE OF p
        """),
        {"media_id": media_id},
    )
    return None if podcast_id is None else UUID(str(podcast_id))


def _next_position(db: Session, library_id: UUID) -> int:
    value = db.execute(
        text("SELECT COALESCE(MAX(position), -1) + 1 FROM library_entries WHERE library_id = :lib"),
        {"lib": library_id},
    ).scalar()
    return int(value or 0)


def ensure_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Append the target at the next position if absent; the sole inserter.

    justify-concurrency: the library row lock is the per-library append
    serialization point — two concurrent appends would otherwise read the same
    MAX(position)+1 and collide on UNIQUE(library_id, position) at commit.
    transaction() is READ COMMITTED, so concurrency.md's FOR UPDATE prohibition
    (scoped to SERIALIZABLE) does not apply.
    """
    if target.kind == "media":
        _raise_if_media_teardown_pending(db, target.id)
    db.execute(text("SELECT 1 FROM libraries WHERE id = :lib FOR UPDATE"), {"lib": library_id})
    if entry_exists(db, library_id, target):
        return False
    db.execute(
        text("""
            INSERT INTO library_entries (library_id, media_id, podcast_id, position)
            VALUES (:lib, :media_id, :podcast_id, :position)
        """),
        {
            "lib": library_id,
            "media_id": target.id if target.kind == "media" else None,
            "podcast_id": target.id if target.kind == "podcast" else None,
            "position": _next_position(db, library_id),
        },
    )
    return True


def entry_exists(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Whether the (library, target) entry is present."""
    row = db.execute(
        text(
            f"SELECT 1 FROM library_entries "
            f"WHERE library_id = :lib AND {_TARGET_COLUMN[target.kind]} = :tid"
        ),
        {"lib": library_id, "tid": target.id},
    ).fetchone()
    return row is not None


def entry_id_for_target_in_current_transaction(
    db: Session, *, library_id: UUID, target: EntryTarget
) -> UUID | None:
    """Resolve one exact filing identity inside its caller-owned transaction."""
    value = db.scalar(
        text(
            f"SELECT id FROM library_entries "
            f"WHERE library_id = :library_id AND {_TARGET_COLUMN[target.kind]} = :target_id"
        ),
        {"library_id": library_id, "target_id": target.id},
    )
    return UUID(str(value)) if value is not None else None


def delete_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Delete the (library, target) entry; the caller decides when to close gaps."""
    deleted = db.execute(
        text(
            f"DELETE FROM library_entries "
            f"WHERE library_id = :lib AND {_TARGET_COLUMN[target.kind]} = :tid RETURNING id"
        ),
        {"lib": library_id, "tid": target.id},
    ).fetchone()
    return deleted is not None


def delete_all_entries_for_media(db: Session, media_id: UUID) -> list[UUID]:
    """Delete every entry for a media; return the libraries needing renormalizing."""
    rows = db.execute(
        text("DELETE FROM library_entries WHERE media_id = :media_id RETURNING library_id"),
        {"media_id": media_id},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def delete_library_entries(db: Session, library_id: UUID) -> None:
    """Delete every entry in a library (library teardown)."""
    db.execute(
        text("DELETE FROM library_entries WHERE library_id = :library_id"),
        {"library_id": library_id},
    )


def normalize_positions(db: Session, library_id: UUID) -> None:
    """Renormalize a library to dense 0..n-1 in the canonical order. The position
    unique constraint is DEFERRABLE, so the permutation never trips mid-statement."""
    db.execute(
        text(f"""
            WITH ordered AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY {_ENTRY_ORDER}) - 1 AS new_position
                FROM library_entries
                WHERE library_id = :library_id
            )
            UPDATE library_entries le
            SET position = ordered.new_position
            FROM ordered
            WHERE le.id = ordered.id AND le.position <> ordered.new_position
        """),
        {"library_id": library_id},
    )


# ---------------------------------------------------------------------------
# Read accessors
# ---------------------------------------------------------------------------


def list_media_ids_in_library(db: Session, library_id: UUID) -> list[UUID]:
    """Every media referenced by a library, in the canonical entry order."""
    rows = db.execute(
        text(f"""
            SELECT media_id FROM library_entries
            WHERE library_id = :library_id AND media_id IS NOT NULL
            ORDER BY {_ENTRY_ORDER}
        """),
        {"library_id": library_id},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def library_ids_for_media(db: Session, media_id: UUID) -> list[UUID]:
    """All physical library references for a media, ordered by library UUID."""
    rows = db.execute(
        text(
            "SELECT library_id FROM library_entries WHERE media_id = :media_id ORDER BY library_id"
        ),
        {"media_id": media_id},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def count_entries_for_media(db: Session, media_id: UUID) -> int:
    """The media's lifetime reference count across every library."""
    return int(
        db.execute(
            text("SELECT COUNT(*) FROM library_entries WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).scalar_one()
    )


def count_entries_by_library(db: Session, library_ids: Sequence[UUID]) -> dict[UUID, int]:
    """Entry counts keyed by library id; libraries with no entries are absent."""
    if not library_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT library_id, COUNT(*) AS item_count
            FROM library_entries
            WHERE library_id = ANY(:library_ids)
            GROUP BY library_id
        """),
        {"library_ids": list(library_ids)},
    ).fetchall()
    return {UUID(str(row[0])): int(row[1]) for row in rows}


def admin_non_default_library_ids_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[UUID]:
    """Named libraries the viewer admins that hold this media, oldest first."""
    rows = db.execute(
        text("""
            SELECT l.id
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id
            JOIN memberships m
              ON m.library_id = l.id AND m.user_id = :viewer_id AND m.role = 'admin'
            WHERE le.media_id = :media_id
              AND l.is_default = false
              AND l.system_key IS NULL
            ORDER BY l.created_at ASC, l.id ASC
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def podcast_ids_in_libraries_for_viewer(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> set[UUID]:
    """Podcast ids the viewer can see in non-default libraries, optionally in one."""
    rows = db.execute(
        text("""
            SELECT DISTINCT le.podcast_id
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id AND l.is_default = false
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE le.podcast_id IS NOT NULL
              AND (CAST(:library_id AS uuid) IS NULL OR le.library_id = CAST(:library_id AS uuid))
        """),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).fetchall()
    return {UUID(str(row[0])) for row in rows}


def _require_share_entitlement_for_access_increase(
    db: Session, *, actor_user_id: UUID, library_id: UUID
) -> None:
    """Gate a write that increases access to an already-shared library.

    Deliberately narrower than the invitation gate: filing into a library nobody
    else can reach increases no one's access and stays free.
    """
    increases_access = bool(
        db.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM memberships
                    WHERE library_id = :library_id AND user_id != :actor_user_id
                    UNION ALL
                    SELECT 1 FROM library_invitations
                    WHERE library_id = :library_id AND status = 'pending'
                )
            """),
            {"actor_user_id": actor_user_id, "library_id": library_id},
        ).scalar_one()
    )
    if increases_access and not get_effective_entitlements(db, actor_user_id).can_share:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Sharing requires Plus.")


# ---------------------------------------------------------------------------
# Placement inventory
# ---------------------------------------------------------------------------


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> list[LibraryPlacementOptionOut]:
    """The canonical typed placement inventory for one visible media or podcast."""
    if target.kind == "media":
        if not can_read_media(db, viewer_id, target.id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        target_can_be_added = True
        inherited_sql = """
            EXISTS(
                SELECT 1
                FROM podcast_episodes episode
                JOIN library_entries parent_entry
                  ON parent_entry.podcast_id = episode.podcast_id
                 AND parent_entry.library_id = l.id
                WHERE episode.media_id = :target_id
            )
        """
    else:
        podcast = db.execute(
            text(f"""
                SELECT {active_podcast_subscription_exists_sql()} AS has_active_subscription
                FROM podcasts p
                WHERE p.id = :podcast_id
            """),
            {"viewer_id": viewer_id, "podcast_id": target.id},
        ).scalar_one_or_none()
        if podcast is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        target_can_be_added = bool(podcast)
        inherited_sql = "false"

    rows = (
        db.execute(
            text(f"""
            SELECT
                l.id, l.name, l.owner_user_id, l.is_default, l.system_key, m.role,
                EXISTS(
                    SELECT 1 FROM library_entries le
                    WHERE le.library_id = l.id AND le.{_TARGET_COLUMN[target.kind]} = :target_id
                ) AS is_direct,
                {inherited_sql} AS is_inherited
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            ORDER BY l.is_default DESC, lower(l.name) ASC, l.name ASC, l.id ASC
        """),
            {"viewer_id": viewer_id, "target_id": target.id},
        )
        .mappings()
        .all()
    )

    options: list[LibraryPlacementOptionOut] = []
    for row in rows:
        direct = bool(row["is_direct"])
        if row["is_default"]:
            if target.kind != "media" or UUID(str(row["owner_user_id"])) != viewer_id:
                continue
            options.append(
                LibraryPlacementOptionOut(
                    destination=SavedInNexusLibraryPlacementDestinationOut(),
                    relation=(
                        DirectLibraryPlacementRelationOut()
                        if direct
                        else AbsentLibraryPlacementRelationOut()
                    ),
                    availability=AvailableLibraryPlacementAvailabilityOut(),
                )
            )
            continue

        identity = LibraryIdentityOut(id=UUID(str(row["id"])), name=str(row["name"]))
        relation: LibraryPlacementRelationOut
        availability: LibraryPlacementAvailabilityOut
        if not direct and bool(row["is_inherited"]):
            relation = InheritedLibraryPlacementRelationOut(provenance=[identity])
            availability = BlockedLibraryPlacementAvailabilityOut(reason="Inherited")
        else:
            relation = (
                DirectLibraryPlacementRelationOut()
                if direct
                else AbsentLibraryPlacementRelationOut()
            )
            if row["system_key"] is not None:
                availability = BlockedLibraryPlacementAvailabilityOut(reason="SystemManaged")
            elif not target_can_be_added:
                availability = BlockedLibraryPlacementAvailabilityOut(reason="RequiresSubscription")
            elif row["role"] != "admin":
                availability = BlockedLibraryPlacementAvailabilityOut(reason="RequiresAdmin")
            else:
                availability = AvailableLibraryPlacementAvailabilityOut()
        options.append(
            LibraryPlacementOptionOut(
                destination=LibraryLibraryPlacementDestinationOut(library=identity),
                relation=relation,
                availability=availability,
            )
        )
    return options


# ---------------------------------------------------------------------------
# Media filing and removal
# ---------------------------------------------------------------------------


def ensure_media_in_library_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, media_id: UUID
) -> bool:
    """File one media into one library; return whether a new entry was inserted.

    Admin-only on the target, refusing system libraries. An episode filed into a
    named library that already holds its parent show is included through that
    show and inserts nothing. A Default target always inserts a real row. Every
    outcome clears the viewer's media tombstone.
    """
    from nexus.services.media_deletion import clear_user_media_deletion

    exists = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id"), {"media_id": media_id}
    ).fetchone()
    if exists is None or not _can_file_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
    _lock_authorized_media_for_filing(db, viewer_id, media_id)

    ctx = governance.lock_library_for_member(db, viewer_id, library_id)
    governance.require_admin(ctx.role)
    governance.require_not_system(ctx.system_key)

    target = media_target(media_id)
    if (
        parent_podcast_id is not None
        and not ctx.is_default
        and entry_exists(db, library_id, podcast_target(parent_podcast_id))
    ):
        clear_user_media_deletion(db, viewer_id, media_id)
        return False
    if not ctx.is_default and not entry_exists(db, library_id, target):
        _require_share_entitlement_for_access_increase(
            db, actor_user_id=viewer_id, library_id=library_id
        )
    inserted = ensure_entry(db, library_id, target)
    clear_user_media_deletion(db, viewer_id, media_id)
    _bump_entry_visibility_revisions(db)
    return inserted


def ensure_media_saved_in_nexus_for_viewer(db: Session, *, viewer_id: UUID, media_id: UUID) -> bool:
    """Idempotently create the identity-free `SavedInNexus` relation."""
    with transaction(db):
        return ensure_media_in_library_in_current_transaction(
            db,
            viewer_id=viewer_id,
            library_id=governance.default_library_id_for_user(db, viewer_id),
            media_id=media_id,
        )


def remove_media_from_library(
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID, *, allow_default: bool = False
) -> LibraryEntryRemovalOut:
    """Idempotently remove one media from a library the viewer admins.

    Convergent: an already-absent media returns the current revision without
    revealing whether it exists, and the last physical reference in existence is
    refused with E_MEDIA_LAST_REFERENCE. `allow_default` is for the Default-backed
    commands (Saved in Nexus, agent undo) that may unfile from All.
    """

    def authorize(*, lock: bool) -> None:
        ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=lock)
        governance.require_admin(ctx.role)
        if not allow_default:
            governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)

    def attempt() -> LibraryEntryRemovalOut:
        with transaction(db):
            authorize(lock=False)
            target = media_target(media_id)
            if not entry_exists(db, library_id, target):
                return _entry_revision(db, viewer_id)
            # A concurrent whole-resource or whole-library teardown removes the
            # entry with the media row; its commit is a successful serial
            # predecessor for this idempotent command.
            if lock_media_rows_in_order(db, [media_id]) != [media_id]:
                return _entry_revision(db, viewer_id)

            authorize(lock=True)
            if not entry_exists(db, library_id, target):
                return _entry_revision(db, viewer_id)
            _raise_if_media_teardown_pending(db, media_id)
            if count_entries_for_media(db, media_id) == 1:
                raise ConflictError(
                    ApiErrorCode.E_MEDIA_LAST_REFERENCE,
                    "Media must remain in at least one library",
                )
            delete_entry(db, library_id, target)
            normalize_positions(db, library_id)
            _bump_entry_visibility_revisions(db)
            return _entry_revision(db, viewer_id)

    return retry_read_committed(db, "remove_media_from_library", attempt)


def ensure_media_absent_from_saved_in_nexus_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> LibraryEntryRemovalOut:
    """Idempotently remove `SavedInNexus` while preserving lifetime safety."""
    return remove_media_from_library(
        db,
        viewer_id,
        media_id,
        governance.default_library_id_for_user(db, viewer_id),
        allow_default=True,
    )


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> bool:
    """Ensure a media has a direct physical entry in the user's default library."""
    from nexus.services.media_deletion import clear_user_media_deletion

    inserted = ensure_entry(
        db, governance.default_library_id_for_user(db, user_id), media_target(media_id)
    )
    clear_user_media_deletion(db, user_id, media_id)
    if inserted:
        _bump_entry_visibility_revisions(db)
    return inserted


def seed_media_into_system_library(db: Session, library_id: UUID, media_id: UUID) -> bool:
    """The trusted system command for corpus seeding; no actor authorization."""
    system_library = db.execute(
        text("SELECT 1 FROM libraries WHERE id = :library_id AND system_key IS NOT NULL"),
        {"library_id": library_id},
    ).fetchone()
    if system_library is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "System library not found")
    inserted = ensure_entry(db, library_id, media_target(media_id))
    if inserted:
        _bump_entry_visibility_revisions(db)
    return inserted


def _add_media_to_resolved_libraries(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_ids: list[UUID],
    *,
    parent_podcast_id: UUID | None,
) -> None:
    """Insert one media into already-resolved named destinations.

    justify-concurrency: the teardown barrier runs before any library lock, so
    this shares ensure_media_in_library's media->library order and cannot
    deadlock against it.
    """
    if not library_ids:
        return
    from nexus.services.media_deletion import clear_user_media_deletion

    _raise_if_media_teardown_pending(db, media_id)
    for library_id in sorted(library_ids):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_non_default(ctx.is_default)
        governance.require_admin(ctx.role)
        governance.require_not_system(ctx.system_key)

    target = media_target(media_id)
    for library_id in library_ids:
        if parent_podcast_id is not None and entry_exists(
            db, library_id, podcast_target(parent_podcast_id)
        ):
            continue
        if not entry_exists(db, library_id, target):
            _require_share_entitlement_for_access_increase(
                db, actor_user_id=viewer_id, library_id=library_id
            )
        ensure_entry(db, library_id, target)
    clear_user_media_deletion(db, viewer_id, media_id)


def ensure_media_in_libraries_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """Additively file one media into the viewer's selected named destinations."""
    with transaction(db):
        exists = db.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"), {"media_id": media_id}
        ).fetchone()
        if exists is None or not _can_file_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
        _lock_authorized_media_for_filing(db, viewer_id, media_id)
        _add_media_to_resolved_libraries(
            db,
            viewer_id,
            media_id,
            governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids),
            parent_podcast_id=parent_podcast_id,
        )
        _bump_entry_visibility_revisions(db)


def assign_libraries_for_media_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """File one freshly ingested media into All plus its selected destinations."""
    targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
    default_library_id = governance.default_library_id_for_user(db, viewer_id)
    parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
    _raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id, *targets])
    ensure_media_in_default_library(db, viewer_id, media_id)
    _add_media_to_resolved_libraries(
        db, viewer_id, media_id, targets, parent_podcast_id=parent_podcast_id
    )
    _bump_entry_visibility_revisions(db)


def ensure_subscription_episode_default_in_current_transaction(
    db: Session, subscription_user_id: UUID, subscription_podcast_id: UUID, media_id: UUID
) -> bool:
    """Ensure one acquired episode is in All; named placement is not closure."""
    db.execute(
        text("SELECT id FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": subscription_podcast_id},
    ).first()
    lock_media_rows_in_order(db, [media_id])
    default_library_id = governance.default_library_id_for_user(db, subscription_user_id)
    _raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id])
    inserted = ensure_media_in_default_library(db, subscription_user_id, media_id)
    _bump_entry_visibility_revisions(db)
    return inserted


# ---------------------------------------------------------------------------
# Podcast placement
# ---------------------------------------------------------------------------


def _podcast_child_conflict_rows(
    db: Session, *, podcast_id: UUID, library_ids: Sequence[UUID]
) -> list[Any]:
    """Direct episode entries a show placement would displace."""
    if not library_ids:
        return []
    return list(
        db.execute(
            text("""
                SELECT le.id AS entry_id, le.library_id, le.media_id, le.position
                FROM library_entries le
                JOIN podcast_episodes pe ON pe.media_id = le.media_id
                WHERE pe.podcast_id = :podcast_id
                  AND le.library_id = ANY(:library_ids)
                ORDER BY le.media_id, le.library_id, le.id
            """),
            {"podcast_id": podcast_id, "library_ids": list(library_ids)},
        )
        .mappings()
        .all()
    )


def _podcast_placement_conflict_fingerprint(
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    library_ids: Sequence[UUID],
    entry_ids: Sequence[UUID],
) -> str:
    """Confirm-before-replace token over data the actor already owns."""
    payload = json.dumps(
        {
            "actor": str(viewer_id),
            "podcast": str(podcast_id),
            "libraries": [str(value) for value in sorted(library_ids)],
            "entries": [str(value) for value in sorted(entry_ids)],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(b"nexus-podcast-placement-conflict\0" + payload).hexdigest()


def place_podcast_in_named_libraries_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    library_ids: list[UUID],
    confirmation_fingerprint: str | None,
) -> tuple[UUID, ...]:
    """Place one show in named libraries; return the libraries it was added to.

    Placing a show where direct episode entries exist is refused with
    E_PODCAST_REPLACES_EPISODES and a fingerprint; re-sent with that fingerprint
    it commits, taking the show's position from the earliest displaced episode,
    deleting those entries and keeping each displaced episode in All.
    """
    targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
    podcast = db.execute(
        text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": podcast_id},
    ).fetchone()
    if podcast is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

    conflict_rows = _podcast_child_conflict_rows(db, podcast_id=podcast_id, library_ids=targets)
    child_media_ids = sorted({UUID(str(row["media_id"])) for row in conflict_rows})
    if lock_media_rows_in_order(db, child_media_ids) != child_media_ids:
        raise TransactionRestart("Podcast child Media set changed")

    default_library_id = governance.default_library_id_for_user(db, viewer_id)
    locked_library_ids = sorted({default_library_id, *targets})
    if governance.lock_library_rows_in_order(db, locked_library_ids) != locked_library_ids:
        raise TransactionRestart("Podcast destination Library set changed")
    contexts = {
        library_id: governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
        for library_id in targets
    }
    for context in contexts.values():
        governance.require_admin(context.role)
        governance.require_non_default(context.is_default)
        governance.require_not_system(context.system_key)

    conflicts = _podcast_child_conflict_rows(db, podcast_id=podcast_id, library_ids=targets)
    entry_ids = [UUID(str(row["entry_id"])) for row in conflicts]
    if set(entry_ids) != {UUID(str(row["entry_id"])) for row in conflict_rows}:
        raise TransactionRestart("Podcast child entry set changed")

    fingerprint = _podcast_placement_conflict_fingerprint(
        viewer_id=viewer_id, podcast_id=podcast_id, library_ids=targets, entry_ids=entry_ids
    )
    counts: dict[UUID, int] = {}
    earliest_position: dict[UUID, int] = {}
    for row in conflicts:
        library_id = UUID(str(row["library_id"]))
        counts[library_id] = counts.get(library_id, 0) + 1
        earliest_position[library_id] = min(
            earliest_position.get(library_id, int(row["position"])), int(row["position"])
        )
    if conflicts and confirmation_fingerprint != fingerprint:
        raise ConflictError(
            ApiErrorCode.E_PODCAST_REPLACES_EPISODES,
            "Podcast placement replaces direct episode placements",
            details={
                "conflicts": [
                    {
                        "libraryId": str(library_id),
                        "libraryName": contexts[library_id].name,
                        "episodeCount": counts[library_id],
                    }
                    for library_id in targets
                    if library_id in counts
                ],
                "conflictFingerprint": fingerprint,
            },
        )

    added: list[UUID] = []
    target = podcast_target(podcast_id)
    for library_id in targets:
        if entry_exists(db, library_id, target):
            continue
        _require_share_entitlement_for_access_increase(
            db, actor_user_id=viewer_id, library_id=library_id
        )
        db.execute(
            text("""
                INSERT INTO library_entries (library_id, media_id, podcast_id, position)
                VALUES (:library_id, NULL, :podcast_id, :position)
            """),
            {
                "library_id": library_id,
                "podcast_id": podcast_id,
                "position": earliest_position.get(library_id, _next_position(db, library_id)),
            },
        )
        added.append(library_id)

    for media_id in child_media_ids:
        ensure_entry(db, default_library_id, media_target(media_id))
    if entry_ids:
        db.execute(
            text("DELETE FROM library_entries WHERE id = ANY(:entry_ids)"),
            {"entry_ids": entry_ids},
        )
    for library_id in counts:
        normalize_positions(db, library_id)
    if added or entry_ids:
        _bump_entry_visibility_revisions(db)
    return tuple(added)


def place_subscribed_podcast_in_named_library_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> bool:
    """File one already-active subscription; never subscribe as a side effect."""
    subscription = db.execute(
        text("""
            SELECT id FROM podcast_subscriptions
            WHERE user_id = :viewer_id AND podcast_id = :podcast_id
            FOR UPDATE
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).first()
    if subscription is None:
        raise ConflictError(
            ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED,
            "Subscribe to this Podcast before adding it to a Library",
        )
    added = place_podcast_in_named_libraries_in_current_transaction(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        library_ids=[library_id],
        confirmation_fingerprint=None,
    )
    return bool(added)


def place_subscribed_podcast_in_named_library(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> PodcastPlacementAdditionOut:
    """Idempotently place, but never create, an active podcast subscription."""

    def attempt() -> PodcastPlacementAdditionOut:
        with transaction(db):
            added = place_subscribed_podcast_in_named_library_in_current_transaction(
                db, viewer_id=viewer_id, library_id=library_id, podcast_id=podcast_id
            )
            return PodcastPlacementAdditionOut(
                outcome="Added" if added else "AlreadyPresent",
                library_entries_collection_revision=read_collection_revision(
                    db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
                ),
            )

    return retry_read_committed(db, "place_subscribed_podcast_in_named_library", attempt)


def undo_podcast_filing_for_viewer_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> PodcastPlacementRemovalOut:
    """Remove one podcast from a named library; never recreates child entries."""
    db.execute(
        text("SELECT id FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": podcast_id},
    ).first()
    ctx = governance.lock_library_for_member(db, viewer_id, library_id)
    governance.require_admin(ctx.role)
    governance.require_non_default(ctx.is_default)
    governance.require_not_system(ctx.system_key)
    removed = delete_entry(db, library_id, podcast_target(podcast_id))
    if removed:
        normalize_positions(db, library_id)
        _bump_entry_visibility_revisions(db)
    return PodcastPlacementRemovalOut(
        outcome="Removed" if removed else "AlreadyAbsent",
        library_entries_collection_revision=read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
        ),
    )


def remove_podcast_from_library(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> PodcastPlacementRemovalOut:
    """Remove a podcast reference from one non-default library. Admin-only."""

    def attempt() -> PodcastPlacementRemovalOut:
        with transaction(db):
            return undo_podcast_filing_for_viewer_in_current_transaction(
                db, viewer_id=viewer_id, library_id=library_id, podcast_id=podcast_id
            )

    return retry_read_committed(db, "remove_podcast_from_library", attempt)


def remove_unsubscribed_podcast_placements(
    db: Session, *, viewer_id: UUID, podcast_id: UUID
) -> tuple[int, int]:
    """Tear down a show's placements on unsubscribe.

    Libraries the viewer solely owns lose the show; shared ones retain it. Returns
    (removed count, retained shared count).
    """
    snapshot_library_ids = sorted(
        {
            UUID(str(row[0]))
            for row in db.execute(
                text("""
                    SELECT entry.library_id
                    FROM library_entries entry
                    JOIN memberships membership
                      ON membership.library_id = entry.library_id
                     AND membership.user_id = :viewer_id
                    WHERE entry.podcast_id = :podcast_id
                """),
                {"viewer_id": viewer_id, "podcast_id": podcast_id},
            ).all()
        }
    )
    if governance.lock_library_rows_in_order(db, snapshot_library_ids) != snapshot_library_ids:
        raise TransactionRestart("Podcast placement Library set changed")

    rows = db.execute(
        text("""
            SELECT
                le.library_id,
                l.owner_user_id,
                l.is_default,
                (
                    SELECT COUNT(*) FROM memberships other_membership
                    WHERE other_membership.library_id = l.id
                ) AS member_count
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id
            JOIN memberships m ON m.library_id = le.library_id AND m.user_id = :viewer_id
            WHERE le.podcast_id = :podcast_id
            FOR UPDATE OF le
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchall()
    if sorted({UUID(str(row[0])) for row in rows}) != snapshot_library_ids:
        raise TransactionRestart("Podcast placement Library set changed")

    removable_library_ids: list[UUID] = []
    retained_shared_library_count = 0
    for library_id, owner_user_id, is_default, member_count in rows:
        if bool(is_default):
            continue
        if owner_user_id == viewer_id and int(member_count) == 1:
            removable_library_ids.append(UUID(str(library_id)))
        else:
            retained_shared_library_count += 1

    for library_id in sorted(removable_library_ids):
        delete_entry(db, library_id, podcast_target(podcast_id))
        normalize_positions(db, library_id)
    if removable_library_ids:
        _bump_entry_visibility_revisions(db)
    return len(removable_library_ids), retained_shared_library_count


def reorder_entries(
    db: Session, viewer_id: UUID, library_id: UUID, body: LibraryEntryOrderRequest
) -> None:
    """Replace the full entry order for an admin viewer.

    The requested set must equal the existing set. Default has no physical order
    to reorder — it is a live virtual view — so it is rejected before set
    validation.
    """
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)

        existing_ids = {
            UUID(str(row[0]))
            for row in db.execute(
                text("SELECT id FROM library_entries WHERE library_id = :library_id"),
                {"library_id": library_id},
            ).fetchall()
        }
        requested_ids = [UUID(str(entry_id)) for entry_id in body.entry_ids]
        if existing_ids != set(requested_ids) or len(existing_ids) != len(requested_ids):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Library reorder requires an exact full set of entry IDs",
            )

        db.execute(
            text("""
                WITH desired AS (
                    SELECT id, ord - 1 AS new_position
                    FROM unnest(cast(:entry_ids AS uuid[])) WITH ORDINALITY AS t(id, ord)
                )
                UPDATE library_entries le
                SET position = desired.new_position
                FROM desired
                WHERE le.id = desired.id AND le.library_id = :library_id
            """),
            {"entry_ids": requested_ids, "library_id": library_id},
        )
        _bump_entry_visibility_revisions(db)
