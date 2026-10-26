"""Complete known episode indexes, atomic show detail and transcript eligibility.

The caller owns one read-only repeatable-read snapshot for header and episodes.
Catalogue inspection and point tools require no subscription or library membership.
Selections exclude teardown, retain unsaved identities and never acquire holdings.
"""

from hashlib import sha256
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.db.models import TranscriptState
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.services import media as media_service
from nexus.services.collection_keyset import KeysetValueKind, SortKey, order_by_sql
from nexus.services.consumption import projection

_TRANSCRIBABLE = (
    "COALESCE(transcript_state, 'not_requested') IN ('not_requested', 'failed_provider')"
)


def episode_publication_rows_sql() -> str:
    """``media_id, podcast_id, published_at``; the composing query owns visibility."""
    return "SELECT pe.media_id, pe.podcast_id, pe.published_at FROM podcast_episodes pe"


def episode_rows_sql() -> str:
    """Known eligible episodes with viewer state and canonical publication/duration facts."""
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    return f"""
        WITH visible_media AS ({requested_media_ids_cte_sql()})
        SELECT pe.media_id, pe.podcast_id, pe.published_at, pe.duration_seconds * 1000 AS source_duration_ms,
               COALESCE(pe.duration_seconds, 0) AS duration_sort,
               (pe.published_at IS NULL)::int AS published_missing,
               (pe.duration_seconds IS NULL)::int AS duration_missing,
               mts.transcript_state, co.revision AS expected_override_revision,
               {state} AS episode_state
        FROM podcast_episodes pe
        JOIN visible_media vm ON vm.media_id = pe.media_id
        LEFT JOIN media_transcript_states mts ON mts.media_id = pe.media_id
        {joins}
    """


def _episodes_sql(where: str = "") -> str:
    """The viewer's known episodes of ``:podcast_id`` in listening state ``:state``."""
    return f"""
        SELECT * FROM ({episode_rows_sql()}) e
        WHERE podcast_id = :podcast_id {where}
          AND (CAST(:state AS text) = 'all' OR episode_state = :state)
    """


def episode_counts(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastEpisodeCountsOut:
    """Exact known catalogue aggregate, independent of the episode list's view and pages."""
    row = (
        db.execute(
            text(f"""
        SELECT count(DISTINCT media_id)::integer AS known_count,
               count(DISTINCT media_id) FILTER (WHERE episode_state <> 'played')::integer AS unfinished_count
        FROM ({_episodes_sql()}) visible_episodes
    """),
            {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": "all"},
        )
        .mappings()
        .one()
    )
    return wire.PodcastEpisodeCountsOut(**row)


def selection_ids(
    db: Session, viewer_id: UUID, podcast_id: UUID, state: str, *, transcribable: bool = False
) -> list[UUID]:
    """The selection's known media ids, ordered by id; a missing show refuses."""
    if db.scalar(text("SELECT 1 FROM podcasts WHERE id=:id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    sql = _episodes_sql(where=f"AND {_TRANSCRIBABLE}" if transcribable else "")
    params = {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state}
    return list(db.scalars(text(f"SELECT media_id FROM ({sql}) s ORDER BY media_id"), params))


def selection_fingerprint(media_ids: list[UUID]) -> str:
    canonical = "\n".join(sorted(str(media_id) for media_id in media_ids))
    return sha256(f"nexus:podcast-episode-selection:v1\n{canonical}".encode()).hexdigest()


def episode_order_plan(sort: wire.EpisodeSort) -> list[SortKey]:
    """The total order shared by the complete index and ordered selection."""
    direction = "asc" if sort == "oldest" else "desc"
    published = [
        SortKey("published_missing", "asc", KeysetValueKind.Int),
        SortKey("published_at", direction, KeysetValueKind.DateTimeOrNull),
        SortKey("media_id", direction, KeysetValueKind.Uuid),
    ]
    if sort in ("newest", "oldest"):
        return published
    return [
        SortKey("duration_missing", "asc", KeysetValueKind.Int),
        SortKey("duration_sort", "asc" if sort == "duration_asc" else "desc", KeysetValueKind.Int),
        *published,
    ]


def _ordered_episodes_sql(sort: wire.EpisodeSort) -> str:
    order = order_by_sql(episode_order_plan(sort), alias="r")
    return f"SELECT * FROM ({_episodes_sql()}) r ORDER BY {order}"


def list_episodes(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    state: str,
    sort: wire.EpisodeSort,
) -> wire.PodcastEpisodeIndexOut:
    """The show's detail and every selected episode from the same read snapshot."""
    from nexus.services.podcasts.subscriptions_query import get_podcast_detail

    podcast = get_podcast_detail(db, viewer_id, podcast_id)
    rows = (
        db.execute(
            text(_ordered_episodes_sql(sort)),
            {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state},
        )
        .mappings()
        .all()
    )
    summaries = media_service.media_summaries(
        db, viewer_id=viewer_id, media_ids=[row["media_id"] for row in rows]
    )
    return wire.PodcastEpisodeIndexOut(
        podcast=podcast,
        items=[
            wire.PodcastEpisodeListItemOut(
                id=row["media_id"],
                media_summary=summaries[row["media_id"]],
                transcript_state=TranscriptState(row["transcript_state"] or "not_requested"),
            )
            for row in rows
        ],
    )


def ordered_selection_ids(
    db: Session, viewer_id: UUID, podcast_id: UUID, *, state: str, sort: wire.EpisodeSort
) -> tuple[str, list[UUID]]:
    """Complete known episode list in its owner's total order; no live cursor walk."""
    label = db.scalar(
        text("SELECT title FROM podcasts WHERE id = :podcast_id"),
        {"podcast_id": podcast_id},
    )
    if label is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    rows = db.execute(
        text(_ordered_episodes_sql(sort)),
        {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state},
    )
    return label, [row.media_id for row in rows]
