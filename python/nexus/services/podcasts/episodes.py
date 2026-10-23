"""A show's visible episode lists, transcript selections and versioned consumption snapshots.

Consumption preparation captures the complete selection in a read-only repeatable-read
snapshot. Apply checks that exact membership under the viewer lock; retries already at the
explicit desired override are inert, and other stale revisions refuse the whole batch.
"""

from hashlib import sha256
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

_TRANSCRIBABLE = (
    "COALESCE(transcript_state, 'not_requested') IN ('not_requested', 'failed_provider')"
)


def episode_publication_rows_sql() -> str:
    """``media_id, podcast_id, published_at``; the composing query owns visibility."""
    return "SELECT pe.media_id, pe.podcast_id, pe.published_at FROM podcast_episodes pe"


def episode_rows_sql() -> str:
    """Every readable episode and its canonical state/publication/duration order facts."""
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT pe.media_id, pe.podcast_id, pe.published_at,
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
    """The viewer's visible episodes of ``:podcast_id`` in listening state ``:state``."""
    return f"""
        SELECT * FROM ({episode_rows_sql()}) e
        WHERE podcast_id = :podcast_id {where}
          AND (CAST(:state AS text) = 'all' OR episode_state = :state)
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


def prepare_consumption(
    db: Session, viewer_id: UUID, podcast_id: UUID, selection: wire.EpisodeState
) -> wire.PodcastEpisodeConsumptionPreparedOut:
    """Capture every visible match and its nullable override revision, sorted by media id."""
    if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    sql = _episodes_sql()
    rows = db.execute(
        text(f"SELECT media_id, expected_override_revision FROM ({sql}) s ORDER BY media_id"),
        {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": selection},
    ).mappings()
    return wire.PodcastEpisodeConsumptionPreparedOut(
        items=[wire.PodcastEpisodeConsumptionItem(**row) for row in rows]
    )


def set_consumption(
    viewer_id: UUID, podcast_id: UUID, body: wire.PodcastEpisodeConsumptionRequest
) -> wire.PodcastEpisodeConsumptionOut:
    """Apply one frozen snapshot atomically; replay at the desired explicit state is inert."""

    def run(db: Session) -> wire.PodcastEpisodeConsumptionOut:
        if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": podcast_id}) is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        media_ids = [item.media_id for item in body.items]
        readable_ids = set(
            db.scalars(
                text(f"""
                    WITH visible_media AS ({visible_media_ids_cte_sql()})
                    SELECT pe.media_id FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    WHERE pe.podcast_id = :podcast_id AND pe.media_id = ANY(:media_ids)
                """),
                {"viewer_id": viewer_id, "podcast_id": podcast_id, "media_ids": media_ids},
            )
        )
        if readable_ids != set(media_ids):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Episode not found")
        changed = state.set_episode_states_in_txn(
            db, viewer_id=viewer_id, items=body.items, desired_state=body.desired_state
        )
        if changed:
            record_input_change(db)
        db.commit()
        return wire.PodcastEpisodeConsumptionOut(
            matched_count=len(media_ids), changed_count=changed
        )

    return viewer_txn("set_podcast_episode_consumption", viewer_id, run)


def episode_order_plan(sort: wire.EpisodeSort) -> list[SortKey]:
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
    sort: wire.EpisodeSort,
) -> CollectionPage[wire.PodcastEpisodeListItemOut]:
    if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": podcast_id}) is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    rows, next_cursor = keyset_page(
        db,
        binding={
            "list": "PodcastEpisodes",
            "viewer": viewer_id,
            "podcast": podcast_id,
            "state": state,
            "sort": sort,
        },
        plan=episode_order_plan(sort),
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state},
        alias="r",
        sql=lambda keyset, order: f"""
            SELECT * FROM ({_episodes_sql()}) r WHERE TRUE {keyset}
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
            )
            for media_id, summary in summaries.items()
        ],
        next_cursor=next_cursor,
    )


def playback_source_ids(
    db: Session, viewer_id: UUID, podcast_id: UUID, *, state: str, sort: wire.EpisodeSort
) -> tuple[str, list[UUID]]:
    """Complete visible episode list in its owner's total order; no live cursor walk."""
    from nexus.auth.permissions import visible_podcast_ids_cte_sql
    from nexus.services.collection_keyset import order_by_sql

    label = db.scalar(
        text(
            f"SELECT title FROM podcasts WHERE id = :podcast_id "
            f"AND id IN ({visible_podcast_ids_cte_sql()})"
        ),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    )
    if label is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    order = order_by_sql(episode_order_plan(sort), alias="r")
    ids = db.scalars(
        text(f"SELECT media_id FROM ({_episodes_sql()}) r ORDER BY {order}"),
        {"viewer_id": viewer_id, "podcast_id": podcast_id, "state": state},
    )
    return label, list(ids)
