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
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionCursor, CollectionPage
from nexus.schemas.presence import absent, present
from nexus.services import media as media_service
from nexus.services.collection_keyset import (
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import projection
from nexus.services.consumption import service as consumption
from nexus.services.keyset_cursor import KeysetValueKind, decode_keyset_cursor, encode_keyset_cursor

EpisodeSort = Literal["newest", "oldest", "duration_asc", "duration_desc"]
_FAMILY = CollectionFamily.PodcastEpisodes
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
    db: Session, viewer_id: UUID, podcast_id: UUID, state: str
) -> wire.PodcastEpisodeMarkPlayedOut:
    with transaction(db):
        media_ids = selection_ids(db, viewer_id, podcast_id, state)
        changed = consumption.set_podcast_episode_states_in_txn(
            db, viewer_id=viewer_id, media_ids=media_ids, state="Finished"
        )
        return wire.PodcastEpisodeMarkPlayedOut(matched_count=len(media_ids), changed_count=changed)


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
    cursor: CollectionCursor | None,
    revision: int | None,
    state: str,
    sort: EpisodeSort,
) -> CollectionPage[wire.PodcastEpisodeListItemOut]:
    if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    current = (
        read_collection_revision(db, viewer_id=viewer_id, family=_FAMILY)
        if revision is None
        else require_collection_revision(db, viewer_id=viewer_id, family=_FAMILY, expected=revision)
    )
    plan = _plan(sort)
    identity = {
        "viewerId": str(viewer_id),
        "podcastId": str(podcast_id),
        "state": state,
        "sort": sort,
    }
    params = {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state, "limit": limit + 1}
    keyset = ""
    if cursor is not None:
        after = decode_keyset_cursor(
            cursor, family=_FAMILY.value, query=identity, expected_kinds=expected_kinds(plan)
        )
        params.update(keyset_params(plan, after))
        keyset = keyset_clause(plan, alias="r")
    columns = """, pe.published_at, COALESCE(pe.duration_seconds, 0) AS duration_sort,
        (pe.published_at IS NULL)::int AS published_missing,
        (pe.duration_seconds IS NULL)::int AS duration_missing,
        NULLIF(BTRIM(pe.description_text), '') IS NOT NULL AS has_show_notes"""
    rows = (
        db.execute(
            text(f"""
                SELECT * FROM ({_episodes_sql(columns)}) r WHERE TRUE {keyset}
                ORDER BY {order_by_sql(plan, alias="r")} LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )
    page = {row["media_id"]: row for row in rows[:limit]}
    media = media_service.list_collection_media_for_viewer_by_ids(
        db, viewer_id=viewer_id, media_ids=list(page)
    )
    return CollectionPage(
        items=[
            wire.PodcastEpisodeListItemOut(
                id=episode.id,
                mediaSummary=episode.summary,
                transcript_state=TranscriptState(episode.transcript_state or "not_requested"),
                has_show_notes=page[episode.id]["has_show_notes"],
            )
            for episode in media
        ],
        collectionRevision=current,
        nextCursor=present(
            encode_keyset_cursor(
                family=_FAMILY.value, query=identity, after=after_values(plan, rows[limit - 1])
            )
        )
        if len(rows) > limit
        else absent(),
    )
