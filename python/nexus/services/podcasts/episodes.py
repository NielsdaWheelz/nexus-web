"""Podcast episode listing for a viewer."""

from __future__ import annotations

from hashlib import sha256
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.session import transaction
from nexus.db.sql_patterns import escape_ilike_pattern
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
from nexus.schemas.presence import Present, absent, present
from nexus.services import media as media_service
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
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


def normalize_episode_query(query: str | None) -> str | None:
    normalized = query.strip() if query is not None else None
    return normalized or None


def episode_selection(*, state: PodcastEpisodeState, query: str | None) -> PodcastEpisodeSelection:
    normalized = normalize_episode_query(query)
    return PodcastEpisodeSelection(
        state=state,
        query=present(normalized) if normalized is not None else absent(),
    )


def _selection_query_value(selection: PodcastEpisodeSelection) -> str | None:
    return normalize_episode_query(
        selection.query.value if isinstance(selection.query, Present) else None
    )


def _episode_query_identity(
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    state: PodcastEpisodeState,
    sort: PodcastEpisodeSort,
    query: str | None,
) -> dict[str, object]:
    return {
        "viewerId": str(viewer_id),
        "podcastId": str(podcast_id),
        "state": state,
        "sort": sort,
        "query": query,
    }


def _episode_order(
    sort: PodcastEpisodeSort,
) -> tuple[str, tuple[KeysetValueKind, ...]]:
    published = (
        KeysetValueKind.Int,
        KeysetValueKind.DateTimeOrNull,
        KeysetValueKind.Uuid,
    )
    if sort == "oldest":
        return (
            "published_missing ASC, published_at ASC, media_id ASC",
            published,
        )
    if sort == "newest":
        return (
            "published_missing ASC, published_at DESC, media_id DESC",
            published,
        )
    kinds = (
        KeysetValueKind.Int,
        KeysetValueKind.Int,
        KeysetValueKind.Int,
        KeysetValueKind.DateTimeOrNull,
        KeysetValueKind.Uuid,
    )
    duration_direction = "ASC" if sort == "duration_asc" else "DESC"
    return (
        f"duration_missing ASC, duration_seconds {duration_direction}, "
        "published_missing ASC, published_at DESC, media_id DESC",
        kinds,
    )


def _episode_keyset_predicate(
    sort: PodcastEpisodeSort,
    after: tuple[object, ...] | None,
    params: dict[str, object],
) -> str:
    if after is None:
        return "TRUE"
    if sort in {"newest", "oldest"}:
        missing, published, media_id = after
        params.update(
            after_published_missing=missing,
            after_published=published,
            after_media_id=media_id,
        )
        published_operator = ">" if sort == "oldest" else "<"
        id_operator = ">" if sort == "oldest" else "<"
        return f"""
            published_missing > :after_published_missing
            OR (published_missing = :after_published_missing
                AND :after_published_missing = 0
                AND published_at {published_operator} :after_published)
            OR (published_missing = :after_published_missing
                AND published_at IS NOT DISTINCT FROM :after_published
                AND media_id {id_operator} :after_media_id)
        """

    duration_missing, duration, published_missing, published, media_id = after
    params.update(
        after_duration_missing=duration_missing,
        after_duration=duration,
        after_published_missing=published_missing,
        after_published=published,
        after_media_id=media_id,
    )
    duration_operator = ">" if sort == "duration_asc" else "<"
    return f"""
        duration_missing > :after_duration_missing
        OR (duration_missing = :after_duration_missing
            AND :after_duration_missing = 0
            AND duration_seconds {duration_operator} :after_duration)
        OR (duration_missing = :after_duration_missing
            AND (duration_seconds IS NOT DISTINCT FROM
                 CASE WHEN :after_duration_missing = 1 THEN NULL ELSE :after_duration END)
            AND published_missing > :after_published_missing)
        OR (duration_missing = :after_duration_missing
            AND (duration_seconds IS NOT DISTINCT FROM
                 CASE WHEN :after_duration_missing = 1 THEN NULL ELSE :after_duration END)
            AND published_missing = :after_published_missing
            AND :after_published_missing = 0
            AND published_at < :after_published)
        OR (duration_missing = :after_duration_missing
            AND (duration_seconds IS NOT DISTINCT FROM
                 CASE WHEN :after_duration_missing = 1 THEN NULL ELSE :after_duration END)
            AND published_missing = :after_published_missing
            AND published_at IS NOT DISTINCT FROM :after_published
            AND media_id < :after_media_id)
    """


def _episode_after_values(
    sort: PodcastEpisodeSort,
    row: object,
) -> tuple[KeysetValue, ...]:
    mapped = cast(dict[str, object], row)
    published = (
        KeysetValue(KeysetValueKind.Int, int(mapped["published_missing"])),
        KeysetValue(KeysetValueKind.DateTimeOrNull, mapped["published_at"]),
        KeysetValue(KeysetValueKind.Uuid, UUID(str(mapped["media_id"]))),
    )
    if sort in {"newest", "oldest"}:
        return published
    return (
        KeysetValue(KeysetValueKind.Int, int(mapped["duration_missing"])),
        KeysetValue(
            KeysetValueKind.Int,
            int(mapped["duration_seconds"]) if mapped["duration_seconds"] is not None else 0,
        ),
        *published,
    )


def _episode_selection_sql(
    *,
    state: PodcastEpisodeState,
    query: str | None,
    params: dict[str, object],
) -> tuple[str, str]:
    state_predicate = "TRUE" if state == "all" else "episode_state = :episode_state"
    params["episode_state"] = state
    if query is None:
        return state_predicate, "TRUE"
    params["query_pattern"] = f"%{escape_ilike_pattern(query)}%"
    return state_predicate, r"m.title ILIKE :query_pattern ESCAPE '\'"


def resolve_episode_selection_ids(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    selection: PodcastEpisodeSelection,
) -> list[UUID]:
    """Resolve one normalized membership relation for query-wide commands."""
    query = _selection_query_value(selection)
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "podcast_id": podcast_id,
    }
    state_sql, query_sql = _episode_selection_sql(
        state=selection.state,
        query=query,
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
                JOIN media m ON m.id = pe.media_id
                {
                consumption_service.episode_state_joins_sql(
                    user_param=":viewer_id",
                    media_expr="pe.media_id",
                    listening_alias="pls",
                    override_alias="co",
                )
            }
                WHERE pe.podcast_id = :podcast_id
                  AND ({query_sql})
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
    q: str | None = None,
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

    normalized_query = normalize_episode_query(q)
    query_identity = _episode_query_identity(
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        state=state,
        sort=sort,
        query=normalized_query,
    )
    order_by_sql, cursor_kinds = _episode_order(sort)
    after = (
        decode_signed_keyset_cursor(
            cursor,
            family=CollectionFamily.PodcastEpisodes.value,
            query=query_identity,
            expected_kinds=cursor_kinds,
        )
        if cursor is not None
        else None
    )
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
    state_sql, query_sql = _episode_selection_sql(
        state=state,
        query=normalized_query,
        params=params,
    )
    keyset_sql = _episode_keyset_predicate(sort, after, params)

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
                JOIN media m
                  ON m.id = pe.media_id
                {
                    consumption_service.episode_state_joins_sql(
                        user_param=":viewer_id",
                        media_expr="pe.media_id",
                        listening_alias="pls",
                        override_alias="co",
                    )
                }
                WHERE pe.podcast_id = :podcast_id
                  AND ({query_sql})
            )
            SELECT *
            FROM episode_rows
            WHERE ({state_sql})
              AND ({keyset_sql})
            ORDER BY {order_by_sql}
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
    episode_state_by_media_id: dict[UUID, str] = {}
    row_by_media_id: dict[UUID, object] = {}
    for row in page_rows:
        media_id = row["media_id"]
        if media_id is None:
            continue
        normalized_media_id = UUID(str(media_id))
        ordered_media_ids.append(normalized_media_id)
        episode_state_by_media_id[normalized_media_id] = str(row["episode_state"])
        row_by_media_id[normalized_media_id] = row

    if not ordered_media_ids:
        return CollectionPage(
            items=[],
            collection_revision=revision,
            next_cursor=absent(),
        )

    episodes = media_service.list_collection_media_for_viewer_by_ids(
        db,
        viewer_id=viewer_id,
        media_ids=ordered_media_ids,
    )
    compact: list[PodcastEpisodeListItemOut] = []
    for episode in episodes:
        row = cast(dict[str, object], row_by_media_id[episode.id])
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
                            playback_speed=listening.playback_speed,
                        )
                    )
                    if listening is not None
                    else absent()
                ),
                episode_state=episode_state_by_media_id[episode.id],
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
                published_date=(
                    present(episode.published_date)
                    if episode.published_date is not None
                    else absent()
                ),
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
                after=_episode_after_values(sort, page_rows[-1]),
            )
        )
        if has_next
        else absent()
    )
    return CollectionPage(
        items=compact,
        collection_revision=revision,
        next_cursor=next_cursor,
    )
