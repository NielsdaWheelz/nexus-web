"""Library entries: the `library_entries` table — sole writer and lifecycle owner.

Every INSERT/UPDATE/DELETE on `library_entries`, the entry-kind polymorphism, the
position total order, hydration, and the item-in-library commands live here. Other
modules call this module's public API; none issue `library_entries` DML directly.
The visibility readers in `auth/permissions.py` and the search/object modules read
the table under an explicit allowlist (see the cutover spec).
"""

import base64
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any, Literal, assert_never
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
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
from nexus.services import library_governance as governance
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts

# Mirrors index ix_library_entries_library_order (library_id, position, created_at DESC,
# id DESC). The single definition of the entry total order.
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"
_ENTRY_COLUMNS = "id, library_id, media_id, podcast_id, created_at, position"
_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}

# The orderings GET /libraries/{id}/entries supports (spec S5). "position" is the
# default and keeps EXACTLY `_ENTRY_ORDER`; "resonance" applies the deterministic
# score below.
LibraryEntrySort = Literal["position", "resonance"]

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
# media entry's reader/listening state (podcast episodes are still `media_id`
# library entries), and a podcast entry's MAX listening-state recency across its
# visible episodes. NULL when the target was never engaged.
_LAST_ENGAGED_AT_SQL = """
    CASE
        WHEN le.media_id IS NOT NULL THEN (
            SELECT NULLIF(
                GREATEST(
                    COALESCE(rms.updated_at, '-infinity'::timestamptz),
                    COALESCE(pls.updated_at, '-infinity'::timestamptz)
                ),
                '-infinity'::timestamptz
            )
            FROM media m
            LEFT JOIN reader_media_state rms
              ON rms.user_id = :viewer_id AND rms.media_id = m.id
            LEFT JOIN podcast_listening_states pls
              ON pls.user_id = :viewer_id AND pls.media_id = m.id
            WHERE m.id = le.media_id
        )
        WHEN le.podcast_id IS NOT NULL THEN (
            SELECT MAX(pls.updated_at)
            FROM podcast_episodes pe
            JOIN podcast_listening_states pls
              ON pls.user_id = :viewer_id AND pls.media_id = pe.media_id
            WHERE pe.podcast_id = le.podcast_id
        )
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

_SHARED_AUTHOR_HITS_SQL = """
    (
        SELECT COUNT(DISTINCT mine.contributor_id)
        FROM contributor_credits mine
        JOIN contributor_credits other
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


def ensure_entry(db: Session, library_id: UUID, target: EntryTarget) -> bool:
    """Append the target to the library at next_position if absent. The sole inserter —
    replaces the inline add inserts and the closure's per-media append.

    Locks the target library row first as the single per-library append serialization
    point. justify-concurrency: two concurrent appends would otherwise both read the
    same MAX(position)+1 — a result no sequential ordering yields — and collide on
    UNIQUE(library_id, position) at commit. concurrency.md requires locking when
    concurrent calls can produce a non-sequential result; its FOR UPDATE prohibition is
    scoped to SERIALIZABLE, whereas transaction() is READ COMMITTED. The bound is one
    row lock per library, held only for the append. The (library_id, media_id) /
    (library_id, podcast_id) unique constraints independently make a duplicate entry
    uncommittable regardless of isolation.
    """
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
                            WHERE pls.is_completed IS NOT TRUE
                              AND COALESCE(pls.position_ms, 0) = 0
                        ) AS unplayed_count,
                        MAX(pls.updated_at) AS last_listened_at
                    FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    LEFT JOIN podcast_listening_states pls
                      ON pls.user_id = :viewer_id AND pls.media_id = pe.media_id
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
) -> LibraryEntryOut:
    """Add media to a library. Admin-only. Default target → intrinsic, no closure
    edges; non-default target → entry + closure edges/materialized default rows."""
    from nexus.services.default_library_closure import (
        add_media_to_non_default_closure,
        ensure_default_intrinsic,
    )
    from nexus.services.media_deletion import clear_user_media_deletion

    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_not_system(ctx.system_key)

        media_exists = db.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).fetchone()
        if media_exists is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        clear_user_media_deletion(db, viewer_id, media_id)

        if ctx.is_default:
            ensure_default_intrinsic(db, library_id, media_id)
        else:
            ensure_entry(db, library_id, media_target(media_id))
            add_media_to_non_default_closure(db, library_id, media_id)

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

    return _hydrate_entries(db, viewer_id, [row])[0]


def add_podcast_to_library(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> LibraryEntryOut:
    """Add a podcast to a non-default library. Admin-only; default forbidden; requires
    an ACTIVE subscription. No closure."""
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

        ensure_entry(db, library_id, podcast_target(podcast_id))
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

    return _hydrate_entries(db, viewer_id, [row])[0]


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


def _encode_entry_cursor(
    sort: LibraryEntrySort, row, *, resonance_as_of: datetime | None = None
) -> str:
    if sort == "position":
        payload: dict[str, object] = {
            "k": "library_entries:position",
            "position": int(row["position"]),
            "created_at": row["created_at"].isoformat(),
            "id": str(row["id"]),
        }
    elif sort == "resonance":
        if resonance_as_of is None:
            raise RuntimeError("resonance cursor requires resonance_as_of")
        payload = {
            "k": "library_entries:resonance",
            "as_of": resonance_as_of.isoformat(),
            "score": float(row["resonance_score"]),
            "id": str(row["id"]),
        }
    else:
        assert_never(sort)
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def _decode_entry_cursor(cursor: str, expected_sort: LibraryEntrySort) -> dict[str, object]:
    expected_key = f"library_entries:{expected_sort}"
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if payload.get("k") != expected_key:
            raise ValueError
        if expected_sort == "position":
            return {
                "position": int(payload["position"]),
                "created_at": datetime.fromisoformat(str(payload["created_at"])),
                "id": UUID(str(payload["id"])),
            }
        if expected_sort == "resonance":
            return {
                "as_of": datetime.fromisoformat(str(payload["as_of"])),
                "score": float(payload["score"]),
                "id": UUID(str(payload["id"])),
            }
        assert_never(expected_sort)
    except Exception:
        # justify-ignore-error: malformed cursor input is an expected API error path.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


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

    ``sort="position"`` (default) keeps EXACTLY the canonical `_ENTRY_ORDER`;
    ``sort="resonance"`` orders by the deterministic recency+connection score
    (`_RESONANCE_ORDER`, no request-time LLM, stable id tiebreak).
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    _start_of_today(viewer_timezone)
    limit = min(limit, 200)

    member = db.execute(
        text("SELECT 1 FROM memberships WHERE library_id = :library_id AND user_id = :viewer_id"),
        {"library_id": library_id, "viewer_id": viewer_id},
    ).fetchone()
    if member is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

    params: dict[str, object] = {"library_id": library_id, "limit": limit + 1}
    if sort == "resonance":
        # Lazy import: connection_summaries -> resolve -> library_entries is an
        # import cycle, so the S4 origin owner is read at call time, not import.
        from nexus.services.resource_graph.connection_summaries import LIST_CONNECTION_ORIGINS
        from nexus.services.semantic_chunks import transcript_embedding_dimensions

        decoded_cursor = _decode_entry_cursor(cursor, sort) if cursor is not None else None
        resonance_as_of = (
            decoded_cursor["as_of"]
            if decoded_cursor is not None
            else db.execute(text("SELECT now()")).scalar_one()
        )
        cursor_clause = ""
        if decoded_cursor is not None:
            cursor_clause = """
              AND (
                resonance_score < :cursor_score
                OR (resonance_score = :cursor_score AND id < :cursor_id)
              )
            """
            params.update(
                {
                    "cursor_score": decoded_cursor["score"],
                    "cursor_id": decoded_cursor["id"],
                }
            )
        params["viewer_id"] = viewer_id
        params["resonance_origins"] = list(LIST_CONNECTION_ORIGINS)
        params["embedding_dims"] = transcript_embedding_dimensions()
        params["resonance_as_of"] = resonance_as_of
        rows = (
            db.execute(
                text(f"""
                WITH scored AS (
                    SELECT {_ENTRY_COLUMNS}, {_RESONANCE_SCORE_SQL} AS resonance_score
                    FROM library_entries le
                    WHERE le.library_id = :library_id
                )
                SELECT {_ENTRY_COLUMNS}, resonance_score
                FROM scored
                WHERE 1 = 1
                  {cursor_clause}
                ORDER BY resonance_score DESC, id DESC
                LIMIT :limit
            """),
                params,
            )
            .mappings()
            .all()
        )
    elif sort == "position":
        cursor_clause = ""
        if cursor is not None:
            decoded_cursor = _decode_entry_cursor(cursor, sort)
            cursor_clause = """
              AND (
                le.position > :cursor_position
                OR (le.position = :cursor_position AND le.created_at < :cursor_created_at)
                OR (
                  le.position = :cursor_position
                  AND le.created_at = :cursor_created_at
                  AND le.id < :cursor_id
                )
              )
            """
            params.update(
                {
                    "cursor_position": decoded_cursor["position"],
                    "cursor_created_at": decoded_cursor["created_at"],
                    "cursor_id": decoded_cursor["id"],
                }
            )
        rows = (
            db.execute(
                text(f"""
                SELECT {_ENTRY_COLUMNS} FROM library_entries le
                WHERE le.library_id = :library_id
                  {cursor_clause}
                ORDER BY {_ENTRY_ORDER}
                LIMIT :limit
            """),
                params,
            )
            .mappings()
            .all()
        )
        resonance_as_of = None
    else:
        assert_never(sort)

    page_rows = rows[:limit]
    next_cursor = (
        _encode_entry_cursor(sort, page_rows[-1], resonance_as_of=resonance_as_of)
        if len(rows) > limit and page_rows
        else None
    )
    return (
        _hydrate_entries(db, viewer_id, page_rows, viewer_timezone=viewer_timezone),
        LibraryPageInfo(has_more=next_cursor is not None, next_cursor=next_cursor),
    )


def reorder_entries(
    db: Session, viewer_id: UUID, library_id: UUID, body: LibraryEntryOrderRequest
) -> list[LibraryEntryOut]:
    """Replace the full entry order for an admin viewer. The requested set must equal the
    existing set; the new order is applied in one set-based statement (already dense, so
    no follow-up renormalize)."""
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
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
    """Ensure media has intrinsic membership in the user's default library."""
    from nexus.services.default_library_closure import ensure_default_intrinsic
    from nexus.services.media_deletion import clear_user_media_deletion

    default_library_id = governance.default_library_id_for_user(db, user_id)
    ensure_default_intrinsic(db, default_library_id, media_id)
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
    from nexus.services.default_library_closure import add_media_to_non_default_closure
    from nexus.services.media_deletion import clear_user_media_deletion

    clear_user_media_deletion(db, viewer_id, media_id)
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
        add_media_to_non_default_closure(db, library_id, media_id)
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
