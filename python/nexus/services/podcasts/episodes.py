"""Podcast episode listing for a viewer."""

from __future__ import annotations

from hashlib import sha256
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.collection_page import CollectionCursor, CollectionPage, CollectionRevision
from nexus.schemas.podcast import (
    PodcastEpisodeListCapabilitiesOut,
    PodcastEpisodeListeningStateOut,
    PodcastEpisodeListItemOut,
    PodcastEpisodeListPlayerDescriptorOut,
    PodcastEpisodeMarkPlayedOut,
    PodcastEpisodeSelection,
)
from nexus.schemas.presence import absent, present
from nexus.services import media as media_service
from nexus.services.collection_keyset import (
    Direction,
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
from nexus.services.consumption import service as consumption_service
from nexus.services.signed_keyset_cursor import (
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

PodcastEpisodeState = Literal["all", "unplayed", "in_progress", "played"]
PodcastEpisodeSort = Literal["newest", "oldest", "duration_asc", "duration_desc"]
PODCAST_EPISODE_STATES = frozenset({"all", "unplayed", "in_progress", "played"})
PODCAST_EPISODE_SORT_OPTIONS = frozenset({"newest", "oldest", "duration_asc", "duration_desc"})


def episode_publication_rows_sql() -> str:
    """Policy-neutral exact episode-publication facts.

    Columns: ``media_id``, ``podcast_id``, and nullable exact
    ``published_at``. Visibility and subscription policy belong to the
    composing query.
    """
    return """
        SELECT
            pe.media_id,
            pe.podcast_id,
            pe.published_at
        FROM podcast_episodes pe
    """


def _episode_query_identity(
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    state: PodcastEpisodeState,
    sort: PodcastEpisodeSort,
) -> dict[str, object]:
    return {
        "viewerId": str(viewer_id),
        "podcastId": str(podcast_id),
        "state": state,
        "sort": sort,
    }


def _episode_plan(sort: PodcastEpisodeSort) -> list[SortKey]:
    """The one total order behind this listing's ORDER BY, page predicate and cursor."""
    published_direction: Direction = "asc" if sort == "oldest" else "desc"
    published = [
        SortKey("published_missing", "asc", KeysetValueKind.Int),
        SortKey("published_at", published_direction, KeysetValueKind.DateTimeOrNull),
        SortKey("media_id", published_direction, KeysetValueKind.Uuid),
    ]
    if sort in {"newest", "oldest"}:
        return published
    return [
        SortKey("duration_missing", "asc", KeysetValueKind.Int),
        SortKey(
            "duration_sort",
            "asc" if sort == "duration_asc" else "desc",
            KeysetValueKind.Int,
        ),
        *published,
    ]


def _episode_state_predicate(
    *,
    state: PodcastEpisodeState,
    params: dict[str, object],
) -> str:
    state_predicate = "TRUE" if state == "all" else "episode_state = :episode_state"
    params["episode_state"] = state
    return state_predicate


def resolve_episode_selection_ids(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    selection: PodcastEpisodeSelection,
) -> list[UUID]:
    """Resolve one state-scoped membership relation for episode-wide commands."""
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "podcast_id": podcast_id,
    }
    state_sql = _episode_state_predicate(
        state=selection.state,
        params=params,
    )
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            selected AS (
                SELECT
                    pe.media_id,
                    {
                consumption_service.episode_state_case_sql(
                    listening_alias="pls",
                    override_alias="co",
                    episode_alias="pe",
                )
            } AS episode_state
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
                WHERE pe.podcast_id = :podcast_id
            )
            SELECT media_id
            FROM selected
            WHERE ({state_sql})
            ORDER BY media_id ASC
            """
        ),
        params,
    ).scalars()
    return [UUID(str(media_id)) for media_id in rows]


def resolve_transcript_eligible_episode_ids(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    selection: PodcastEpisodeSelection,
) -> list[UUID]:
    selected = resolve_episode_selection_ids(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        selection=selection,
    )
    if not selected:
        return []
    rows = db.execute(
        text(
            """
            SELECT m.id
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = ANY(:media_ids)
              AND COALESCE(mts.transcript_state, 'not_requested') IN (
                    'not_requested',
                    'failed_provider',
                    'failed_quota'
              )
            ORDER BY m.id ASC
            """
        ),
        {"media_ids": selected},
    ).scalars()
    return [UUID(str(media_id)) for media_id in rows]


def episode_selection_fingerprint(media_ids: list[UUID]) -> str:
    canonical = "\n".join(sorted(str(media_id) for media_id in media_ids))
    return sha256(f"nexus:podcast-episode-selection:v1\n{canonical}".encode()).hexdigest()


def mark_episode_selection_played(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    selection: PodcastEpisodeSelection,
) -> PodcastEpisodeMarkPlayedOut:
    with transaction(db):
        media_ids = resolve_episode_selection_ids(
            db,
            viewer_id=viewer_id,
            podcast_id=podcast_id,
            selection=selection,
        )
        changed_count = consumption_service.set_podcast_episode_states_in_txn(
            db,
            viewer_id=viewer_id,
            media_ids=media_ids,
            state="Finished",
        )
        revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastEpisodes,
        )
        return PodcastEpisodeMarkPlayedOut(
            matched_count=len(media_ids),
            changed_count=changed_count,
            collection_revision=revision,
        )


def list_podcast_episodes_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    limit: int,
    cursor: CollectionCursor | None,
    collection_revision: CollectionRevision | None,
    state: PodcastEpisodeState,
    sort: PodcastEpisodeSort,
) -> CollectionPage[PodcastEpisodeListItemOut]:
    if state not in PODCAST_EPISODE_STATES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast episode state")
    if sort not in PODCAST_EPISODE_SORT_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast episode sort option"
        )

    podcast_exists = db.execute(
        text(
            """
            SELECT 1
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchone()
    if podcast_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

    query_identity = _episode_query_identity(
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        state=state,
        sort=sort,
    )
    plan = _episode_plan(sort)
    revision = (
        read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastEpisodes,
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastEpisodes,
            expected=collection_revision,
        )
    )
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "podcast_id": podcast_id,
        "page_limit": limit + 1,
    }
    state_sql = _episode_state_predicate(
        state=state,
        params=params,
    )
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias="er")
        params.update(
            keyset_params(
                plan,
                decode_signed_keyset_cursor(
                    cursor,
                    family=CollectionFamily.PodcastEpisodes.value,
                    query=query_identity,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )

    episode_rows = (
        db.execute(
            text(
                f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            episode_rows AS (
                SELECT
                    pe.media_id,
                    pe.published_at,
                    pe.duration_seconds,
                    COALESCE(pe.duration_seconds, 0) AS duration_sort,
                    CASE WHEN pe.published_at IS NULL THEN 1 ELSE 0 END
                        AS published_missing,
                    CASE WHEN pe.duration_seconds IS NULL THEN 1 ELSE 0 END
                        AS duration_missing,
                    (NULLIF(BTRIM(pe.description_text), '') IS NOT NULL)
                        AS has_show_notes,
                    {
                    consumption_service.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } AS episode_state
                FROM podcast_episodes pe
                JOIN visible_media vm
                  ON vm.media_id = pe.media_id
                {
                    consumption_service.episode_state_joins_sql(
                        user_param=":viewer_id",
                        media_expr="pe.media_id",
                        listening_alias="pls",
                        override_alias="co",
                    )
                }
                WHERE pe.podcast_id = :podcast_id
            )
            SELECT er.*
            FROM episode_rows er
            WHERE ({state_sql})
            {keyset_sql}
            ORDER BY {order_by_sql(plan, alias="er")}
            LIMIT :page_limit
            """
            ),
            params,
        )
        .mappings()
        .all()
    )

    has_next = len(episode_rows) > limit
    page_rows = episode_rows[:limit]
    ordered_media_ids: list[UUID] = []
    row_by_media_id: dict[UUID, RowMapping] = {}
    for row in page_rows:
        media_id = row["media_id"]
        if media_id is None:
            continue
        normalized_media_id = UUID(str(media_id))
        ordered_media_ids.append(normalized_media_id)
        row_by_media_id[normalized_media_id] = row

    if not ordered_media_ids:
        return CollectionPage(
            items=[],
            collectionRevision=revision,
            nextCursor=absent(),
        )

    episodes = media_service.list_collection_media_for_viewer_by_ids(
        db,
        viewer_id=viewer_id,
        media_ids=ordered_media_ids,
    )
    compact: list[PodcastEpisodeListItemOut] = []
    for episode in episodes:
        row = row_by_media_id[episode.id]
        listening = episode.listening_state
        compact.append(
            PodcastEpisodeListItemOut(
                id=episode.id,
                kind="podcast_episode",
                title=episode.title,
                canonical_source_url=(
                    present(episode.canonical_source_url)
                    if episode.canonical_source_url is not None
                    else absent()
                ),
                offline_download_eligible=episode.offline_download_eligible,
                processing_status=episode.processing_status,
                transcript_state=episode.transcript_state or "not_requested",
                transcript_coverage=episode.transcript_coverage or "none",
                listening_state=(
                    present(
                        PodcastEpisodeListeningStateOut(
                            position_ms=listening.position_ms,
                            duration_ms=(
                                present(listening.duration_ms)
                                if listening.duration_ms is not None
                                else absent()
                            ),
                        )
                    )
                    if listening is not None
                    else absent()
                ),
                episode_state=row["episode_state"],
                progress_resettable=episode.progress_resettable,
                capabilities=PodcastEpisodeListCapabilitiesOut(
                    can_retry=episode.capabilities.can_retry,
                    can_refresh_source=episode.capabilities.can_refresh_source,
                    can_retry_metadata=episode.capabilities.can_retry_metadata,
                    can_edit_authors=episode.capabilities.can_edit_authors,
                    can_delete=episode.capabilities.can_delete,
                ),
                contributors=episode.contributors,
                author_mode=episode.author_mode,
                original_published_date=episode.original_published_date,
                duration_seconds=(
                    present(int(row["duration_seconds"]))
                    if row["duration_seconds"] is not None
                    else absent()
                ),
                has_show_notes=bool(row["has_show_notes"]),
                playerDescriptor=(
                    present(PodcastEpisodeListPlayerDescriptorOut(media_id=episode.id))
                    if episode.audio_playable
                    else absent()
                ),
            )
        )
    next_cursor = (
        present(
            encode_signed_keyset_cursor(
                family=CollectionFamily.PodcastEpisodes.value,
                query=query_identity,
                after=after_values(plan, page_rows[-1]),
            )
        )
        if has_next
        else absent()
    )
    return CollectionPage(
        items=compact,
        collectionRevision=revision,
        nextCursor=next_cursor,
    )
