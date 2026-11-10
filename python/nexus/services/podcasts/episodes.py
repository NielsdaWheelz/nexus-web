"""Podcast audio queries and transcript eligibility on the shared source catalogue.

The caller owns one read-only repeatable-read snapshot for header and episodes.
Catalogue inspection and point tools require no subscription or library membership.
Selections exclude teardown, retain unsaved identities and never acquire holdings.
"""

from hashlib import sha256
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.services.collection_keyset import order_by_sql
from nexus.services.consumption import projection

_TRANSCRIBABLE = (
    "COALESCE(transcript_state, 'not_requested') IN ('not_requested', 'failed_provider')"
)


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
        FROM ({episode_source_rows_sql()}) pe
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


def selection_ids(
    db: Session, viewer_id: UUID, podcast_id: UUID, state: str, *, transcribable: bool = False
) -> list[UUID]:
    """The selection's known media ids, ordered by id; a missing show refuses."""
    if (
        db.scalar(text("SELECT 1 FROM feeds WHERE id=:id AND kind='podcast'"), {"id": podcast_id})
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    sql = _episodes_sql(where=f"AND {_TRANSCRIBABLE}" if transcribable else "")
    params = {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state}
    return list(db.scalars(text(f"SELECT media_id FROM ({sql}) s ORDER BY media_id"), params))


def selection_fingerprint(media_ids: list[UUID]) -> str:
    canonical = "\n".join(sorted(str(media_id) for media_id in media_ids))
    return sha256(f"nexus:podcast-episode-selection:v1\n{canonical}".encode()).hexdigest()


def ordered_selection_ids(
    db: Session, viewer_id: UUID, podcast_id: UUID, *, state: str, sort: wire.EpisodeSort
) -> tuple[str, list[UUID]]:
    """Complete known episode list in its owner's total order; no live cursor walk."""
    from nexus.services.feeds.entries import entry_order_plan, entry_rows_sql

    label = db.scalar(
        text("SELECT title FROM feeds WHERE id = :podcast_id AND kind='podcast'"),
        {"podcast_id": podcast_id},
    )
    if label is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    rows = db.execute(
        text(f"""SELECT media_id FROM ({entry_rows_sql()}) e WHERE feed_id=:podcast_id
            AND (:state='all' OR entry_state=:state)
            ORDER BY {order_by_sql(entry_order_plan(sort), alias="e")}"""),
        {
            "viewer_id": viewer_id,
            "podcast_id": podcast_id,
            "state": {"unplayed": "unread", "played": "finished"}.get(state, state),
        },
    )
    return label, [row.media_id for row in rows]


def episode_source_rows_sql() -> str:
    """Audio extension with its one shared entry's source/publication facts."""
    return """SELECT pe.*,entry.feed_id AS podcast_id,entry.published_at,
        entry.source_fingerprint AS rss_metadata_fingerprint
        FROM podcast_episodes pe JOIN feed_entries entry ON entry.id=pe.media_id"""
