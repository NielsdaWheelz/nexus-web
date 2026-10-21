"""Reads over one show's episodes: the list, the "all ⟨state⟩" selection, mark played.

A selection is resolved on the server from the viewer's visible episodes in a listening
state; commands act on it, never on rows a client happened to render.
"""

from hashlib import sha256
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import TranscriptState
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionPage
from nexus.services import media as media_service
from nexus.services.collection_keyset import KeysetValueKind, SortKey, keyset_page
from nexus.services.consumption import projection, state, viewer_txn
from nexus.services.suggestion_changes import record_input_change

EpisodeSort = Literal["newest", "oldest", "duration_asc", "duration_desc"]
_TRANSCRIBABLE = (
    "COALESCE(mts.transcript_state, 'not_requested') IN ('not_requested', 'failed_provider')"
)


def episode_publication_rows_sql() -> str:
    """``media_id, podcast_id, published_at``; the composing query owns visibility."""
    return "SELECT pe.media_id, pe.podcast_id, pe.published_at FROM podcast_episodes pe"


def _episodes_sql(columns: str = "", where: str = "") -> str:
    """The viewer's visible episodes of ``:podcast_id`` in listening state ``:state``."""
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        e AS (
            SELECT pe.media_id, {state} AS episode_state {columns}
            FROM podcast_episodes pe
            JOIN visible_media vm ON vm.media_id = pe.media_id
            LEFT JOIN media_transcript_states mts ON mts.media_id = pe.media_id
            {joins}
            WHERE pe.podcast_id = :podcast_id {where}
        )
        SELECT * FROM e WHERE (CAST(:state AS text) = 'all' OR e.episode_state = :state)
    """


def episode_counts(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastEpisodeCountsOut:
    """Exact visible aggregate, independent of the episode list's view and pages."""
    row = (
        db.execute(
            text(f"""
        SELECT count(DISTINCT media_id)::integer AS available_count,
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
    """The selection's media ids, ordered by id."""
    sql = _episodes_sql(where=f"AND {_TRANSCRIBABLE}" if transcribable else "")
    params = {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state}
    return list(db.scalars(text(f"SELECT media_id FROM ({sql}) s ORDER BY media_id"), params))


def selection_fingerprint(media_ids: list[UUID]) -> str:
    canonical = "\n".join(sorted(str(media_id) for media_id in media_ids))
    return sha256(f"nexus:podcast-episode-selection:v1\n{canonical}".encode()).hexdigest()


def mark_played(
    viewer_id: UUID, podcast_id: UUID, selection: str
) -> wire.PodcastEpisodeMarkPlayedOut:
    """Finish every episode of the selection under the viewer lock (I10)."""

    def run(db: Session) -> wire.PodcastEpisodeMarkPlayedOut:
        media_ids = selection_ids(db, viewer_id, podcast_id, selection)
        changed = state.set_episode_states_in_txn(
            db, viewer_id=viewer_id, media_ids=media_ids, state="Finished"
        )
        if changed:
            record_input_change(db)
        db.commit()
        return wire.PodcastEpisodeMarkPlayedOut(matched_count=len(media_ids), changed_count=changed)

    return viewer_txn("mark_played", viewer_id, run)


def _plan(sort: EpisodeSort) -> list[SortKey]:
    """The one total order behind the listing's ORDER BY, predicate and cursor."""
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


def list_episodes(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    limit: int,
    cursor: str | None,
    state: str,
    sort: EpisodeSort,
) -> CollectionPage[wire.PodcastEpisodeListItemOut]:
    if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    columns = """, pe.published_at, COALESCE(pe.duration_seconds, 0) AS duration_sort,
        (pe.published_at IS NULL)::int AS published_missing,
        (pe.duration_seconds IS NULL)::int AS duration_missing,
        NULLIF(BTRIM(pe.description_text), '') IS NOT NULL AS has_show_notes,
        mts.transcript_state"""
    rows, next_cursor = keyset_page(
        db,
        binding={
            "list": "PodcastEpisodes",
            "viewer": viewer_id,
            "podcast": podcast_id,
            "state": state,
            "sort": sort,
        },
        plan=_plan(sort),
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state},
        alias="r",
        sql=lambda keyset, order: f"""
            SELECT * FROM ({_episodes_sql(columns)}) r WHERE TRUE {keyset}
            ORDER BY {order} LIMIT :limit
        """,
    )
    page = {row["media_id"]: row for row in rows}
    summaries = media_service.media_summaries(db, viewer_id=viewer_id, media_ids=list(page))
    return CollectionPage(
        items=[
            wire.PodcastEpisodeListItemOut(
                id=media_id,
                media_summary=summary,
                transcript_state=TranscriptState(
                    page[media_id]["transcript_state"] or "not_requested"
                ),
                has_show_notes=page[media_id]["has_show_notes"],
            )
            for media_id, summary in summaries.items()
        ],
        next_cursor=next_cursor,
    )
