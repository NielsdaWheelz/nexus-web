"""Library entries: the `library_entries` table — sole writer and lifecycle owner.

Every INSERT/UPDATE/DELETE on `library_entries`, the entry-kind polymorphism, the
position total order, hydration, and the item-in-library commands live here. Other
modules call this module's public API; none issue `library_entries` DML directly.
The visibility readers in `auth/permissions.py` and the search/object modules read
the table under an explicit allowlist (see the cutover spec).
"""

import base64
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any, Literal, assert_never
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, can_restore_media, visible_media_ids_cte_sql
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.library import (
    ItemLibraryMembershipOut,
    LibraryEntryKind,
    LibraryEntryOrderRequest,
    LibraryEntryOut,
    LibraryPageInfo,
    LibraryPodcastOut,
    LibraryPodcastSubscriptionOut,
)
from nexus.schemas.media import MediaLibrariesResponse
from nexus.schemas.podcast import PodcastSubscriptionVisibleLibraryOut
from nexus.services import attention
from nexus.services import library_governance as governance
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import (
    load_contributor_credits_for_podcasts,
    visible_credit_rows_sql,
)

# Mirrors index ix_library_entries_library_order (library_id, position, created_at DESC,
# id DESC). The single definition of the entry total order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"
_ENTRY_COLUMNS = "id, library_id, media_id, podcast_id, created_at, position"
_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}

# The orderings GET /libraries/{id}/entries supports (spec S5). "position" is the
# default and keeps EXACTLY `_ENTRY_ORDER`; "resonance" applies the deterministic
# score below.
LibraryEntrySort = Literal["position", "resonance"]

# Strict, discriminated opaque-cursor kinds (spec S4.2). Each binds viewer_id +
# library_id + sort; a `k`, `viewer_id`, `library_id`, or `sort` mismatch —
# including every pre-cutover `library_entries:snapshot` cursor — is
# E_INVALID_CURSOR. Stateless keyset, never a stored snapshot.
_DEFAULT_CURSOR_KIND = "library_entries:default:v1"
_POSITION_CURSOR_KIND = "library_entries:position:v1"
_RESONANCE_CURSOR_KIND = "library_entries:resonance:v1"

# Resonance score weights (spec S5). The score is a pure SQL/arithmetic
# combination of precomputed signals: recency-decay over the entry's most recent
# activity, log1p(connection_count), and shared-author hits, with NO request-time
# LLM. The similarity term is OMITTED for v1 (it folds in later behind config;
# adding it now would require a per-entry vector scan, which v1 deliberately avoids
# until the existing vector-index plan is proven).
_RESONANCE_RECENCY_WEIGHT = 1.0
_RESONANCE_CONNECTION_WEIGHT = 0.1
_RESONANCE_SHARED_AUTHOR_WEIGHT = 0.05
_RESONANCE_SIMILARITY_WEIGHT = 0.05
# Recency half-life in days: the decay term is 0.5 ** (age_days / half_life), so an
# entry last touched `half_life` days ago contributes half a fresh entry's recency.
_RESONANCE_RECENCY_HALF_LIFE_DAYS = 14.0

# Per-entry most-recent engagement instant, in SQL, for ordering. Mirrors the two
# authoritative sources `_hydrate_entries`/`services.media` read post-hoc: a direct
# media entry's reading sessions / listening state (podcast episodes are still
# `media_id` library entries), and a podcast entry's MAX listening-state recency
# across its visible episodes. NULL when the target was never engaged.
# Engagement recency composes the attention owner's reading-session recency and the
# consumption owner's listening recency; the raw consumption/attention table reads
# live only in their owners (spec §3 / §8 AC-15).
_LAST_ENGAGED_AT_SQL = f"""
    CASE
        WHEN le.media_id IS NOT NULL THEN NULLIF(
            GREATEST(
                COALESCE(
                    {
    attention.reading_recency_subquery_sql(user_param=":viewer_id", media_expr="le.media_id")
}, '-infinity'::timestamptz),
                COALESCE(
                    {
    consumption_service.listening_recency_subquery_sql(
        user_param=":viewer_id", media_expr="le.media_id"
    )
}, '-infinity'::timestamptz)
            ),
            '-infinity'::timestamptz
        )
        WHEN le.podcast_id IS NOT NULL THEN {
    consumption_service.listening_recency_max_subquery_sql(
        user_param=":viewer_id", podcast_expr="le.podcast_id"
    )
}
        ELSE NULL
    END
"""

# Connection count for the entry's media:<id>/podcast:<id> ref over the AI-free
# `LIST_CONNECTION_ORIGINS` allowlist (edges where the ref is source OR target).
_CONNECTION_COUNT_SQL = """
    (
        SELECT COUNT(*)
        FROM resource_edges e
        WHERE e.user_id = :viewer_id
          AND e.origin = ANY(:resonance_origins)
          AND (
            (e.source_scheme = CASE WHEN le.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
             AND e.source_id = COALESCE(le.media_id, le.podcast_id))
            OR
            (e.target_scheme = CASE WHEN le.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
             AND e.target_id = COALESCE(le.media_id, le.podcast_id))
          )
    )
"""

_LAST_CONNECTED_AT_SQL = """
    (
        SELECT MAX(e.created_at)
        FROM resource_edges e
        WHERE e.user_id = :viewer_id
          AND e.origin = ANY(:resonance_origins)
          AND (
            (e.source_scheme = CASE WHEN le.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
             AND e.source_id = COALESCE(le.media_id, le.podcast_id))
            OR
            (e.target_scheme = CASE WHEN le.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
             AND e.target_id = COALESCE(le.media_id, le.podcast_id))
          )
    )
"""

_PUBLISHED_AT_SQL = """
    CASE
        WHEN le.media_id IS NOT NULL THEN (
            SELECT CASE
                WHEN m.published_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
                    THEN m.published_date::date::timestamptz
                WHEN m.published_date ~ '^\\d{4}-\\d{2}$'
                    THEN (m.published_date || '-01')::date::timestamptz
                WHEN m.published_date ~ '^\\d{4}$'
                    THEN (m.published_date || '-01-01')::date::timestamptz
                ELSE NULL
            END
            FROM media m
            WHERE m.id = le.media_id
        )
        WHEN le.podcast_id IS NOT NULL THEN (
            SELECT MAX(pe.published_at)
            FROM podcast_episodes pe
            WHERE pe.podcast_id = le.podcast_id
        )
        ELSE NULL
    END
"""

# Shared-author affinity over the canonical visible-credit relation (spec §4): the
# resonance score's author term self-joins the visible-credit relation on
# contributor_id (author role only), so neither this module nor the score reads
# contributor_credits directly. Binds :viewer_id via the composed relation.
_SHARED_AUTHOR_HITS_SQL = f"""
    (
        SELECT COUNT(DISTINCT mine.contributor_id)
        FROM ({visible_credit_rows_sql()}) mine
        JOIN ({visible_credit_rows_sql()}) other
          ON other.contributor_id = mine.contributor_id
         AND other.role = 'author'
        JOIN library_entries peer
          ON peer.library_id = le.library_id
         AND peer.id <> le.id
         AND (
            (other.media_id IS NOT NULL AND peer.media_id = other.media_id)
            OR (other.podcast_id IS NOT NULL AND peer.podcast_id = other.podcast_id)
         )
        WHERE mine.role = 'author'
          AND (
            (le.media_id IS NOT NULL AND mine.media_id = le.media_id)
            OR (le.podcast_id IS NOT NULL AND mine.podcast_id = le.podcast_id)
          )
    )
"""

_SIMILARITY_SQL = """
    CASE
        WHEN le.media_id IS NOT NULL THEN COALESCE((
            SELECT 1.0 - (ce.embedding_vector <=> seed.vec)
            FROM (
                SELECT ce_seed.embedding_vector AS vec,
                       cis.active_embedding_provider AS provider,
                       cis.active_embedding_model AS model
                FROM content_index_states cis
                JOIN content_chunks cc_seed
                  ON cc_seed.owner_kind = 'media'
                 AND cc_seed.owner_id = cis.owner_id
                JOIN content_embeddings ce_seed
                  ON ce_seed.chunk_id = cc_seed.id
                 AND ce_seed.embedding_provider = cis.active_embedding_provider
                 AND ce_seed.embedding_model = cis.active_embedding_model
                 AND ce_seed.embedding_dimensions = :embedding_dims
                 AND ce_seed.embedding_vector IS NOT NULL
                WHERE cis.owner_kind = 'media'
                  AND cis.owner_id = le.media_id
                  AND cis.status = 'ready'
                  AND cis.active_embedding_provider IS NOT NULL
                  AND cis.active_embedding_model IS NOT NULL
                ORDER BY cc_seed.chunk_idx ASC, cc_seed.id ASC
                LIMIT 1
            ) seed
            JOIN content_embeddings ce
              ON ce.embedding_dimensions = :embedding_dims
             AND ce.embedding_provider = seed.provider
             AND ce.embedding_model = seed.model
             AND ce.embedding_vector IS NOT NULL
            JOIN content_chunks cc
              ON cc.id = ce.chunk_id
             AND cc.owner_kind = 'media'
            JOIN content_index_states peer_cis
              ON peer_cis.owner_kind = 'media'
             AND peer_cis.owner_id = cc.owner_id
             AND peer_cis.status = 'ready'
             AND peer_cis.active_embedding_provider = seed.provider
             AND peer_cis.active_embedding_model = seed.model
            JOIN library_entries peer
              ON peer.library_id = le.library_id
             AND peer.id <> le.id
             AND peer.media_id = cc.owner_id
            ORDER BY ce.embedding_vector <=> seed.vec ASC, cc.owner_id ASC, cc.id ASC
            LIMIT 1
        ), 0.0)
        ELSE 0.0
    END
"""

_MOST_RECENT_ACTIVITY_SQL = f"""
    GREATEST(
        le.created_at,
        COALESCE({_LAST_ENGAGED_AT_SQL}, le.created_at),
        COALESCE({_LAST_CONNECTED_AT_SQL}, le.created_at),
        COALESCE({_PUBLISHED_AT_SQL}, le.created_at)
    )
"""

# Deterministic resonance score: weighted recency-decay + log1p(connection_count),
# highest first, with `id DESC` as the stable tiebreak so identical input yields one
# fixed order. The caller binds `:resonance_as_of`; cursor pagination reuses the same
# timestamp across pages so a load-more sequence cannot reshuffle underneath itself.
_RESONANCE_SCORE_SQL = f"""
    (
        {_RESONANCE_RECENCY_WEIGHT} * power(
            0.5,
            GREATEST(
                EXTRACT(EPOCH FROM (:resonance_as_of - {_MOST_RECENT_ACTIVITY_SQL})) / 86400.0,
                0.0
            ) / {_RESONANCE_RECENCY_HALF_LIFE_DAYS}
        )
        + {_RESONANCE_CONNECTION_WEIGHT} * ln(1.0 + {_CONNECTION_COUNT_SQL})
        + {_RESONANCE_SHARED_AUTHOR_WEIGHT} * {_SHARED_AUTHOR_HITS_SQL}
        + {_RESONANCE_SIMILARITY_WEIGHT} * {_SIMILARITY_SQL}
    )
"""
_RESONANCE_ORDER = f"""
    {_RESONANCE_SCORE_SQL} DESC,
    le.id DESC
"""


def library_media_ids_cte_sql() -> str:
    """The sole library media-set relation (spec S4.1). Binds :viewer_id and
    :library_id; every branch also intersects with `visible_media_ids_cte_sql`,
    which applies viewer-tombstone and teardown-intent exclusion, so a caller
    never has to layer those checks again on top.

    - Viewer-owned Default (:library_id is the viewer's own non-system default
      library): every media_id reachable through any of the viewer's CURRENT
      non-system memberships — the personal "All" set. This is
      `auth.permissions.visible_media_ids_cte_sql`'s relation further constrained
      to non-system contributing libraries, so an Oracle work reachable only
      through the system corpus library never leaks into a personal surface
      (AC2); a work also explicitly filed personally stays, because that filing
      is itself a non-system membership path.
    - Non-default member library: that library's own physical media entries,
      intersected with the broader global-readability relation (so an entry
      whose media a concurrent teardown has since armed, or the viewer has since
      tombstoned, never surfaces even though the physical row still exists).
    - Any other (:viewer_id, :library_id) pair — non-member, someone else's
      default, or a system-library target — contributes zero rows. This
      relation never raises; masking a non-member as "not found" is the
      caller's job (`library_governance.lock_library_for_member`).
    """
    return f"""
        SELECT le.media_id
        FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
        WHERE l.id = :library_id
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
              WHERE dl.id = :library_id
                AND dl.is_default = true
                AND dl.system_key IS NULL
                AND dl.owner_user_id = :viewer_id
          )
          AND le.media_id IN ({visible_media_ids_cte_sql()})
    """


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


@dataclass(frozen=True)
class PodcastLibraryRemovalResult:
    removed_from_library_count: int
    retained_shared_library_count: int


@dataclass(frozen=True)
class LibraryFilingOutcome:
    """The idempotent present/inserted outcome a filing command returns (spec
    S4.3 rule 8). `inserted` is False when the physical entry already existed
    (re-file/idempotent path) — `agent_tools.writes` reads it so Undo never
    deletes a filing it did not itself create; REST callers project `entry`
    unchanged into the existing response envelope."""

    entry: LibraryEntryOut
    inserted: bool


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
    intent = db.execute(
        text("SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if intent is not None:
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")


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


def _start_of_today(viewer_timezone: str) -> datetime:
    """Start-of-day boundary used for the "surfaced today" lane."""
    try:
        tz = ZoneInfo(viewer_timezone)
    except ZoneInfoNotFoundError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "viewer_tz must be a valid IANA timezone",
        ) from exc
    now = datetime.now(tz)
    return datetime.combine(now.date(), time.min, tzinfo=tz).astimezone(UTC)


def _surfaced_today(
    *,
    created_at: datetime,
    last_engaged_at: datetime | None,
    last_connected_at: datetime | None,
    published_at: datetime | None,
    start_of_today: datetime,
) -> bool:
    """True when the entry's most recent list-surface signal falls today."""
    most_recent = max(
        instant
        for instant in (created_at, last_engaged_at, last_connected_at, published_at)
        if instant is not None
    )
    return most_recent >= start_of_today


def _entry_recency_signals(
    db: Session, *, viewer_id: UUID, entry_ids: list[UUID]
) -> dict[UUID, tuple[datetime | None, datetime | None]]:
    if not entry_ids:
        return {}
    from nexus.services.resource_graph.connection_summaries import LIST_CONNECTION_ORIGINS

    rows = (
        db.execute(
            text(f"""
                SELECT
                    le.id AS entry_id,
                    {_LAST_CONNECTED_AT_SQL} AS last_connected_at,
                    {_PUBLISHED_AT_SQL} AS published_at
                FROM library_entries le
                WHERE le.id = ANY(:entry_ids)
            """),
            {
                "viewer_id": viewer_id,
                "entry_ids": entry_ids,
                "resonance_origins": list(LIST_CONNECTION_ORIGINS),
            },
        )
        .mappings()
        .all()
    )
    return {
        UUID(str(row["entry_id"])): (row["last_connected_at"], row["published_at"]) for row in rows
    }


def _hydrate_entries(
    db: Session, viewer_id: UUID, rows, *, viewer_timezone: str = "UTC"
) -> list[LibraryEntryOut]:
    """Hydrate name-keyed entry rows (_ENTRY_COLUMNS) into LibraryEntryOut, batching
    the media and podcast lookups. Entries whose target is not viewer-visible drop out.

    Each entry also carries the derived "surfaced today" lane signal (S3): the
    entry's media/podcast engagement recency (`last_engaged_at`), graph recency,
    published recency, and whether their greatest value lands on the current
    viewer-timezone day."""
    if not rows:
        return []

    start_of_today = _start_of_today(viewer_timezone)
    recency_signals_by_entry_id = _entry_recency_signals(
        db,
        viewer_id=viewer_id,
        entry_ids=[UUID(str(row["id"])) for row in rows],
    )

    media_ids = [UUID(str(row["media_id"])) for row in rows if row["media_id"] is not None]
    podcast_ids = [UUID(str(row["podcast_id"])) for row in rows if row["podcast_id"] is not None]

    media_by_id = {}
    if media_ids:
        from nexus.services import media as media_service

        media_by_id = {
            media.id: media
            for media in media_service.list_media_for_viewer_by_ids(db, viewer_id, media_ids)
        }

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
                        ) AS unplayed_count,
                        MAX(pls.updated_at) AS last_listened_at
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
                    p.provider AS provider,
                    p.provider_podcast_id AS provider_podcast_id,
                    p.title AS title,
                    p.feed_url AS feed_url,
                    p.website_url AS website_url,
                    p.image_url AS image_url,
                    p.description AS description,
                    p.created_at AS podcast_created_at,
                    p.updated_at AS podcast_updated_at,
                    COALESCE(pu.unplayed_count, 0) AS unplayed_count,
                    pu.last_listened_at AS last_listened_at,
                    ps.status AS sub_status,
                    ps.default_playback_speed AS sub_default_playback_speed,
                    ps.auto_queue AS sub_auto_queue,
                    ps.sync_status AS sub_sync_status,
                    ps.sync_error_code AS sub_sync_error_code,
                    ps.sync_error_message AS sub_sync_error_message,
                    ps.sync_attempts AS sub_sync_attempts,
                    ps.sync_started_at AS sub_sync_started_at,
                    ps.sync_completed_at AS sub_sync_completed_at,
                    ps.last_synced_at AS sub_last_synced_at,
                    ps.updated_at AS sub_updated_at
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

    hydrated: list[LibraryEntryOut] = []
    for row in rows:
        media_id = UUID(str(row["media_id"])) if row["media_id"] is not None else None
        podcast_id = UUID(str(row["podcast_id"])) if row["podcast_id"] is not None else None
        if media_id is not None:
            media = media_by_id.get(media_id)
            if media is None:
                continue
            last_connected_at, published_at = recency_signals_by_entry_id.get(
                UUID(str(row["id"])), (None, None)
            )
            hydrated.append(
                LibraryEntryOut(
                    id=UUID(str(row["id"])),
                    library_id=UUID(str(row["library_id"])),
                    kind="media",
                    position=int(row["position"]),
                    created_at=row["created_at"],
                    media=media,
                    podcast=None,
                    subscription=None,
                    read_state=media.read_state,
                    progress_fraction=media.progress_fraction,
                    last_engaged_at=media.last_engaged_at,
                    surfaced_today=_surfaced_today(
                        created_at=row["created_at"],
                        last_engaged_at=media.last_engaged_at,
                        last_connected_at=last_connected_at,
                        published_at=published_at,
                        start_of_today=start_of_today,
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
            subscription = LibraryPodcastSubscriptionOut(
                status=podcast_row["sub_status"],
                default_playback_speed=float(podcast_row["sub_default_playback_speed"])
                if podcast_row["sub_default_playback_speed"] is not None
                else None,
                auto_queue=bool(podcast_row["sub_auto_queue"]),
                sync_status=podcast_row["sub_sync_status"],
                sync_error_code=podcast_row["sub_sync_error_code"],
                sync_error_message=podcast_row["sub_sync_error_message"],
                sync_attempts=int(podcast_row["sub_sync_attempts"] or 0),
                sync_started_at=podcast_row["sub_sync_started_at"],
                sync_completed_at=podcast_row["sub_sync_completed_at"],
                last_synced_at=podcast_row["sub_last_synced_at"],
                updated_at=podcast_row["sub_updated_at"],
            )

        podcast_last_engaged_at = podcast_row["last_listened_at"]
        last_connected_at, published_at = recency_signals_by_entry_id.get(
            UUID(str(row["id"])), (None, None)
        )
        hydrated.append(
            LibraryEntryOut(
                id=UUID(str(row["id"])),
                library_id=UUID(str(row["library_id"])),
                kind="podcast",
                position=int(row["position"]),
                created_at=row["created_at"],
                last_engaged_at=podcast_last_engaged_at,
                surfaced_today=_surfaced_today(
                    created_at=row["created_at"],
                    last_engaged_at=podcast_last_engaged_at,
                    last_connected_at=last_connected_at,
                    published_at=published_at,
                    start_of_today=start_of_today,
                ),
                media=None,
                podcast=LibraryPodcastOut(
                    id=podcast_id,
                    provider=podcast_row["provider"],
                    provider_podcast_id=podcast_row["provider_podcast_id"],
                    title=podcast_row["title"],
                    contributors=contributors_by_podcast_id.get(podcast_id, []),
                    feed_url=podcast_row["feed_url"],
                    website_url=podcast_row["website_url"],
                    image_url=podcast_row["image_url"],
                    description=podcast_row["description"],
                    created_at=podcast_row["podcast_created_at"],
                    updated_at=podcast_row["podcast_updated_at"],
                    unplayed_count=int(podcast_row["unplayed_count"] or 0),
                ),
                subscription=subscription,
            )
        )

    return hydrated


# ---------------------------------------------------------------------------
# Item-in-library commands
# ---------------------------------------------------------------------------


def list_item_libraries(
    db: Session, *, viewer_id: UUID, target: EntryTarget
) -> list[ItemLibraryMembershipOut]:
    """Per-library add/remove affordances for one media or podcast across the viewer's
    non-default libraries. Replaces the media/podcast twins; the existence check and the
    EXISTS predicate column derive from target.kind."""
    if target.kind == "media":
        if not can_read_media(db, viewer_id, target.id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    elif target.kind == "podcast":
        exists = db.execute(
            text("SELECT 1 FROM podcasts WHERE id = :podcast_id"),
            {"podcast_id": target.id},
        ).fetchone()
        if exists is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
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
            ORDER BY l.created_at ASC, l.id ASC
        """),
            {"viewer_id": viewer_id, "target_id": target.id},
        )
        .mappings()
        .all()
    )

    return [
        ItemLibraryMembershipOut(
            id=row["id"],
            name=row["name"],
            color=row["color"],
            is_in_library=bool(row["in_library"]),
            can_add=row["role"] == "admin" and not bool(row["in_library"]),
            can_remove=row["role"] == "admin" and bool(row["in_library"]),
        )
        for row in rows
    ]


def add_media_to_library(
    db: Session, viewer_id: UUID, library_id: UUID, media_id: UUID
) -> LibraryFilingOutcome:
    """The one actor-authorized filing command for attaching media to a library
    (spec S4.3). Admin-only. A Default target always creates/keeps a direct
    physical entry — there is no separate intrinsic/closure bookkeeping anymore;
    the physical row IS the direct intent, inserted unconditionally even when the
    media is already virtually present through another membership.

    Authorizes readable-OR-restorable media (rule 1) right after the existence
    check, before any lock is taken — REST and agent_tools both funnel through
    this one gate, so neither surface can file a media_id the viewer has no
    membership path to (no existence leak: unauthorized looks identical to
    nonexistent).

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
        if not can_restore_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        raise_if_media_teardown_pending(db, media_id)

        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_not_system(ctx.system_key)

        inserted = ensure_entry(db, library_id, media_target(media_id))
        # Idempotent re-file clears a tombstone even when the entry already
        # existed (spec S4.3 rule 6 / AC4).
        clear_user_media_deletion(db, viewer_id, media_id)

        row = (
            db.execute(
                text(
                    f"SELECT {_ENTRY_COLUMNS} FROM library_entries "
                    "WHERE library_id = :library_id AND media_id = :media_id"
                ),
                {"library_id": library_id, "media_id": media_id},
            )
            .mappings()
            .fetchone()
        )

    return LibraryFilingOutcome(entry=_hydrate_entries(db, viewer_id, [row])[0], inserted=inserted)


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

        inserted = ensure_entry(db, library_id, podcast_target(podcast_id))
        row = (
            db.execute(
                text(
                    f"SELECT {_ENTRY_COLUMNS} FROM library_entries "
                    "WHERE library_id = :library_id AND podcast_id = :podcast_id"
                ),
                {"library_id": library_id, "podcast_id": podcast_id},
            )
            .mappings()
            .fetchone()
        )

    return LibraryFilingOutcome(entry=_hydrate_entries(db, viewer_id, [row])[0], inserted=inserted)


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
    return ensure_entry(db, library_id, media_target(media_id))


def remove_podcast_from_library(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> None:
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

    return PodcastLibraryRemovalResult(
        removed_from_library_count=len(removable_library_ids),
        retained_shared_library_count=retained_shared_library_count,
    )


def _encode_entry_cursor(payload: dict[str, Any]) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(payload, default=str).encode("utf-8")).decode(
        "ascii"
    )
    return encoded.rstrip("=")


def _decode_entry_cursor(
    cursor: str, expected_k: str, *, viewer_id: UUID, library_id: UUID
) -> dict[str, Any]:
    """Strict, discriminated cursor decode (spec S4.2). Any `k`/viewer/library
    mismatch — including every pre-cutover `library_entries:snapshot` cursor,
    whose `k` never equals one of the three v1 kinds — is E_INVALID_CURSOR."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if (
            payload.get("k") != expected_k
            or UUID(str(payload["viewer_id"])) != viewer_id
            or UUID(str(payload["library_id"])) != library_id
        ):
            raise ValueError
        return payload
    except Exception:
        # justify-ignore-error: malformed cursor input is an expected API error path.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def _finish_entry_page(
    db: Session,
    *,
    viewer_id: UUID,
    rows: Sequence[Any],
    limit: int,
    viewer_timezone: str,
    build_cursor: Callable[[Any], str],
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """Shared tail for every keyset family (spec S4.2/AC6): the caller already
    fetched ``limit + 1`` rows in the family's own order with no write anywhere
    on this path. Slice to `limit`, hydrate, and — only when there is a next
    page — build its cursor from the last raw row (hydration can drop the
    columns a cursor needs, e.g. `MediaOut` carries no `created_at`)."""
    page_rows = list(rows[:limit])
    has_more = len(rows) > limit
    page_entries = _hydrate_entries(db, viewer_id, page_rows, viewer_timezone=viewer_timezone)
    next_cursor = build_cursor(page_rows[-1]) if has_more and page_rows else None
    return page_entries, LibraryPageInfo(has_more=has_more, next_cursor=next_cursor)


def _list_default_library_entries(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    limit: int,
    cursor: str | None,
    viewer_timezone: str,
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """Default virtual read surface (spec S4.1/S4.2): accessible non-system
    physical media entries, deduplicated by media_id via a two-stage DISTINCT ON
    — ``candidate_entries`` gathers every qualifying physical row per media
    across the viewer's non-system libraries, ``ranked`` picks the winner (a
    direct default entry first, else deterministic earliest
    (entry.created_at, id)) — then joins back for the full entry row, ordered
    (media.created_at DESC, media.id DESC)."""
    after_media_created_at: datetime | None = None
    after_media_id: UUID | None = None
    if cursor is not None:
        payload = _decode_entry_cursor(
            cursor, _DEFAULT_CURSOR_KIND, viewer_id=viewer_id, library_id=library_id
        )
        try:
            after_media_created_at = datetime.fromisoformat(
                str(payload["after_media_created_at"])
            )
            after_media_id = UUID(str(payload["after_media_id"]))
        except Exception:
            # justify-ignore-error: malformed cursor input is an expected API error path.
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "library_id": library_id,
        "limit": limit + 1,
    }
    keyset_clause = ""
    if after_media_id is not None:
        keyset_clause = """
          AND (
            md.created_at < :after_media_created_at
            OR (md.created_at = :after_media_created_at AND md.id < :after_media_id)
          )
        """
        params["after_media_created_at"] = after_media_created_at
        params["after_media_id"] = after_media_id

    rows = (
        db.execute(
            text(f"""
                WITH default_media AS (
                    {library_media_ids_cte_sql()}
                ),
                candidate_entries AS (
                    SELECT
                        le.id AS entry_id,
                        le.media_id AS media_id,
                        (le.library_id = :library_id) AS is_direct_default,
                        le.created_at AS entry_created_at
                    FROM library_entries le
                    JOIN libraries l ON l.id = le.library_id AND l.system_key IS NULL
                    JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                    WHERE le.media_id IN (SELECT media_id FROM default_media)
                ),
                ranked AS (
                    SELECT DISTINCT ON (media_id) entry_id
                    FROM candidate_entries
                    ORDER BY media_id, is_direct_default DESC, entry_created_at ASC, entry_id ASC
                )
                SELECT
                    le.id, le.library_id, le.media_id, le.podcast_id, le.created_at, le.position,
                    md.created_at AS media_created_at
                FROM ranked r
                JOIN library_entries le ON le.id = r.entry_id
                JOIN media md ON md.id = le.media_id
                WHERE 1 = 1
                {keyset_clause}
                ORDER BY md.created_at DESC, md.id DESC
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )

    def build_cursor(row: Any) -> str:
        return _encode_entry_cursor({
            "k": _DEFAULT_CURSOR_KIND,
            "viewer_id": str(viewer_id),
            "library_id": str(library_id),
            "sort": "position",
            "after_media_created_at": row["media_created_at"].isoformat(),
            "after_media_id": str(row["media_id"]),
        })

    return _finish_entry_page(
        db,
        viewer_id=viewer_id,
        rows=rows,
        limit=limit,
        viewer_timezone=viewer_timezone,
        build_cursor=build_cursor,
    )


def _list_position_library_entries(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    limit: int,
    cursor: str | None,
    viewer_timezone: str,
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """Non-default ``sort="position"``: a true keyset over the canonical
    `_ENTRY_ORDER` (position ASC, created_at DESC, id DESC)."""
    after_position: int | None = None
    after_entry_created_at: datetime | None = None
    after_entry_id: UUID | None = None
    if cursor is not None:
        payload = _decode_entry_cursor(
            cursor, _POSITION_CURSOR_KIND, viewer_id=viewer_id, library_id=library_id
        )
        try:
            after_position = int(payload["after_position"])
            after_entry_created_at = datetime.fromisoformat(
                str(payload["after_entry_created_at"])
            )
            after_entry_id = UUID(str(payload["after_entry_id"]))
        except Exception:
            # justify-ignore-error: malformed cursor input is an expected API error path.
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    params: dict[str, object] = {
        "library_id": library_id,
        "viewer_id": viewer_id,
        "limit": limit + 1,
    }
    keyset_clause = ""
    if after_entry_id is not None:
        keyset_clause = """
          AND (
            le.position > :after_position
            OR (le.position = :after_position AND le.created_at < :after_entry_created_at)
            OR (
              le.position = :after_position
              AND le.created_at = :after_entry_created_at
              AND le.id < :after_entry_id
            )
          )
        """
        params["after_position"] = after_position
        params["after_entry_created_at"] = after_entry_created_at
        params["after_entry_id"] = after_entry_id

    rows = (
        db.execute(
            text(f"""
                SELECT {_ENTRY_COLUMNS} FROM library_entries le
                WHERE le.library_id = :library_id
                  AND (le.podcast_id IS NOT NULL OR le.media_id IN ({visible_media_ids_cte_sql()}))
                {keyset_clause}
                ORDER BY {_ENTRY_ORDER}
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )

    def build_cursor(row: Any) -> str:
        return _encode_entry_cursor({
            "k": _POSITION_CURSOR_KIND,
            "viewer_id": str(viewer_id),
            "library_id": str(library_id),
            "sort": "position",
            "after_position": int(row["position"]),
            "after_entry_created_at": row["created_at"].isoformat(),
            "after_entry_id": str(row["id"]),
        })

    return _finish_entry_page(
        db,
        viewer_id=viewer_id,
        rows=rows,
        limit=limit,
        viewer_timezone=viewer_timezone,
        build_cursor=build_cursor,
    )


def _list_resonance_library_entries(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    limit: int,
    cursor: str | None,
    viewer_timezone: str,
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """Non-default ``sort="resonance"``: a keyset over (score DESC, id DESC).
    `resonance_as_of` is generated once on the first page and carried unchanged
    through the cursor on every later page (spec S4.2) — current
    connection/engagement mutations stay live, so the recomputed score can
    differ from an earlier page's if an underlying signal changed; AC7 only
    promises stability when it does not."""
    # Lazy import: connection_summaries -> resolve -> library_entries is an
    # import cycle, so the S4 origin owner is read at call time, not import.
    from nexus.services.resource_graph.connection_summaries import LIST_CONNECTION_ORIGINS
    from nexus.services.semantic_chunks import transcript_embedding_dimensions

    after_score: float | None = None
    after_entry_id: UUID | None = None
    if cursor is None:
        resonance_as_of = db.execute(text("SELECT now()")).scalar_one()
    else:
        payload = _decode_entry_cursor(
            cursor, _RESONANCE_CURSOR_KIND, viewer_id=viewer_id, library_id=library_id
        )
        try:
            resonance_as_of = datetime.fromisoformat(str(payload["resonance_as_of"]))
            after_score = float(payload["after_score"])
            after_entry_id = UUID(str(payload["after_entry_id"]))
        except Exception:
            # justify-ignore-error: malformed cursor input is an expected API error path.
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    params: dict[str, object] = {
        "library_id": library_id,
        "viewer_id": viewer_id,
        "resonance_origins": list(LIST_CONNECTION_ORIGINS),
        "embedding_dims": transcript_embedding_dimensions(),
        "resonance_as_of": resonance_as_of,
        "limit": limit + 1,
    }
    keyset_clause = ""
    if after_entry_id is not None:
        keyset_clause = """
          WHERE (
            scored.resonance_score < :after_score
            OR (scored.resonance_score = :after_score AND scored.id < :after_entry_id)
          )
        """
        params["after_score"] = after_score
        params["after_entry_id"] = after_entry_id

    rows = (
        db.execute(
            text(f"""
                WITH scored AS (
                    SELECT {_ENTRY_COLUMNS}, {_RESONANCE_SCORE_SQL} AS resonance_score
                    FROM library_entries le
                    WHERE le.library_id = :library_id
                      AND (le.podcast_id IS NOT NULL OR le.media_id IN ({visible_media_ids_cte_sql()}))
                )
                SELECT {_ENTRY_COLUMNS}, resonance_score
                FROM scored
                {keyset_clause}
                ORDER BY resonance_score DESC, id DESC
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )

    def build_cursor(row: Any) -> str:
        return _encode_entry_cursor({
            "k": _RESONANCE_CURSOR_KIND,
            "viewer_id": str(viewer_id),
            "library_id": str(library_id),
            "sort": "resonance",
            "resonance_as_of": resonance_as_of.isoformat(),
            "after_score": float(row["resonance_score"]),
            "after_entry_id": str(row["id"]),
        })

    return _finish_entry_page(
        db,
        viewer_id=viewer_id,
        rows=rows,
        limit=limit,
        viewer_timezone=viewer_timezone,
        build_cursor=build_cursor,
    )


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    limit: int = 100,
    cursor: str | None = None,
    sort: LibraryEntrySort = "position",
    viewer_timezone: str = "UTC",
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """List a library's ordered, hydrated entries. Member-only.

    Default (spec S4.1/S4.2): the live, deduplicated "personal All" virtual
    view — see :func:`_list_default_library_entries`. No reorder; `sort`
    must not be ``"resonance"`` (AC7).

    Non-default ``sort="position"`` (default) keeps EXACTLY the canonical
    `_ENTRY_ORDER`; ``sort="resonance"`` orders by the deterministic
    recency+connection score (no request-time LLM, stable id tiebreak).

    Every family fetches ``limit + 1`` rows through a stateless keyset cursor
    (AC6) and performs no write on this path — the snapshot machinery this
    replaced is gone outright.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    _start_of_today(viewer_timezone)
    limit = min(limit, 200)

    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)

    # AC7: Default rejects sort=resonance before any entries query runs.
    if sort == "resonance":
        governance.require_non_default(ctx.is_default)

    if ctx.is_default:
        return _list_default_library_entries(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            limit=limit,
            cursor=cursor,
            viewer_timezone=viewer_timezone,
        )
    if sort == "resonance":
        return _list_resonance_library_entries(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            limit=limit,
            cursor=cursor,
            viewer_timezone=viewer_timezone,
        )
    if sort == "position":
        return _list_position_library_entries(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            limit=limit,
            cursor=cursor,
            viewer_timezone=viewer_timezone,
        )
    assert_never(sort)


def reorder_entries(
    db: Session, viewer_id: UUID, library_id: UUID, body: LibraryEntryOrderRequest
) -> list[LibraryEntryOut]:
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

    entries, _page = list_library_entries(
        db,
        viewer_id,
        library_id,
        limit=min(max(len(requested_ids), 1), 200),
        sort="position",
    )
    return entries


# ---------------------------------------------------------------------------
# Default-library + bulk assignment commands
# ---------------------------------------------------------------------------


def ensure_media_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> None:
    """Ensure media has a direct physical entry in the user's default library."""
    from nexus.services.media_deletion import clear_user_media_deletion

    default_library_id = governance.default_library_id_for_user(db, user_id)
    ensure_entry(db, default_library_id, media_target(media_id))
    clear_user_media_deletion(db, user_id, media_id)


def add_media_to_libraries_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> MediaLibrariesResponse:
    """Verify the viewer can read the media, then add selected writable destinations."""
    from nexus.services import media as media_service

    with transaction(db):
        media_service.get_media_for_viewer(db, viewer_id, media_id)
        targets = governance.resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
        inserted = _add_media_to_resolved_libraries(db, viewer_id, media_id, targets)
    return MediaLibrariesResponse(media_id=media_id, library_ids_added=inserted)


def _add_media_to_resolved_libraries(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> list[UUID]:
    if not library_ids:
        return []
    from nexus.services.media_deletion import clear_user_media_deletion

    clear_user_media_deletion(db, viewer_id, media_id)
    # The media-teardown barrier must run before any library lock (spec S4.3),
    # so this locks/checks the media row FIRST — matching add_media_to_library's
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

    inserted: list[UUID] = []
    for library_id in library_ids:
        if ensure_entry(db, library_id, media_target(media_id)):
            inserted.append(library_id)
    return inserted


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
    ensure_media_in_default_library(db, viewer_id, media_id)
    _add_media_to_resolved_libraries(db, viewer_id, media_id, targets)


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
