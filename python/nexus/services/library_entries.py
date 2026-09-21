"""Library entries: the `library_entries` table — sole writer and lifecycle owner.

Every INSERT/UPDATE/DELETE on `library_entries`, the entry-kind polymorphism, the
position total order, and the item-in-library commands live here. Other modules
call this module's public API; none issue `library_entries` DML directly. The
view lenses, the page query and hydration live in `library_entry_listing.py`.
The visibility readers in `auth/permissions.py` and the search/object modules read
the table under an explicit allowlist (see the cutover spec).
"""

import base64
import hashlib
import hmac
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, assert_never, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    active_podcast_subscription_exists_sql,
    can_read_media,
    can_restore_media,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.config import get_settings
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
    LibraryPlacementOptionOut,
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

# Mirrors index ix_library_entries_library_order (library_id, position, created_at DESC,
# id DESC). The single definition of the entry total order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"
_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}


def _bump_entry_visibility_revisions(db: Session) -> None:
    """Invalidate every finite inventory whose membership can change via filing."""
    bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)


def library_media_ids_cte_sql(*, library_param: str = ":library_id") -> str:
    """The sole library media-set relation (spec S4.1). Binds :viewer_id and
    `library_param` (default :library_id); every branch also intersects with
    `visible_media_ids_cte_sql`, which applies viewer-tombstone and
    teardown-intent exclusion, so a caller never has to layer those checks
    again on top.

    `library_param` lets a caller rebind the library-id placeholder to its own
    param name (e.g. search scope's `:scope_id`) instead of string-replacing
    the returned SQL; :viewer_id stays fixed because `visible_media_ids_cte_sql`
    (composed below) has no such hook and every caller already has an ambient
    `:viewer_id` bind.

    - Viewer-owned Default (`library_param` is the viewer's own non-system
      default library): every media_id reachable through any of the viewer's
      CURRENT non-system memberships — the personal "All" set. This is
      `auth.permissions.visible_media_ids_cte_sql`'s relation further constrained
      to non-system contributing libraries, so an Oracle work reachable only
      through the system corpus library never leaks into a personal surface
      (AC2); a work also explicitly filed personally stays, because that filing
      is itself a non-system membership path.
    - Non-default member library: that library's own physical media entries,
      intersected with the broader global-readability relation (so an entry
      whose media a concurrent teardown has since armed, or the viewer has since
      tombstoned, never surfaces even though the physical row still exists).
    - Any other (:viewer_id, `library_param`) pair — non-member, someone else's
      default, or a system-library target — contributes zero rows. This
    relation never raises; masking a non-member as "not found" is the
    caller's job (`library_governance.lock_library_for_member`).
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
    """Complete membership for one viewer/destination pair.

    Binds ``:viewer_id`` and ``:library_id``. Columns are ``target_scheme``,
    ``target_id``, ``media_id``, and ``podcast_id``. Non-default membership is
    physical and includes hidden rows; Default is its complete live personal-All
    media set. Authorization and destination filing policy remain caller-owned.
    """
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


@dataclass(frozen=True, slots=True)
class LibraryAnchorFact:
    ref: ResourceRef


def library_anchor_facts(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    limit: int,
) -> tuple[LibraryAnchorFact, ...]:
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
                        target_scheme,
                        target_id,
                        is_direct DESC,
                        created_at ASC,
                        entry_id ASC
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
                    canonical_entries.created_at,
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
            {
                "viewer_id": viewer_id,
                "library_id": library_id,
                "anchor_limit": limit,
            },
        )
        .mappings()
        .all()
    )
    return tuple(
        LibraryAnchorFact(
            ref=ResourceRef(
                scheme=cast("ResourceScheme", str(row["target_scheme"])),
                id=UUID(str(row["target_id"])),
            ),
        )
        for row in rows
    )


@dataclass(frozen=True)
class EntryTarget:
    """What a library entry points at — exactly one of media|podcast. A faithful model
    of the DB check ck_library_entries_exactly_one_target."""

    kind: LibraryEntryKind
    id: UUID


def media_target(media_id: UUID) -> EntryTarget:
    return EntryTarget("media", media_id)


def podcast_target(podcast_id: UUID) -> EntryTarget:
    return EntryTarget("podcast", podcast_id)


def entry_id_for_target_in_current_transaction(
    db: Session,
    *,
    library_id: UUID,
    target: EntryTarget,
) -> UUID | None:
    """Resolve one exact filing identity inside its caller-owned transaction."""

    column = _TARGET_COLUMN[target.kind]
    value = db.scalar(
        text(
            f"SELECT id FROM library_entries "
            f"WHERE library_id = :library_id AND {column} = :target_id"
        ),
        {"library_id": library_id, "target_id": target.id},
    )
    return UUID(str(value)) if value is not None else None


@dataclass(frozen=True)
class PodcastLibraryRemovalResult:
    removed_from_library_count: int
    retained_shared_library_count: int


@dataclass(frozen=True)
class LibraryFilingOutcome:
    """Closed result for one Library filing."""

    kind: Literal["Added", "AlreadyPresent", "IncludedThroughPodcast"]


@dataclass(frozen=True, slots=True)
class PodcastPlacementResult:
    added_library_ids: tuple[UUID, ...]
    already_present_library_ids: tuple[UUID, ...]


# ---------------------------------------------------------------------------
# Primitives (writes + ordering)
# ---------------------------------------------------------------------------


def _next_position(db: Session, library_id: UUID) -> int:
    """The next dense append position for a library (MAX(position)+1, or 0 if empty)."""
    value = db.execute(
        text("SELECT COALESCE(MAX(position), -1) + 1 FROM library_entries WHERE library_id = :lib"),
        {"lib": library_id},
    ).scalar()
    return int(value or 0)


def raise_if_media_teardown_pending(db: Session, media_id: UUID) -> None:
    """Reference barrier (spec §3.1): lock the media row, reject a pending teardown.

    Every lifetime-reference insert for a media target first locks that media row
    ``FOR UPDATE`` and checks ``media_teardown_intents`` in the same transaction, so a
    reference creator and the teardown claim (which locks only that media row, checks
    zero committed references, then inserts the intent + enqueues the job) linearize on
    the media row: creator-first makes the claim observe a reference; claim-first makes
    the creator raise ``E_MEDIA_DELETING``. The claim never locks library rows, so this
    introduces no cross-owner global lock order. The media lock is taken before any
    library lock so the reference path and the delete path share one media->library
    order.

    A missing media row is left for the caller's own existence handling; a teardown
    intent FKs ``media`` and cannot exist without the row.
    """
    locked = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).fetchone()
    if locked is None:
        return
    _raise_if_locked_media_teardown_pending(db, media_id)


def _raise_if_locked_media_teardown_pending(db: Session, media_id: UUID) -> None:
    """Apply the teardown barrier after the caller has locked the media row."""
    intent = db.execute(
        text("SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if intent is not None:
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")


def _lock_authorized_media_for_filing(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    authorization: Literal["readable", "restorable", "filable"],
) -> None:
    """Lock, then reauthorize an actor filing before any library lock.

    The pre-lock authorization in each public command gives its normal fast-fail
    behavior. This locked check is the linearization guard: a concurrent whole-resource
    deletion or last-library teardown may remove the viewer's final reachability while
    the filing waits for the media row, and must not turn that stale authorization into
    a new reference.
    """
    locked = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).fetchone()
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if authorization == "restorable":
        authorized = can_restore_media(db, viewer_id, media_id)
    elif authorization == "readable":
        authorized = can_read_media(
            db,
            viewer_id,
            media_id,
            include_tearing_down=True,
        )
    elif authorization == "filable":
        authorized = can_restore_media(db, viewer_id, media_id) or can_read_media(
            db,
            viewer_id,
            media_id,
            include_tearing_down=True,
        )
    else:
        assert_never(authorization)
    if not authorized:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    _raise_if_locked_media_teardown_pending(db, media_id)


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
    podcast_id = db.scalar(
        text("SELECT podcast_id FROM podcast_episodes WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    if podcast_id is None:
        return None
    locked = db.scalar(
        text("SELECT id FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": podcast_id},
    )
    if locked is None:
        # justify-service-invariant-check: podcast_episodes owns a non-null FK.
        # justify-defect: a trusted episode cannot point at a missing Podcast.
        raise AssertionError("Podcast episode points at missing Podcast")
    return UUID(str(locked))


def ensure_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Append the target to the library at next_position if absent. The sole inserter —
    replaces the inline add inserts and the closure's per-media append.

    For a media target, first runs the teardown reference barrier
    (:func:`raise_if_media_teardown_pending`) so a concurrent last-reference claim and
    this insert linearize on the media row before any library lock is taken.

    Locks the target library row next as the single per-library append serialization
    point. justify-concurrency: two concurrent appends would otherwise both read the
    same MAX(position)+1 — a result no sequential ordering yields — and collide on
    UNIQUE(library_id, position) at commit. concurrency.md requires locking when
    concurrent calls can produce a non-sequential result; its FOR UPDATE prohibition is
    scoped to SERIALIZABLE, whereas transaction() is READ COMMITTED. The bound is one
    row lock per library, held only for the append. The (library_id, media_id) /
    (library_id, podcast_id) unique constraints independently make a duplicate entry
    uncommittable regardless of isolation.
    """
    if target.kind == "media":
        raise_if_media_teardown_pending(db, target.id)
    db.execute(text("SELECT 1 FROM libraries WHERE id = :lib FOR UPDATE"), {"lib": library_id})
    column = _TARGET_COLUMN[target.kind]
    existing = db.execute(
        text(f"SELECT 1 FROM library_entries WHERE library_id = :lib AND {column} = :tid"),
        {"lib": library_id, "tid": target.id},
    ).fetchone()
    if existing is not None:
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


def delete_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Delete the (library, target) entry; return whether a row went. No implicit
    renormalize — the caller decides when to close position gaps."""
    column = _TARGET_COLUMN[target.kind]
    deleted = db.execute(
        text(
            f"DELETE FROM library_entries WHERE library_id = :lib AND {column} = :tid RETURNING id"
        ),
        {"lib": library_id, "tid": target.id},
    ).fetchone()
    return deleted is not None


def delete_all_entries_for_media(db: Session, media_id: UUID) -> list[UUID]:
    """Delete every entry for a media across all libraries; return the affected
    library_ids so the caller can renormalize their positions."""
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
    """Renormalize a library's entries to dense 0..n-1 by the canonical order. One
    statement; the position unique constraint is DEFERRABLE so the permutation never
    trips mid-statement. Run after any DELETE that can leave a position gap."""
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
            WHERE le.id = ordered.id
              AND le.position <> ordered.new_position
        """),
        {"library_id": library_id},
    )


# ---------------------------------------------------------------------------
# Read accessors
# ---------------------------------------------------------------------------


def entry_exists(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    column = _TARGET_COLUMN[target.kind]
    row = db.execute(
        text(f"SELECT 1 FROM library_entries WHERE library_id = :lib AND {column} = :tid"),
        {"lib": library_id, "tid": target.id},
    ).fetchone()
    return row is not None


def _require_share_entitlement_for_access_increase(
    db: Session, *, actor_user_id: UUID, library_id: UUID
) -> None:
    increases_access = bool(
        db.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1
                    FROM memberships
                    WHERE library_id = :library_id
                      AND user_id != :actor_user_id
                    UNION ALL
                    SELECT 1
                    FROM library_invitations
                    WHERE library_id = :library_id
                      AND status = 'pending'
                )
            """),
            {"actor_user_id": actor_user_id, "library_id": library_id},
        ).scalar_one()
    )
    if increases_access and not get_effective_entitlements(db, actor_user_id).can_share:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Sharing requires Plus.")


def list_media_ids_in_library(db: Session, library_id: UUID) -> list[UUID]:
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
    """All physical library references for media, ordered by library UUID."""
    rows = db.execute(
        text(
            "SELECT library_id FROM library_entries WHERE media_id = :media_id ORDER BY library_id"
        ),
        {"media_id": media_id},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def count_entries_for_media(db: Session, media_id: UUID) -> int:
    return int(
        db.execute(
            text("SELECT COUNT(*) FROM library_entries WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).scalar_one()
    )


def count_entries_by_library(db: Session, library_ids: Sequence[UUID]) -> dict[UUID, int]:
    """Entry counts keyed by library id (libraries with no entries are absent). One
    batched query for the library-list item-count, replacing a per-row subquery."""
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
    """Non-default libraries the viewer admins that currently hold this media, ordered
    created_at ASC, id ASC. Used by media-deletion's per-library removal sweep."""
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


# ---------------------------------------------------------------------------
# Item-in-library commands
# ---------------------------------------------------------------------------


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> list[LibraryPlacementOptionOut]:
    """Canonical typed placement inventory for one visible Media or Podcast."""
    if target.kind == "media":
        if not can_read_media(db, viewer_id, target.id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        target_can_be_added = True
    elif target.kind == "podcast":
        podcast = (
            db.execute(
                text(f"""
                    SELECT {active_podcast_subscription_exists_sql()} AS has_active_subscription
                    FROM podcasts p
                    WHERE p.id = :podcast_id
                """),
                {"viewer_id": viewer_id, "podcast_id": target.id},
            )
            .mappings()
            .one_or_none()
        )
        if podcast is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        target_can_be_added = bool(podcast["has_active_subscription"])
    else:
        assert_never(target.kind)

    column = _TARGET_COLUMN[target.kind]
    inherited_sql = (
        """
        EXISTS(
            SELECT 1
            FROM podcast_episodes episode
            JOIN library_entries parent_entry
              ON parent_entry.podcast_id = episode.podcast_id
             AND parent_entry.library_id = l.id
            WHERE episode.media_id = :target_id
        )
        """
        if target.kind == "media"
        else "false"
    )
    rows = (
        db.execute(
            text(f"""
            SELECT
                l.id, l.name, l.owner_user_id, l.is_default,
                l.system_key,
                EXISTS(
                    SELECT 1 FROM library_entries le
                    WHERE le.library_id = l.id AND le.{column} = :target_id
                ) AS is_direct,
                {inherited_sql} AS is_inherited,
                m.role
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
        is_default = bool(row["is_default"])
        if is_default:
            if target.kind != "media" or UUID(str(row["owner_user_id"])) != viewer_id:
                continue
            options.append(
                LibraryPlacementOptionOut(
                    destination=SavedInNexusLibraryPlacementDestinationOut(),
                    relation=(
                        DirectLibraryPlacementRelationOut()
                        if bool(row["is_direct"])
                        else AbsentLibraryPlacementRelationOut()
                    ),
                    availability=AvailableLibraryPlacementAvailabilityOut(),
                )
            )
            continue

        identity = LibraryIdentityOut(
            id=UUID(str(row["id"])),
            name=str(row["name"]),
        )
        inherited = not bool(row["is_direct"]) and bool(row["is_inherited"])
        if inherited:
            relation = InheritedLibraryPlacementRelationOut(provenance=[identity])
            availability = BlockedLibraryPlacementAvailabilityOut(reason="Inherited")
        else:
            relation = (
                DirectLibraryPlacementRelationOut()
                if bool(row["is_direct"])
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


def ensure_media_in_library(
    db: Session, viewer_id: UUID, library_id: UUID, media_id: UUID
) -> LibraryFilingOutcome:
    """The one actor-authorized filing command for attaching media to a library
    (spec S4.3). Admin-only. A Default target always creates/keeps a direct
    physical entry — there is no separate intrinsic/closure bookkeeping anymore;
    the physical row IS the direct intent, inserted unconditionally even when the
    media is already virtually present through another membership.

    A fast precheck authorizes readable-OR-restorable media (rule 1), then the
    media-row lock rechecks the same authorization before any library lock.
    REST and agent_tools both funnel through this one gate, so neither surface
    can file a stale or unauthorized media_id (no existence leak: unauthorized
    looks identical to nonexistent).

    Podcast episodes lock their parent Podcast before Media and Library.
    """
    with transaction(db):
        return ensure_media_in_library_in_current_transaction(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            media_id=media_id,
        )


def ensure_media_in_library_in_current_transaction(
    db: Session, *, viewer_id: UUID, library_id: UUID, media_id: UUID
) -> LibraryFilingOutcome:
    """Run the canonical media filing command inside a caller-owned transaction."""
    from nexus.services.media_deletion import clear_user_media_deletion

    media_exists = db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if media_exists is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if not (
        can_restore_media(db, viewer_id, media_id)
        or can_read_media(db, viewer_id, media_id, include_tearing_down=True)
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
    _lock_authorized_media_for_filing(
        db,
        viewer_id,
        media_id,
        authorization="filable",
    )

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
        return LibraryFilingOutcome(kind="IncludedThroughPodcast")
    if not ctx.is_default and not entry_exists(db, library_id, target):
        _require_share_entitlement_for_access_increase(
            db, actor_user_id=viewer_id, library_id=library_id
        )
    inserted = ensure_entry(db, library_id, target)
    # Idempotent re-file clears a tombstone even when the entry already
    # existed (spec S4.3 rule 6 / AC4).
    clear_user_media_deletion(db, viewer_id, media_id)
    _bump_entry_visibility_revisions(db)

    return LibraryFilingOutcome(kind="Added" if inserted else "AlreadyPresent")


def ensure_media_absent_from_library_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID
) -> LibraryEntryRemovalOut:
    """Idempotently remove one Media from a mutable named Library."""
    return _ensure_media_absent_from_library_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        library_id=library_id,
        require_non_default_destination=True,
        retry_label="ensure_media_absent_from_library",
    )


def undo_media_filing_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID
) -> LibraryEntryRemovalOut:
    """Undo one agent-created media filing, including a direct Default filing."""
    return _ensure_media_absent_from_library_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        library_id=library_id,
        require_non_default_destination=False,
        retry_label="undo_media_filing",
    )


def _ensure_media_absent_from_library_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    library_id: UUID,
    require_non_default_destination: bool,
    retry_label: str,
) -> LibraryEntryRemovalOut:
    def outcome() -> LibraryEntryRemovalOut:
        return LibraryEntryRemovalOut(
            library_entries_collection_revision=read_collection_revision(
                db,
                viewer_id=viewer_id,
                family=CollectionFamily.LibraryEntries,
            )
        )

    def attempt() -> LibraryEntryRemovalOut:
        with transaction(db):
            context = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
            governance.require_admin(context.role)
            if require_non_default_destination:
                governance.require_non_default(context.is_default)
            governance.require_not_system(context.system_key)

            target = media_target(media_id)
            if not entry_exists(db, library_id, target):
                return outcome()

            if lock_media_rows_in_order(db, [media_id]) != [media_id]:
                if not entry_exists(db, library_id, target):
                    # Concurrent whole-resource or whole-library teardown also removes
                    # this entry. Its commit is a successful serial predecessor for this
                    # idempotent command.
                    return outcome()
                # justify-service-invariant-check: the initial target entry authorized
                # media reachability, so a missing media row is safe only after a fresh
                # READ COMMITTED statement confirms that entry disappeared with it.
                # justify-defect: non-cascading storage FKs forbid a live dangling entry.
                raise AssertionError("media library entry points at missing media")

            context = governance.lock_library_for_member(db, viewer_id, library_id)
            governance.require_admin(context.role)
            if require_non_default_destination:
                governance.require_non_default(context.is_default)
            governance.require_not_system(context.system_key)
            if not entry_exists(db, library_id, target):
                return outcome()

            raise_if_media_teardown_pending(db, media_id)
            reference_count = count_entries_for_media(db, media_id)
            if reference_count == 1:
                raise ConflictError(
                    ApiErrorCode.E_MEDIA_LAST_REFERENCE,
                    "Media must remain in at least one library",
                )
            if reference_count < 1:
                # justify-service-invariant-check: the locked target entry was re-read in
                # this transaction, so a zero count means the storage invariant is broken.
                # justify-defect: a present entry must contribute one lifetime reference.
                raise AssertionError("present media library entry was not counted")
            if not delete_entry(db, library_id, target):
                # justify-service-invariant-check: media and library row locks exclude every
                # supported concurrent remover after the immediately preceding re-read.
                # justify-defect: the exact entry cannot disappear while both locks are held.
                raise AssertionError("locked media library entry disappeared before delete")
            normalize_positions(db, library_id)
            _bump_entry_visibility_revisions(db)
            return outcome()

    return retry_read_committed(db, retry_label, attempt)


def seed_media_into_system_library(db: Session, library_id: UUID, media_id: UUID) -> bool:
    """The narrow trusted system command for corpus seeding (Oracle ingest, spec
    S4.3). No actor/membership authorization — the caller IS the trusted system
    boundary. The destination must already be a system library. Calls the same
    private insertion primitive (`ensure_entry`) as the actor-authorized filing
    command above, so the teardown barrier still runs before the library lock.
    Runs in the caller's transaction, like `ensure_entry` itself."""
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


def remove_podcast_from_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> PodcastPlacementRemovalOut:
    """Remove a podcast from a non-default library. Admin-only; default forbidden."""

    def attempt() -> PodcastPlacementRemovalOut:
        with transaction(db):
            db.execute(
                text("SELECT id FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
                {"podcast_id": podcast_id},
            ).first()
            ctx = governance.lock_library_for_member(db, viewer_id, library_id)
            governance.require_admin(ctx.role)
            governance.require_non_default(ctx.is_default)
            governance.require_not_system(ctx.system_key)
            removed = _remove_podcast_from_library_in_txn(
                db, library_id=library_id, podcast_id=podcast_id
            )
            if removed:
                _bump_entry_visibility_revisions(db)
            return PodcastPlacementRemovalOut(
                outcome="Removed" if removed else "AlreadyAbsent",
                library_entries_collection_revision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.LibraryEntries,
                ),
            )

    return retry_read_committed(db, "remove_podcast_from_library", attempt)


def _remove_podcast_from_library_in_txn(db: Session, *, library_id: UUID, podcast_id: UUID) -> bool:
    """Delete a podcast entry and renormalize; return whether a row went. Shared by the
    single-library remove and the unsubscribe teardown (caller's transaction)."""
    removed = delete_entry(db, library_id, podcast_target(podcast_id))
    if removed:
        normalize_positions(db, library_id)
    return removed


def undo_podcast_filing_for_viewer_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> PodcastPlacementRemovalOut:
    """Undo one agent-created Podcast placement inside the agent transaction."""
    db.execute(
        text("SELECT id FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": podcast_id},
    ).first()
    context = governance.lock_library_for_member(db, viewer_id, library_id)
    governance.require_admin(context.role)
    governance.require_non_default(context.is_default)
    governance.require_not_system(context.system_key)
    removed = _remove_podcast_from_library_in_txn(
        db,
        library_id=library_id,
        podcast_id=podcast_id,
    )
    if removed:
        _bump_entry_visibility_revisions(db)
    return PodcastPlacementRemovalOut(
        outcome="Removed" if removed else "AlreadyAbsent",
        library_entries_collection_revision=read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
        ),
    )


def _podcast_child_conflict_rows(
    db: Session,
    *,
    podcast_id: UUID,
    library_ids: Sequence[UUID],
) -> list[Any]:
    if not library_ids:
        return []
    return list(
        db.execute(
            text(
                """
                SELECT
                    le.id AS entry_id,
                    le.library_id,
                    le.media_id,
                    le.position
                FROM library_entries le
                JOIN podcast_episodes pe ON pe.media_id = le.media_id
                WHERE pe.podcast_id = :podcast_id
                  AND le.library_id = ANY(:library_ids)
                ORDER BY le.media_id, le.library_id, le.id
                """
            ),
            {
                "podcast_id": podcast_id,
                "library_ids": list(library_ids),
            },
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
    key = base64.b64decode(
        get_settings().effective_stream_token_signing_key,
        validate=True,
    )
    return hmac.new(
        key,
        b"nexus-podcast-placement-conflict\0" + payload,
        hashlib.sha256,
    ).hexdigest()


def place_podcast_in_named_libraries_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    library_ids: list[UUID],
    confirmation_fingerprint: str | None,
) -> PodcastPlacementResult:
    targets = governance.resolve_writable_non_default_library_ids(
        db,
        viewer_id,
        library_ids,
    )
    podcast = db.execute(
        text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
        {"podcast_id": podcast_id},
    ).fetchone()
    if podcast is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

    conflict_rows = _podcast_child_conflict_rows(
        db,
        podcast_id=podcast_id,
        library_ids=targets,
    )
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

    current_conflicts = _podcast_child_conflict_rows(
        db,
        podcast_id=podcast_id,
        library_ids=targets,
    )
    if {UUID(str(row["entry_id"])) for row in current_conflicts} != {
        UUID(str(row["entry_id"])) for row in conflict_rows
    }:
        raise TransactionRestart("Podcast child entry set changed")

    fingerprint = _podcast_placement_conflict_fingerprint(
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        library_ids=targets,
        entry_ids=[UUID(str(row["entry_id"])) for row in current_conflicts],
    )
    if current_conflicts and confirmation_fingerprint != fingerprint:
        counts: dict[UUID, int] = {}
        for row in current_conflicts:
            library_id = UUID(str(row["library_id"]))
            counts[library_id] = counts.get(library_id, 0) + 1
        conflicts = [
            {
                "libraryId": str(library_id),
                "libraryName": contexts[library_id].name,
                "episodeCount": counts[library_id],
            }
            for library_id in targets
            if library_id in counts
        ]
        raise ConflictError(
            ApiErrorCode.E_PODCAST_REPLACES_EPISODES,
            "Podcast placement replaces direct episode placements",
            details={
                "conflicts": conflicts,
                "conflictFingerprint": fingerprint,
            },
        )

    conflicts_by_library: dict[UUID, list[UUID]] = {}
    earliest_position: dict[UUID, int] = {}
    for row in current_conflicts:
        library_id = UUID(str(row["library_id"]))
        conflicts_by_library.setdefault(library_id, []).append(UUID(str(row["entry_id"])))
        position = int(row["position"])
        earliest_position[library_id] = min(
            earliest_position.get(library_id, position),
            position,
        )

    added: list[UUID] = []
    present: list[UUID] = []
    for library_id in targets:
        target = podcast_target(podcast_id)
        if entry_exists(db, library_id, target):
            present.append(library_id)
            continue
        _require_share_entitlement_for_access_increase(
            db,
            actor_user_id=viewer_id,
            library_id=library_id,
        )
        position = earliest_position.get(library_id, _next_position(db, library_id))
        db.execute(
            text(
                """
                INSERT INTO library_entries (
                    library_id, media_id, podcast_id, position
                )
                VALUES (:library_id, NULL, :podcast_id, :position)
                """
            ),
            {
                "library_id": library_id,
                "podcast_id": podcast_id,
                "position": position,
            },
        )
        added.append(library_id)

    for media_id in child_media_ids:
        ensure_entry(db, default_library_id, media_target(media_id))
    if current_conflicts:
        db.execute(
            text(
                """
                DELETE FROM library_entries
                WHERE id = ANY(:entry_ids)
                """
            ),
            {"entry_ids": [UUID(str(row["entry_id"])) for row in current_conflicts]},
        )
    for library_id in targets:
        if library_id in conflicts_by_library:
            normalize_positions(db, library_id)
    if added or current_conflicts:
        _bump_entry_visibility_revisions(db)
    return PodcastPlacementResult(
        added_library_ids=tuple(added),
        already_present_library_ids=tuple(present),
    )


def place_subscribed_podcast_in_named_library_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> LibraryFilingOutcome:
    """File one active subscription through the canonical Podcast placement owner."""
    subscription = db.execute(
        text(
            """
            SELECT id
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id
              AND podcast_id = :podcast_id
            FOR UPDATE
            """
        ),
        {
            "viewer_id": viewer_id,
            "podcast_id": podcast_id,
        },
    ).first()
    if subscription is None:
        raise ConflictError(
            ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED,
            "Subscribe to this Podcast before adding it to a Library",
        )
    placement = place_podcast_in_named_libraries_in_current_transaction(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        library_ids=[library_id],
        confirmation_fingerprint=None,
    )
    return LibraryFilingOutcome(kind="Added" if placement.added_library_ids else "AlreadyPresent")


def place_subscribed_podcast_in_named_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> PodcastPlacementAdditionOut:
    """Idempotently place, but never create, an active Podcast subscription."""

    def attempt() -> PodcastPlacementAdditionOut:
        with transaction(db):
            filing = place_subscribed_podcast_in_named_library_in_current_transaction(
                db,
                viewer_id=viewer_id,
                library_id=library_id,
                podcast_id=podcast_id,
            )
            if filing.kind == "IncludedThroughPodcast":
                # justify-service-invariant-check: Podcast filing returns only its
                # two direct placement outcomes.
                # justify-defect: inherited-through-Podcast applies only to Media.
                raise AssertionError("Podcast placement produced a Media-only outcome")
            return PodcastPlacementAdditionOut(
                outcome=filing.kind,
                library_entries_collection_revision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.LibraryEntries,
                ),
            )

    return retry_read_committed(db, "place_subscribed_podcast_in_named_library", attempt)


def remove_unsubscribed_podcast_placements(
    db: Session, *, viewer_id: UUID, podcast_id: UUID
) -> PodcastLibraryRemovalResult:
    """Sole owner of the unsubscribe library teardown. Classifies the viewer's
    library_entries for this podcast (admin-owned non-default → removable; foreign-owned
    shared → retained and counted), deletes the removable entries, and renormalizes each
    affected library via the one canonical ordering. Runs in the caller's transaction."""
    snapshot_library_ids = sorted(
        {
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    """
                    SELECT entry.library_id
                    FROM library_entries entry
                    JOIN memberships membership
                      ON membership.library_id = entry.library_id
                     AND membership.user_id = :viewer_id
                    WHERE entry.podcast_id = :podcast_id
                    """
                ),
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
                    SELECT COUNT(*)
                    FROM memberships other_membership
                    WHERE other_membership.library_id = l.id
                ) AS member_count
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id
            JOIN memberships m
              ON m.library_id = le.library_id AND m.user_id = :viewer_id
            WHERE le.podcast_id = :podcast_id
            FOR UPDATE OF le
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchall()
    current_library_ids = sorted({UUID(str(row[0])) for row in rows})
    if current_library_ids != snapshot_library_ids:
        raise TransactionRestart("Podcast placement Library set changed")

    removable_library_ids: set[UUID] = set()
    retained_shared_library_count = 0
    for library_id, owner_user_id, is_default, member_count in rows:
        if bool(is_default):
            continue
        if owner_user_id == viewer_id and int(member_count) == 1:
            removable_library_ids.add(UUID(str(library_id)))
        else:
            retained_shared_library_count += 1

    for library_id in sorted(removable_library_ids):
        if not delete_entry(db, library_id, podcast_target(podcast_id)):
            raise AssertionError("locked Podcast placement disappeared before unsubscribe delete")
        normalize_positions(db, library_id)
    if removable_library_ids:
        _bump_entry_visibility_revisions(db)

    return PodcastLibraryRemovalResult(
        removed_from_library_count=len(removable_library_ids),
        retained_shared_library_count=retained_shared_library_count,
    )


def reorder_entries(
    db: Session, viewer_id: UUID, library_id: UUID, body: LibraryEntryOrderRequest
) -> None:
    """Replace the full entry order for an admin viewer. The requested set must equal the
    existing set; the new order is applied in one set-based statement (already dense, so
    no follow-up renormalize). Default has no physical order to reorder — it is
    a live virtual view — so it is rejected here before exact-set validation
    (spec AC8)."""
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)

        existing_ids = [
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    f"SELECT id FROM library_entries WHERE library_id = :library_id ORDER BY {_ENTRY_ORDER}"
                ),
                {"library_id": library_id},
            ).fetchall()
        ]
        requested_ids = [UUID(str(entry_id)) for entry_id in body.entry_ids]
        if len(existing_ids) != len(requested_ids) or set(existing_ids) != set(requested_ids):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Library reorder requires an exact full set of entry IDs",
            )

        result = cast(
            CursorResult[Any],
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
            ),
        )
        if result.rowcount != len(requested_ids):
            # justify-service-invariant-check: exact-set validation and the library
            # lock establish cardinality, but affected-row metadata is runtime-only.
            # justify-defect: a mismatch means the locked order invariant was violated.
            raise AssertionError(
                f"Library reorder affected {result.rowcount} rows; expected {len(requested_ids)}"
            )
        _bump_entry_visibility_revisions(db)


# ---------------------------------------------------------------------------
# Default-library + bulk assignment commands
# ---------------------------------------------------------------------------


def ensure_media_saved_in_nexus_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> LibraryFilingOutcome:
    """Idempotently create the identity-free ``SavedInNexus`` relation."""
    return ensure_media_in_library(
        db,
        viewer_id,
        governance.default_library_id_for_user(db, viewer_id),
        media_id,
    )


def ensure_media_absent_from_saved_in_nexus_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> LibraryEntryRemovalOut:
    """Idempotently remove ``SavedInNexus`` while preserving lifetime safety."""
    return _ensure_media_absent_from_library_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        library_id=governance.default_library_id_for_user(db, viewer_id),
        require_non_default_destination=False,
        retry_label="ensure_media_absent_from_saved_in_nexus",
    )


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> bool:
    """Ensure media has a direct physical entry in the user's default library."""
    from nexus.services.media_deletion import clear_user_media_deletion

    default_library_id = governance.default_library_id_for_user(db, user_id)
    inserted = ensure_entry(db, default_library_id, media_target(media_id))
    clear_user_media_deletion(db, user_id, media_id)
    if inserted:
        _bump_entry_visibility_revisions(db)
    return inserted


def ensure_media_in_libraries_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """Verify the viewer can file the media, then add selected writable destinations."""
    with transaction(db):
        media_exists = db.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).fetchone()
        if media_exists is None or not (
            can_restore_media(db, viewer_id, media_id)
            or can_read_media(db, viewer_id, media_id, include_tearing_down=True)
        ):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
        _lock_authorized_media_for_filing(
            db,
            viewer_id,
            media_id,
            authorization="filable",
        )
        targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
        _add_media_to_resolved_libraries(
            db,
            viewer_id,
            media_id,
            targets,
            parent_podcast_id=parent_podcast_id,
        )
        _bump_entry_visibility_revisions(db)


def _add_media_to_resolved_libraries(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_ids: list[UUID],
    *,
    parent_podcast_id: UUID | None,
) -> None:
    if not library_ids:
        return
    from nexus.services.media_deletion import clear_user_media_deletion

    # The media-teardown barrier must run before any library lock (spec S4.3),
    # so this locks/checks the media row FIRST — matching ensure_media_in_library's
    # mandated media->library order and avoiding an AB-BA deadlock against it.
    raise_if_media_teardown_pending(db, media_id)
    locked_contexts = {
        library_id: governance.lock_library_for_member(db, viewer_id, library_id)
        for library_id in sorted(library_ids)
    }
    for ctx in locked_contexts.values():
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
    for library_id in library_ids:
        if parent_podcast_id is None or not entry_exists(
            db, library_id, podcast_target(parent_podcast_id)
        ):
            ensure_entry(db, library_id, target)
    clear_user_media_deletion(db, viewer_id, media_id)


def assign_libraries_for_media_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
    default_library_id = governance.default_library_id_for_user(db, viewer_id)
    parent_podcast_id = _lock_parent_podcast_for_media(db, media_id)
    raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id, *targets])
    ensure_media_in_default_library(db, viewer_id, media_id)
    _add_media_to_resolved_libraries(
        db,
        viewer_id,
        media_id,
        targets,
        parent_podcast_id=parent_podcast_id,
    )
    _bump_entry_visibility_revisions(db)


def ensure_subscription_episode_default_in_current_transaction(
    db: Session,
    subscription_user_id: UUID,
    subscription_podcast_id: UUID,
    media_id: UUID,
) -> bool:
    """Ensure one acquired episode is in All; named Podcast placement is not closure."""
    locked_podcast_id = _lock_parent_podcast_for_media(db, media_id)
    if locked_podcast_id != subscription_podcast_id:
        # justify-service-invariant-check: the caller carries the subscription's
        # Podcast id separately from the episode's FK.
        # justify-defect: ingest routed one episode through the wrong Podcast.
        raise AssertionError("subscription episode Podcast identity mismatch")
    if lock_media_rows_in_order(db, [media_id]) != [media_id]:
        raise AssertionError("subscription episode Media disappeared during filing")
    default_library_id = governance.default_library_id_for_user(db, subscription_user_id)
    raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id])
    inserted = ensure_media_in_default_library(db, subscription_user_id, media_id)
    _bump_entry_visibility_revisions(db)
    return inserted


# ---------------------------------------------------------------------------
# Catalog-facing reads (podcast subscriptions surfaces)
# ---------------------------------------------------------------------------


def podcast_ids_in_libraries_for_viewer(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> set[UUID]:
    """Podcast ids the viewer can see in non-default libraries. With `library_id` set,
    scoped to that library; with None, spans every visible non-default library."""
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
