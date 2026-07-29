"""Library entries: the `library_entries` table — sole writer and lifecycle owner.

Every INSERT/UPDATE/DELETE on `library_entries`, the entry-kind polymorphism, the
position total order, hydration, and the item-in-library commands live here. Other
modules call this module's public API; none issue `library_entries` DML directly.
The visibility readers in `auth/permissions.py` and the search/object modules read
the table under an explicit allowlist (see the cutover spec).
"""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
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
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    ParsedCollectionQuery,
    parse_collection_query,
)
from nexus.schemas.library import (
    LibraryEntryKind,
    LibraryEntryListItemOut,
    LibraryEntryMediaCapabilitiesOut,
    LibraryEntryMediaOut,
    LibraryEntryOrderRequest,
    LibraryEntryPodcastOut,
    LibraryEntryPodcastSubscriptionOut,
    LibraryEntryRemovalOut,
    LibraryMediaListItemOut,
    LibraryPlacementOptionOut,
    LibraryPodcastListItemOut,
    ReadingTimeEstimateOut,
)
from nexus.schemas.podcast import PodcastSubscriptionVisibleLibraryOut
from nexus.schemas.presence import Presence, absent, present
from nexus.services import library_governance as governance
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import (
    load_contributor_credits_for_podcasts,
    primary_creator_rows_sql,
)
from nexus.services.media_document_metrics import load_media_word_counts
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

# Mirrors index ix_library_entries_library_order (library_id, position, created_at DESC,
# id DESC). The single definition of the entry total order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"
_ENTRY_COLUMNS = "id, library_id, media_id, podcast_id, created_at, position"
_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}

_READING_WORDS_PER_MINUTE = 240
_READING_MINUTES_FINE_LIMIT = 10
_READING_MINUTES_COARSE_LIMIT = 60


def _bump_entry_visibility_revisions(db: Session) -> None:
    """Invalidate every finite inventory whose membership can change via filing."""
    for family in (
        CollectionFamily.AuthorWorks,
        CollectionFamily.LibraryEntries,
        CollectionFamily.PodcastSubscriptions,
        CollectionFamily.PodcastEpisodes,
    ):
        bump_all_collection_revisions(db, family=family)


# ---------------------------------------------------------------------------
# Library view lenses — closed order/projection types and strict query parsing
# ---------------------------------------------------------------------------

type Direction = Literal["asc", "desc"]


@dataclass(frozen=True, slots=True)
class Canonical:
    """Durable authored order: Default's `media.created_at DESC`, else position."""


@dataclass(frozen=True, slots=True)
class Title:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Creator:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Published:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Added:
    direction: Direction


type LibraryEntryOrder = Canonical | Title | Creator | Published | Added
type Completion = Literal["all", "unfinished"]


@dataclass(frozen=True, slots=True)
class AllItems:
    """The complete current entry set, optionally hiding finished media."""

    completion: Completion


@dataclass(frozen=True, slots=True)
class Unfiled:
    """Default-only: direct-Default media with no other non-system placement."""

    completion: Completion


@dataclass(frozen=True, slots=True)
class InProgress:
    """Media whose canonical read_state is InProgress. The absence of a
    ``completion`` field makes ``InProgress + Unfinished`` unrepresentable."""


type LibraryEntryProjection = AllItems | Unfiled | InProgress


@dataclass(frozen=True, slots=True)
class LibraryEntryView:
    order: LibraryEntryOrder
    projection: LibraryEntryProjection


_VIEW_QUERY_KEYS = frozenset({"sort", "direction", "completion", "projection"})
_FACTUAL_SORTS: dict[str, type[Title | Creator | Published | Added]] = {
    "title": Title,
    "creator": Creator,
    "published": Published,
    "added": Added,
}
_DEFAULT_LIMIT = 100
_MAX_LIMIT = 200


def parse_entries_query(
    items: Sequence[tuple[str, str]],
) -> tuple[LibraryEntryView, ParsedCollectionQuery]:
    """Strict entry-view query parse (spec API validation). ``items`` is the
    request's ``multi_items()`` so duplicate keys are visible. Every malformed
    request — unknown/duplicate key, factual sort without direction, direction
    without a factual sort, unsupported sort/completion, bad/non-positive limit —
    is ``E_INVALID_REQUEST``. Cursor validity is checked separately at decode."""
    query = parse_collection_query(items, domain_keys=_VIEW_QUERY_KEYS)
    order = _parse_order(query.parameters.get("sort"), query.parameters.get("direction"))
    completion = _parse_completion(query.parameters.get("completion"))
    projection = _parse_projection(query.parameters.get("projection"), completion)
    return LibraryEntryView(order=order, projection=projection), query


def _parse_projection(value: str | None, completion: Completion) -> LibraryEntryProjection:
    """Build the projection from the raw ``projection`` value and the already
    parsed completion. Omitted projection means ``AllItems``. ``in-progress``
    cannot carry completion (the union makes ``InProgress + Unfinished``
    unrepresentable). The Unfiled-only-for-Default rule needs viewer/library
    context and is enforced by the service, not here."""
    if value is None:
        return AllItems(completion)
    if value == "unfiled":
        return Unfiled(completion)
    if value == "in-progress":
        if completion == "unfinished":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "In Progress cannot filter completion"
            )
        return InProgress()
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported projection")


def _parse_order(sort: str | None, direction: str | None) -> LibraryEntryOrder:
    if sort is None:
        if direction is not None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "direction requires a factual sort"
            )
        return Canonical()
    variant = _FACTUAL_SORTS.get(sort)
    if variant is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported sort")
    if direction != "asc" and direction != "desc":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Factual sort requires direction asc or desc"
        )
    return variant(direction)


def _parse_completion(value: str | None) -> Completion:
    if value is None:
        return "all"
    if value == "unfinished":
        return "unfinished"
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported completion")


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
                    {consumption_service.engagement_fact_rows_sql()}
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


@dataclass(frozen=True, slots=True)
class LibraryEntryHydrationFact:
    """Typed owner input for strict cross-service Library entry hydration."""

    id: UUID
    library_id: UUID
    target: EntryTarget
    created_at: datetime
    position: int


@dataclass(frozen=True)
class PodcastLibraryRemovalResult:
    removed_from_library_count: int
    retained_shared_library_count: int


@dataclass(frozen=True)
class LibraryFilingOutcome:
    """The idempotent inserted-only outcome a filing command returns.

    `inserted` is False when the physical entry already existed
    (re-file/idempotent path); `agent_tools.writes` reads it so Undo never
    deletes a filing it did not itself create.
    """

    inserted: bool


def _display_reading_minutes(word_count: int, fraction: float) -> int:
    raw_minutes = word_count * fraction / _READING_WORDS_PER_MINUTE
    if raw_minutes < _READING_MINUTES_FINE_LIMIT:
        quantum = 1
    elif raw_minutes < _READING_MINUTES_COARSE_LIMIT:
        quantum = 5
    else:
        quantum = 15
    return max(1, quantum * math.floor(raw_minutes / quantum + 0.5))


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
# Hydration
# ---------------------------------------------------------------------------


def hydrate_entry_page(
    db: Session,
    *,
    viewer_id: UUID,
    facts: Sequence[LibraryEntryHydrationFact],
) -> list[LibraryEntryListItemOut]:
    """Strictly hydrate already-visible facts supplied across an owner boundary."""
    rows = [
        {
            "id": fact.id,
            "library_id": fact.library_id,
            "media_id": fact.target.id if fact.target.kind == "media" else None,
            "podcast_id": fact.target.id if fact.target.kind == "podcast" else None,
            "created_at": fact.created_at,
            "position": fact.position,
        }
        for fact in facts
    ]
    entries = _hydrate_entry_rows(db, viewer_id=viewer_id, rows=rows)
    expected_ids = [fact.id for fact in facts]
    actual_ids = [entry.id for entry in entries]
    if actual_ids != expected_ids:
        # justify-defect: the composing repeatable-read query already proved every
        # typed target visible; hydration must preserve its exact cardinality/order.
        raise AssertionError(
            f"Library entry hydration drifted: expected {expected_ids}, got {actual_ids}"
        )
    return entries


def _hydrate_entry_rows(
    db: Session, *, viewer_id: UUID, rows: Sequence[Any]
) -> list[LibraryEntryListItemOut]:
    """Hydrate name-keyed entry rows into the compact Library list union, batching
    the media and podcast lookups. Entries whose target is not viewer-visible drop out."""
    if not rows:
        return []

    media_ids = [UUID(str(row["media_id"])) for row in rows if row["media_id"] is not None]
    podcast_ids = [UUID(str(row["podcast_id"])) for row in rows if row["podcast_id"] is not None]

    media_by_id = {}
    if media_ids:
        from nexus.services import media as media_service

        media_by_id = {
            media.id: media
            for media in media_service.list_collection_media_for_viewer_by_ids(
                db,
                viewer_id=viewer_id,
                media_ids=media_ids,
            )
        }

    audio_media_ids = [
        media.id for media in media_by_id.values() if media.listening_state is not None
    ]
    document_media_ids = [
        media.id for media in media_by_id.values() if media.listening_state is None
    ]
    last_engaged_at_by_media_id = consumption_service.listening_recency(
        db,
        viewer_id=viewer_id,
        media_ids=audio_media_ids,
    )
    last_engaged_at_by_media_id.update(
        consumption_service.reader_engagement_recency(
            db,
            viewer_id=viewer_id,
            media_ids=document_media_ids,
        )
    )

    eligible_media_ids = [
        media.id
        for media in media_by_id.values()
        if media.kind in ("web_article", "epub", "pdf") and media.capabilities.can_quote
    ]
    word_counts = load_media_word_counts(db, eligible_media_ids) if eligible_media_ids else {}
    reading_time_by_media_id: dict[UUID, ReadingTimeEstimateOut] = {}
    for media_id in eligible_media_ids:
        word_count = word_counts[media_id]
        if word_count == 0:
            continue
        media = media_by_id[media_id]
        total_minutes = _display_reading_minutes(word_count, 1.0)
        remaining_minutes: Presence[int] = absent()
        if (
            media.kind in ("web_article", "epub")
            and media.read_state == "in_progress"
            and media.progress_fraction is not None
        ):
            remaining = _display_reading_minutes(word_count, 1.0 - media.progress_fraction)
            if remaining > total_minutes:
                # justify-service-invariant-check: the relationship between two
                # derived rounded values is not expressible in their integer types.
                # justify-defect: bounded progression and monotonic rounding guarantee it.
                raise AssertionError(f"remaining reading time exceeds total for media {media_id}")
            remaining_minutes = present(remaining)
        reading_time_by_media_id[media_id] = ReadingTimeEstimateOut(
            total_minutes=total_minutes,
            remaining_minutes=remaining_minutes,
        )

    podcast_rows_by_id = {}
    if podcast_ids:
        podcast_rows = (
            db.execute(
                text(f"""
                WITH visible_media AS (
                    {visible_media_ids_cte_sql()}
                ),
                podcast_unplayed AS (
                    SELECT
                        pe.podcast_id,
                        COUNT(*) FILTER (
                            WHERE {
                    consumption_service.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } = 'unplayed'
                        ) AS unplayed_count
                    FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    {
                    consumption_service.episode_state_joins_sql(
                        user_param=":viewer_id",
                        media_expr="pe.media_id",
                        listening_alias="pls",
                        override_alias="co",
                    )
                }
                    WHERE pe.podcast_id = ANY(:podcast_ids)
                    GROUP BY pe.podcast_id
                )
                SELECT
                    p.id AS podcast_id,
                    p.title AS title,
                    COALESCE(pu.unplayed_count, 0) AS unplayed_count,
                    ps.status AS sub_status,
                    ps.default_playback_speed AS sub_default_playback_speed,
                    ps.auto_queue AS sub_auto_queue,
                    ps.sync_status AS sub_sync_status
                FROM podcasts p
                LEFT JOIN podcast_unplayed pu ON pu.podcast_id = p.id
                LEFT JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id AND ps.user_id = :viewer_id
                WHERE p.id = ANY(:podcast_ids)
            """),
                {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
            )
            .mappings()
            .all()
        )
        podcast_rows_by_id = {UUID(str(row["podcast_id"])): row for row in podcast_rows}
    contributors_by_podcast_id = load_contributor_credits_for_podcasts(db, podcast_ids)

    hydrated: list[LibraryEntryListItemOut] = []
    for row in rows:
        media_id = UUID(str(row["media_id"])) if row["media_id"] is not None else None
        podcast_id = UUID(str(row["podcast_id"])) if row["podcast_id"] is not None else None
        if media_id is not None:
            media = media_by_id.get(media_id)
            if media is None:
                continue
            hydrated.append(
                LibraryMediaListItemOut(
                    id=UUID(str(row["id"])),
                    kind="media",
                    position=int(row["position"]),
                    created_at=row["created_at"],
                    media=LibraryEntryMediaOut(
                        id=media.id,
                        kind=cast(
                            "Literal['web_article', 'epub', 'pdf', 'podcast_episode', 'video']",
                            media.kind,
                        ),
                        title=media.title,
                        created_at=media.created_at,
                        contributors=media.contributors,
                        author_mode=media.author_mode,
                        published_date=media.published_date,
                        canonical_source_url=media.canonical_source_url,
                        processing_status=media.processing_status,
                        read_state=media.read_state,
                        progress_fraction=media.progress_fraction,
                        progress_resettable=media.progress_resettable,
                        last_engaged_at=last_engaged_at_by_media_id.get(media.id),
                        capabilities=LibraryEntryMediaCapabilitiesOut(
                            can_quote=media.capabilities.can_quote,
                            can_retry=media.capabilities.can_retry,
                            can_refresh_source=media.capabilities.can_refresh_source,
                            can_retry_metadata=media.capabilities.can_retry_metadata,
                            can_edit_authors=media.capabilities.can_edit_authors,
                            can_delete=media.capabilities.can_delete,
                        ),
                    ),
                    reading_time_estimate=(
                        present(reading_time_by_media_id[media_id])
                        if media_id in reading_time_by_media_id
                        else absent()
                    ),
                )
            )
            continue

        if podcast_id is None:
            continue
        podcast_row = podcast_rows_by_id.get(podcast_id)
        if podcast_row is None:
            continue

        subscription = None
        if podcast_row["sub_status"] is not None:
            subscription = LibraryEntryPodcastSubscriptionOut(
                status=podcast_row["sub_status"],
                default_playback_speed=float(podcast_row["sub_default_playback_speed"])
                if podcast_row["sub_default_playback_speed"] is not None
                else None,
                auto_queue=bool(podcast_row["sub_auto_queue"]),
                sync_status=podcast_row["sub_sync_status"],
            )

        hydrated.append(
            LibraryPodcastListItemOut(
                id=UUID(str(row["id"])),
                kind="podcast",
                position=int(row["position"]),
                created_at=row["created_at"],
                podcast=LibraryEntryPodcastOut(
                    id=podcast_id,
                    title=podcast_row["title"],
                    contributors=contributors_by_podcast_id.get(podcast_id, []),
                    unplayed_count=int(podcast_row["unplayed_count"] or 0),
                ),
                subscription=subscription,
                reading_time_estimate=absent(),
            )
        )

    return hydrated


# ---------------------------------------------------------------------------
# Item-in-library commands
# ---------------------------------------------------------------------------


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> list[LibraryPlacementOptionOut]:
    """Per-library placement options for one media or podcast."""
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
    rows = (
        db.execute(
            text(f"""
            SELECT
                l.id, l.name, l.color,
                EXISTS(
                    SELECT 1 FROM library_entries le
                    WHERE le.library_id = l.id AND le.{column} = :target_id
                ) AS in_library,
                m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.is_default = false
              AND l.system_key IS NULL
            ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC
        """),
            {"viewer_id": viewer_id, "target_id": target.id},
        )
        .mappings()
        .all()
    )

    return [
        LibraryPlacementOptionOut(
            id=row["id"],
            name=row["name"],
            color=row["color"],
            is_in_library=bool(row["in_library"]),
            can_add=(
                target_can_be_added and row["role"] == "admin" and not bool(row["in_library"])
            ),
            can_remove=row["role"] == "admin" and bool(row["in_library"]),
        )
        for row in rows
    ]


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

    Ordering is load-bearing: the media-teardown barrier must run before any
    library lock (spec S3/S4.3), so this locks/checks the media row FIRST and
    only then locks/revalidates the destination library.
    """
    from nexus.services.media_deletion import clear_user_media_deletion

    with transaction(db):
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
        if not ctx.is_default and not entry_exists(db, library_id, target):
            _require_share_entitlement_for_access_increase(
                db, actor_user_id=viewer_id, library_id=library_id
            )
        inserted = ensure_entry(db, library_id, target)
        # Idempotent re-file clears a tombstone even when the entry already
        # existed (spec S4.3 rule 6 / AC4).
        clear_user_media_deletion(db, viewer_id, media_id)
        _bump_entry_visibility_revisions(db)

    return LibraryFilingOutcome(inserted=inserted)


def ensure_media_absent_from_library_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_id: UUID
) -> LibraryEntryRemovalOut:
    """Idempotently remove one media from a writable non-default library."""
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


def add_podcast_to_library(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> LibraryFilingOutcome:
    """Add a podcast to a non-default library. Admin-only; default forbidden
    (spec S4.3 rule 4); requires an ACTIVE subscription. No closure."""
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)

        podcast_row = db.execute(
            text("""
                SELECT p.id
                FROM podcasts p
                JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id AND ps.user_id = :viewer_id AND ps.status = 'active'
                WHERE p.id = :podcast_id
            """),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        ).fetchone()
        if podcast_row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Active podcast subscription not found")

        target = podcast_target(podcast_id)
        if not entry_exists(db, library_id, target):
            _require_share_entitlement_for_access_increase(
                db, actor_user_id=viewer_id, library_id=library_id
            )
        inserted = ensure_entry(db, library_id, target)
        if inserted:
            _bump_entry_visibility_revisions(db)
    return LibraryFilingOutcome(inserted=inserted)


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
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> LibraryEntryRemovalOut:
    """Remove a podcast from a non-default library. Admin-only; default forbidden."""
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)
        if not _remove_podcast_from_library_in_txn(
            db, library_id=library_id, podcast_id=podcast_id
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found in library")
        _bump_entry_visibility_revisions(db)
        return LibraryEntryRemovalOut(
            library_entries_collection_revision=read_collection_revision(
                db,
                viewer_id=viewer_id,
                family=CollectionFamily.LibraryEntries,
            )
        )


def _remove_podcast_from_library_in_txn(db: Session, *, library_id: UUID, podcast_id: UUID) -> bool:
    """Delete a podcast entry and renormalize; return whether a row went. Shared by the
    single-library remove and the unsubscribe teardown (caller's transaction)."""
    removed = delete_entry(db, library_id, podcast_target(podcast_id))
    if removed:
        normalize_positions(db, library_id)
    return removed


def remove_user_podcast_subscription_libraries(
    db: Session, *, viewer_id: UUID, podcast_id: UUID
) -> PodcastLibraryRemovalResult:
    """Sole owner of the unsubscribe library teardown. Classifies the viewer's
    library_entries for this podcast (admin-owned non-default → removable; foreign-owned
    shared → retained and counted), deletes the removable entries, and renormalizes each
    affected library via the one canonical ordering. Runs in the caller's transaction."""
    rows = db.execute(
        text("""
            SELECT le.library_id, l.owner_user_id, l.is_default, m.role
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id
            JOIN memberships m
              ON m.library_id = le.library_id AND m.user_id = :viewer_id
            WHERE le.podcast_id = :podcast_id
            FOR UPDATE OF le
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchall()

    removable_library_ids: set[UUID] = set()
    retained_shared_library_count = 0
    for library_id, owner_user_id, is_default, role in rows:
        if bool(is_default):
            continue
        if str(role) == "admin":
            removable_library_ids.add(UUID(str(library_id)))
        elif owner_user_id != viewer_id:
            retained_shared_library_count += 1

    for library_id in sorted(removable_library_ids):
        delete_entry(db, library_id, podcast_target(podcast_id))
        normalize_positions(db, library_id)
    if removable_library_ids:
        _bump_entry_visibility_revisions(db)

    return PodcastLibraryRemovalResult(
        removed_from_library_count=len(removable_library_ids),
        retained_shared_library_count=retained_shared_library_count,
    )


@dataclass(frozen=True, slots=True)
class _SortKey:
    """One key of a total keyset order: a facts-CTE column (== cursor `after`
    key), its direction, and how the value round-trips through the cursor."""

    column: str
    direction: Direction
    value: KeysetValueKind


def _plan(order: LibraryEntryOrder, *, is_default: bool) -> list[_SortKey]:
    """The total, stable sort-key plan that drives ORDER BY, the keyset, and the
    cursor `after`. The identity tie-break is ALWAYS ``sort_identity DESC``
    (stable regardless of primary direction); missing-rank keys are ALWAYS ASC so
    missing sorts last in both directions (0=present, 1=missing)."""
    identity = _SortKey("sort_identity", "desc", KeysetValueKind.Uuid)
    match order:
        case Canonical():
            if is_default:
                return [
                    _SortKey("media_created_at", "desc", KeysetValueKind.DateTime),
                    identity,
                ]
            return [
                _SortKey("position", "asc", KeysetValueKind.Int),
                _SortKey("created_at", "desc", KeysetValueKind.DateTime),
                identity,
            ]
        case Title(direction):
            return [_SortKey("title_key", direction, KeysetValueKind.Text), identity]
        case Creator(direction):
            return [
                _SortKey("creator_missing", "asc", KeysetValueKind.Int),
                _SortKey("creator_name", direction, KeysetValueKind.TextOrNull),
                _SortKey("title_key", "asc", KeysetValueKind.Text),
                identity,
            ]
        case Published(direction):
            return [
                _SortKey("published_missing", "asc", KeysetValueKind.Int),
                _SortKey("published_date", direction, KeysetValueKind.TextOrNull),
                _SortKey("title_key", "asc", KeysetValueKind.Text),
                identity,
            ]
        case Added(direction):
            return [_SortKey("added_at", direction, KeysetValueKind.DateTime), identity]
        case _:
            assert_never(order)


def _keyset_clause(plan: Sequence[_SortKey]) -> str:
    """Generic strict keyset over the plan. Equality via ``IS NOT DISTINCT FROM``
    is NULL-safe; strict ``<``/``>`` on a NULL bound yields NULL (false), which is
    correct because the leading missing-rank key already partitions the
    present/missing buckets before any nullable value key is compared."""
    ors = []
    for i, key in enumerate(plan):
        conj = [f"facts.{p.column} IS NOT DISTINCT FROM :ks_{p.column}" for p in plan[:i]]
        op = ">" if key.direction == "asc" else "<"
        conj.append(f"facts.{key.column} {op} :ks_{key.column}")
        ors.append("(" + " AND ".join(conj) + ")")
    return "AND (" + " OR ".join(ors) + ")"


def _order_json(order: LibraryEntryOrder) -> dict[str, str]:
    match order:
        case Canonical():
            return {"sort": "canonical"}
        case Title(direction):
            return {"sort": "title", "direction": direction}
        case Creator(direction):
            return {"sort": "creator", "direction": direction}
        case Published(direction):
            return {"sort": "published", "direction": direction}
        case Added(direction):
            return {"sort": "added", "direction": direction}
        case _:
            assert_never(order)


def _projection_json(projection: LibraryEntryProjection) -> dict[str, str]:
    match projection:
        case AllItems(completion):
            return {"completion": completion, "kind": "all-items"}
        case Unfiled(completion):
            return {"completion": completion, "kind": "unfiled"}
        case InProgress():
            return {"kind": "in-progress"}
        case _:
            assert_never(projection)


def _view_json(view: LibraryEntryView) -> dict[str, Any]:
    return {"order": _order_json(view.order), "projection": _projection_json(view.projection)}


def _cursor_query(
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
) -> dict[str, object]:
    return {
        "libraryId": str(library_id),
        "view": _view_json(view),
        "viewerId": str(viewer_id),
    }


def _encode_view_cursor(
    *, viewer_id: UUID, library_id: UUID, view: LibraryEntryView, plan: Sequence[_SortKey], row: Any
) -> str:
    return encode_signed_keyset_cursor(
        family=CollectionFamily.LibraryEntries.value,
        query=_cursor_query(viewer_id=viewer_id, library_id=library_id, view=view),
        after=tuple(KeysetValue(key.value, row[key.column]) for key in plan),
    )


def _decode_view_cursor(
    cursor: str,
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    plan: Sequence[_SortKey],
) -> dict[str, object]:
    values = decode_signed_keyset_cursor(
        cursor,
        family=CollectionFamily.LibraryEntries.value,
        query=_cursor_query(viewer_id=viewer_id, library_id=library_id, view=view),
        expected_kinds=tuple(key.value for key in plan),
    )
    return {f"ks_{key.column}": value for key, value in zip(plan, values, strict=True)}


def _finish_entry_page(
    db: Session,
    *,
    viewer_id: UUID,
    rows: Sequence[Any],
    limit: int,
    build_cursor: Callable[[Any], CollectionCursor],
) -> tuple[list[LibraryEntryListItemOut], CollectionCursor | None]:
    """Shared tail for every keyset family (spec S4.2/AC6): the caller already
    fetched ``limit + 1`` rows in the family's own order with no write anywhere
    on this path. Slice to `limit`, hydrate, and — only when there is a next
    page — build its cursor from the last raw row (hydration can drop the
    columns a cursor needs, e.g. `MediaOut` carries no `created_at`)."""
    page_rows = list(rows[:limit])
    has_more = len(rows) > limit
    page_entries = _hydrate_entry_rows(db, viewer_id=viewer_id, rows=page_rows)
    next_cursor = build_cursor(page_rows[-1]) if has_more and page_rows else None
    return page_entries, next_cursor


def _membership_cte_sql(*, is_default: bool, unfiled: bool) -> str:
    """The final ``membership`` CTE (plus its inner CTEs when Default): complete,
    already viewer-visibility-scoped physical rows exposing the canonical entry
    columns. Non-default is one CTE; Default assembles the two-stage
    media-deduplication before it.

    ``unfiled`` (Default only — the service rejects it elsewhere) restricts the
    Default set to media whose only viewer non-system membership entry is the
    direct-Default one: ``bool_and(is_direct_default)`` over each media's
    candidate group is true exactly when it has a direct-Default entry AND no
    other non-system membership entry. Shared-only media never enter the group
    with ``is_direct_default`` true, so they are excluded; system and
    inaccessible-foreign libraries are already outside ``candidate_entries``."""
    entry_cols = "le.id, le.library_id, le.media_id, le.podcast_id, le.created_at, le.position"
    if not is_default:
        return f"""
            membership AS (
                SELECT {entry_cols}
                FROM library_entries le
                WHERE le.library_id = :library_id
                  AND (le.podcast_id IS NOT NULL
                       OR le.media_id IN ({visible_media_ids_cte_sql()}))
            )
        """
    unfiled_cte = (
        """unfiled_media AS (
            SELECT media_id FROM candidate_entries
            GROUP BY media_id HAVING bool_and(is_direct_default)
        ),"""
        if unfiled
        else ""
    )
    unfiled_restrict = "WHERE media_id IN (SELECT media_id FROM unfiled_media)" if unfiled else ""
    return f"""
        default_media AS (
            {library_media_ids_cte_sql()}
        ),
        candidate_entries AS (
            SELECT
                le.id AS entry_id,
                le.media_id,
                (le.library_id = :library_id) AS is_direct_default,
                le.created_at AS entry_created_at
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id AND l.system_key IS NULL
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE le.media_id IN (SELECT media_id FROM default_media)
        ),
        {unfiled_cte}
        ranked AS (
            SELECT DISTINCT ON (media_id) entry_id
            FROM candidate_entries
            {unfiled_restrict}
            ORDER BY media_id, is_direct_default DESC, entry_created_at ASC, entry_id ASC
        ),
        membership AS (
            SELECT {entry_cols}
            FROM ranked r
            JOIN library_entries le ON le.id = r.entry_id
        )
    """


def _query_view_page(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    is_default: bool,
    view: LibraryEntryView,
    limit: int,
    after: dict[str, object] | None,
) -> tuple[list[LibraryEntryListItemOut], CollectionCursor | None]:
    """The single view query (spec backend architecture): one statement with a
    single top-level ``WITH`` — membership (branched default vs non-default,
    Unfiled-restricted when requested), a uniform ``facts`` CTE, the projection
    predicate, generic keyset, plan-driven ORDER BY, LIMIT+1 — then the shared
    hydration tail. The projection is applied before completion, ordering,
    keyset, and limit+1 (spec AC8)."""
    plan = _plan(view.order, is_default=is_default)
    needs_creator = isinstance(view.order, Creator)
    match view.projection:
        case AllItems(completion):
            unfinished = completion == "unfinished"
            in_progress = False
            unfiled = False
        case Unfiled(completion):
            unfinished = completion == "unfinished"
            in_progress = False
            unfiled = True
        case InProgress():
            unfinished = False
            in_progress = True
            unfiled = False
        case _:
            assert_never(view.projection)
    needs_eng = unfinished or in_progress

    creator_name_expr = (
        "COALESCE(mc.primary_name, pc.primary_name)" if needs_creator else "NULL::text"
    )
    added_at_expr = "md.created_at" if is_default else "membership.created_at"
    sort_identity_expr = "membership.media_id" if is_default else "membership.id"
    read_state_expr = "eng.read_state" if needs_eng else "NULL::text"

    facts_joins = [
        "LEFT JOIN media md ON md.id = membership.media_id",
        "LEFT JOIN podcasts pod ON pod.id = membership.podcast_id",
    ]
    if needs_creator:
        facts_joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('media_id')}) mc"
            " ON mc.owner_id = membership.media_id"
        )
        facts_joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('podcast_id')}) pc"
            " ON pc.owner_id = membership.podcast_id"
        )
    if needs_eng:
        facts_joins.append(
            f"LEFT JOIN ({consumption_service.engagement_fact_rows_sql()}) eng"
            " ON eng.media_id = membership.media_id"
        )

    # In Progress matches the canonical 'InProgress' read_state; a NULL read_state
    # (podcasts, shows, and media with no engagement fact) never matches, so
    # podcast-show rows are excluded (spec AC7).
    if unfinished:
        projection_clause = (
            "AND (facts.podcast_id IS NOT NULL OR facts.read_state IS DISTINCT FROM 'Finished')"
        )
    elif in_progress:
        projection_clause = "AND facts.read_state = 'InProgress'"
    else:
        projection_clause = ""
    keyset_clause = _keyset_clause(plan) if after is not None else ""
    order_by = ", ".join(f"facts.{key.column} {key.direction.upper()}" for key in plan)

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "library_id": library_id,
        "limit": limit + 1,
    }
    if after is not None:
        params.update(after)

    rows = (
        db.execute(
            text(f"""
                WITH {_membership_cte_sql(is_default=is_default, unfiled=unfiled)},
                facts AS (
                    SELECT
                        membership.id,
                        membership.library_id,
                        membership.media_id,
                        membership.podcast_id,
                        membership.created_at,
                        membership.position,
                        md.created_at AS media_created_at,
                        {added_at_expr} AS added_at,
                        lower(btrim(COALESCE(md.title, pod.title))) AS title_key,
                        {creator_name_expr} AS creator_name,
                        ({creator_name_expr} IS NULL)::int AS creator_missing,
                        md.published_date AS published_date,
                        (md.published_date IS NULL)::int AS published_missing,
                        {sort_identity_expr} AS sort_identity,
                        {read_state_expr} AS read_state
                    FROM membership
                    {" ".join(facts_joins)}
                )
                SELECT
                    id, library_id, media_id, podcast_id, created_at, position,
                    media_created_at, added_at, title_key, creator_name, creator_missing,
                    published_date, published_missing, sort_identity
                FROM facts
                WHERE 1 = 1
                  {projection_clause}
                  {keyset_clause}
                ORDER BY {order_by}
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )

    return _finish_entry_page(
        db,
        viewer_id=viewer_id,
        rows=rows,
        limit=limit,
        build_cursor=lambda row: _encode_view_cursor(
            viewer_id=viewer_id, library_id=library_id, view=view, plan=plan, row=row
        ),
    )


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    view: LibraryEntryView,
    limit: int = 100,
    cursor: CollectionCursor | None = None,
    collection_revision: CollectionRevision | None = None,
) -> CollectionPage[LibraryEntryListItemOut]:
    """List a library's hydrated entries under a view lens. Member-only.

    The view's ``order`` selects Canonical (Default's `media.created_at DESC`,
    else the physical position order) or one of the factual sorts; the
    ``projection`` (AllItems/Unfiled/In Progress, with completion where it carries
    one) filters the set before ordering. Unfiled is valid only for the viewer's
    own Default. Every page is a true keyset over the view's total order; the
    returned cursor is bound to this exact viewer/library/view.
    """
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    current_revision = (
        read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
            expected=collection_revision,
        )
    )

    if isinstance(view.projection, Unfiled) and not ctx.is_default:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unfiled is only available for the default library"
        )

    after: dict[str, object] | None = None
    if cursor is not None:
        after = _decode_view_cursor(
            cursor,
            viewer_id=viewer_id,
            library_id=library_id,
            view=view,
            plan=_plan(view.order, is_default=ctx.is_default),
        )

    items, next_cursor = _query_view_page(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        is_default=ctx.is_default,
        view=view,
        limit=limit,
        after=after,
    )
    return CollectionPage[LibraryEntryListItemOut](
        items=items,
        collectionRevision=current_revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
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


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> None:
    """Ensure media has a direct physical entry in the user's default library."""
    from nexus.services.media_deletion import clear_user_media_deletion

    default_library_id = governance.default_library_id_for_user(db, user_id)
    inserted = ensure_entry(db, default_library_id, media_target(media_id))
    clear_user_media_deletion(db, user_id, media_id)
    if inserted:
        _bump_entry_visibility_revisions(db)


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
        _lock_authorized_media_for_filing(
            db,
            viewer_id,
            media_id,
            authorization="filable",
        )
        targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
        _add_media_to_resolved_libraries(db, viewer_id, media_id, targets)
        _bump_entry_visibility_revisions(db)


def _add_media_to_resolved_libraries(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
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
        if not entry_exists(db, library_id, target):
            _require_share_entitlement_for_access_increase(
                db, actor_user_id=viewer_id, library_id=library_id
            )
    for library_id in library_ids:
        ensure_entry(db, library_id, target)
    clear_user_media_deletion(db, viewer_id, media_id)


def assign_libraries_for_media(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """Attach media to the viewer's default library plus selected destinations.

    Standalone assignment owns its transaction. Creation workflows that already
    own a transaction must call `assign_libraries_for_media_in_current_transaction`.
    """
    with transaction(db):
        assign_libraries_for_media_in_current_transaction(db, viewer_id, media_id, library_ids)


def assign_libraries_for_media_in_current_transaction(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
    default_library_id = governance.default_library_id_for_user(db, viewer_id)
    raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id, *targets])
    ensure_media_in_default_library(db, viewer_id, media_id)
    _add_media_to_resolved_libraries(db, viewer_id, media_id, targets)
    _bump_entry_visibility_revisions(db)


def materialize_subscription_episode_libraries_in_current_transaction(
    db: Session,
    subscription_user_id: UUID,
    subscription_podcast_id: UUID,
    media_id: UUID,
) -> None:
    """File one episode through an already-admitted subscription relationship."""
    target_library_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text("""
                SELECT psl.library_id
                FROM podcast_subscription_libraries psl
                JOIN podcast_episodes pe
                  ON pe.podcast_id = psl.subscription_podcast_id
                 AND pe.media_id = :media_id
                JOIN libraries l
                  ON l.id = psl.library_id
                 AND l.is_default = false
                 AND l.system_key IS NULL
                JOIN memberships membership
                  ON membership.library_id = psl.library_id
                 AND membership.user_id = psl.subscription_user_id
                 AND membership.role = 'admin'
                WHERE psl.subscription_user_id = :user_id
                  AND psl.subscription_podcast_id = :podcast_id
                ORDER BY psl.library_id
            """),
            {
                "user_id": subscription_user_id,
                "podcast_id": subscription_podcast_id,
                "media_id": media_id,
            },
        ).fetchall()
    ]
    default_library_id = governance.default_library_id_for_user(db, subscription_user_id)
    raise_if_media_teardown_pending(db, media_id)
    governance.lock_library_rows_in_order(db, [default_library_id, *target_library_ids])
    ensure_media_in_default_library(db, subscription_user_id, media_id)
    target = media_target(media_id)
    for library_id in target_library_ids:
        ensure_entry(db, library_id, target)
    _bump_entry_visibility_revisions(db)


def set_subscription_libraries(
    db: Session,
    subscription_user_id: UUID,
    subscription_podcast_id: UUID,
    library_ids: list[UUID],
) -> None:
    """Replace the writable non-default library set attached to a subscription.

    Standalone replacement owns its transaction. Subscription workflows that
    already own a transaction must call
    `set_subscription_libraries_in_current_transaction`.
    """
    with transaction(db):
        set_subscription_libraries_in_current_transaction(
            db, subscription_user_id, subscription_podcast_id, library_ids
        )


def set_subscription_libraries_in_current_transaction(
    db: Session,
    subscription_user_id: UUID,
    subscription_podcast_id: UUID,
    library_ids: list[UUID],
) -> None:
    targets = governance.resolve_writable_non_default_library_ids(
        db, subscription_user_id, library_ids
    )
    contexts = {
        library_id: governance.lock_library_for_member(db, subscription_user_id, library_id)
        for library_id in sorted(targets)
    }
    for context in contexts.values():
        governance.require_admin(context.role)
        governance.require_non_default(context.is_default)
        governance.require_not_system(context.system_key)
    existing_targets = {
        UUID(str(row[0]))
        for row in db.execute(
            text("""
                SELECT library_id
                FROM podcast_subscription_libraries
                WHERE subscription_user_id = :user_id
                  AND subscription_podcast_id = :podcast_id
            """),
            {"user_id": subscription_user_id, "podcast_id": subscription_podcast_id},
        ).fetchall()
    }
    for library_id in targets:
        if library_id not in existing_targets:
            _require_share_entitlement_for_access_increase(
                db,
                actor_user_id=subscription_user_id,
                library_id=library_id,
            )
    db.execute(
        text("""
            DELETE FROM podcast_subscription_libraries
            WHERE subscription_user_id = :user_id
              AND subscription_podcast_id = :podcast_id
        """),
        {"user_id": subscription_user_id, "podcast_id": subscription_podcast_id},
    )
    for library_id in targets:
        db.execute(
            text("""
                INSERT INTO podcast_subscription_libraries
                    (subscription_user_id, subscription_podcast_id, library_id)
                VALUES (:user_id, :podcast_id, :library_id)
            """),
            {
                "user_id": subscription_user_id,
                "podcast_id": subscription_podcast_id,
                "library_id": library_id,
            },
        )
    if set(targets) != existing_targets:
        _bump_entry_visibility_revisions(db)


# ---------------------------------------------------------------------------
# Catalog-facing reads (podcast subscriptions surfaces)
# ---------------------------------------------------------------------------


def visible_non_default_libraries_for_viewer(
    db: Session, *, viewer_id: UUID, podcast_ids: Sequence[UUID]
) -> dict[UUID, list[PodcastSubscriptionVisibleLibraryOut]]:
    """Map each podcast id to the viewer-visible non-default libraries it belongs to.

    The viewer must be a member of a non-default library for it to surface. Each
    podcast's libraries are ordered by created_at ASC, id ASC. Podcasts with no visible
    library are absent. One batched query keyed by the given podcast ids (no N+1).
    """
    if not podcast_ids:
        return {}
    rows = (
        db.execute(
            text("""
            SELECT le.podcast_id, l.id AS library_id, l.name, l.color
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id AND l.is_default = false
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE le.podcast_id = ANY(:podcast_ids)
            ORDER BY le.podcast_id, l.created_at ASC, l.id ASC
        """),
            {"viewer_id": viewer_id, "podcast_ids": list(podcast_ids)},
        )
        .mappings()
        .all()
    )
    result: dict[UUID, list[PodcastSubscriptionVisibleLibraryOut]] = {}
    for row in rows:
        result.setdefault(UUID(str(row["podcast_id"])), []).append(
            PodcastSubscriptionVisibleLibraryOut(
                id=row["library_id"], name=row["name"], color=row["color"]
            )
        )
    return result


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
