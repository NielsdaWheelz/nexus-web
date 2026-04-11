"""Media service layer.

All media-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from __future__ import annotations

import base64
import json
import posixpath
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.db.models import Media, MediaKind, PodcastListeningState, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import (
    FragmentOut,
    FromUrlResponse,
    ListeningStateBatchUpsertRequest,
    ListeningStateOut,
    ListeningStateUpsertRequest,
    MediaAuthorOut,
    MediaOut,
    PodcastEpisodeChapterOut,
)
from nexus.services.capabilities import derive_capabilities
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.search import visible_media_ids_cte_sql
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url

logger = get_logger(__name__)

_MEDIA_BASE_SELECT_COLUMNS: tuple[str, ...] = (
    "m.id",
    "m.kind",
    "m.title",
    "m.canonical_source_url",
    "m.processing_status",
    "m.failure_stage",
    "m.last_error_code",
    "m.external_playback_url",
    "m.provider",
    "m.provider_id",
    "m.created_at",
    "m.updated_at",
    "EXISTS(SELECT 1 FROM media_file mf WHERE mf.media_id = m.id) AS has_file",
    "EXISTS(SELECT 1 FROM fragments f WHERE f.media_id = m.id) AS has_fragments",
    "m.published_date",
    "m.publisher",
    "m.language",
    "m.description",
    "pe.description_html AS podcast_description_html",
    "pe.description_text AS podcast_description_text",
    "mts.transcript_state",
    "mts.transcript_coverage",
    """(
        SELECT ps.default_playback_speed
        FROM podcast_episodes pe_sub
        JOIN podcast_subscriptions ps
          ON ps.podcast_id = pe_sub.podcast_id
         AND ps.user_id = :viewer_id
         AND ps.status = 'active'
        WHERE pe_sub.media_id = m.id
        LIMIT 1
    ) AS subscription_default_playback_speed""",
)
_MEDIA_LISTENING_STATE_SELECT_COLUMNS: tuple[str, ...] = (
    "pls.position_ms AS listening_position_ms",
    "pls.duration_ms AS listening_duration_ms",
    "pls.playback_speed AS listening_playback_speed",
    "pls.is_completed AS listening_is_completed",
)
_MEDIA_LISTENING_STATE_NULL_SELECT_COLUMNS: tuple[str, ...] = (
    "NULL::bigint AS listening_position_ms",
    "NULL::bigint AS listening_duration_ms",
    "NULL::double precision AS listening_playback_speed",
    "NULL::boolean AS listening_is_completed",
)


def _media_select_projection_sql(*, include_listening_state: bool) -> str:
    columns = list(_MEDIA_BASE_SELECT_COLUMNS)
    if include_listening_state:
        columns.extend(_MEDIA_LISTENING_STATE_SELECT_COLUMNS)
    else:
        columns.extend(_MEDIA_LISTENING_STATE_NULL_SELECT_COLUMNS)
    return ",\n                ".join(columns)


def _media_listening_state_join_sql(*, include_listening_state: bool) -> str:
    if not include_listening_state:
        return ""
    return """
            LEFT JOIN podcast_listening_states pls
              ON pls.media_id = m.id
             AND pls.user_id = :viewer_id
    """


def get_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaOut:
    """Get media by ID if readable by viewer.

    Returns media row if readable by viewer, including derived capabilities.
    Uses a single query that combines existence + visibility check.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media to fetch.

    Returns:
        The media if found and viewer can read it.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    rows = list_media_for_viewer_by_ids(db, viewer_id, [media_id])
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return rows[0]


def list_media_for_viewer_by_ids(
    db: Session,
    viewer_id: UUID,
    media_ids: list[UUID],
) -> list[MediaOut]:
    """Batch-hydrate viewer-visible media rows by ID, preserving input order."""
    if not media_ids:
        return []

    ordered_media_ids: list[UUID] = []
    seen_media_ids: set[UUID] = set()
    for media_id in media_ids:
        normalized_media_id = UUID(str(media_id))
        if normalized_media_id in seen_media_ids:
            continue
        seen_media_ids.add(normalized_media_id)
        ordered_media_ids.append(normalized_media_id)

    media_rows = (
        db.execute(
            text(
                f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT
                {_media_select_projection_sql(include_listening_state=True)}
            FROM media m
            JOIN visible_media vm
              ON vm.media_id = m.id
            LEFT JOIN media_transcript_states mts
              ON mts.media_id = m.id
            LEFT JOIN podcast_episodes pe
              ON pe.media_id = m.id
            {_media_listening_state_join_sql(include_listening_state=True)}
            WHERE m.id = ANY(:media_ids)
            """
            ),
            {"viewer_id": viewer_id, "media_ids": ordered_media_ids},
        )
        .mappings()
        .all()
    )

    if not media_rows:
        return []

    row_by_media_id: dict[UUID, Mapping[str, object]] = {}
    pdf_media_ids: list[UUID] = []
    for row in media_rows:
        media_id = UUID(str(row["id"]))
        row_by_media_id[media_id] = row
        if row["kind"] == MediaKind.pdf.value:
            pdf_media_ids.append(media_id)

    pdf_readiness = batch_pdf_quote_text_ready(db, pdf_media_ids) if pdf_media_ids else {}
    authors_by_media = _load_media_authors_by_ids(db, list(row_by_media_id.keys()))
    chapters_by_media = _load_podcast_episode_chapters_by_ids(db, list(row_by_media_id.keys()))

    media_list: list[MediaOut] = []
    for media_id in ordered_media_ids:
        row = row_by_media_id.get(media_id)
        if row is None:
            continue
        media_list.append(
            _media_out_from_row(
                row=row,
                authors=authors_by_media.get(media_id, []),
                chapters=chapters_by_media.get(media_id, []),
                pdf_quote_ready=pdf_readiness.get(media_id, False),
            )
        )
    return media_list


def _load_media_authors_by_ids(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, list[MediaAuthorOut]]:
    authors_by_media: dict[UUID, list[MediaAuthorOut]] = {media_id: [] for media_id in media_ids}
    if not media_ids:
        return authors_by_media

    author_rows = db.execute(
        text(
            "SELECT id, media_id, name, role FROM media_authors "
            "WHERE media_id = ANY(:ids) ORDER BY sort_order"
        ),
        {"ids": media_ids},
    ).fetchall()
    for author_row in author_rows:
        author_media_id = UUID(str(author_row[1]))
        authors_by_media.setdefault(author_media_id, []).append(
            MediaAuthorOut(id=author_row[0], name=author_row[2], role=author_row[3])
        )
    return authors_by_media


def _load_podcast_episode_chapters_by_ids(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, list[PodcastEpisodeChapterOut]]:
    chapters_by_media: dict[UUID, list[PodcastEpisodeChapterOut]] = {
        media_id: [] for media_id in media_ids
    }
    if not media_ids:
        return chapters_by_media

    chapter_rows = db.execute(
        text(
            """
            SELECT
                media_id,
                chapter_idx,
                title,
                t_start_ms,
                t_end_ms,
                url,
                image_url
            FROM podcast_episode_chapters
            WHERE media_id = ANY(:ids)
            ORDER BY media_id ASC, chapter_idx ASC
            """
        ),
        {"ids": media_ids},
    ).fetchall()
    for chapter_row in chapter_rows:
        chapter_media_id = UUID(str(chapter_row[0]))
        chapters_by_media.setdefault(chapter_media_id, []).append(
            PodcastEpisodeChapterOut(
                chapter_idx=int(chapter_row[1]),
                title=str(chapter_row[2]),
                t_start_ms=int(chapter_row[3]),
                t_end_ms=int(chapter_row[4]) if chapter_row[4] is not None else None,
                url=str(chapter_row[5]) if chapter_row[5] is not None else None,
                image_url=str(chapter_row[6]) if chapter_row[6] is not None else None,
            )
        )
    return chapters_by_media


def _media_listening_state_from_row(
    row: Mapping[str, object],
) -> ListeningStateOut | None:
    position_ms = row.get("listening_position_ms")
    playback_speed = row.get("listening_playback_speed")
    if position_ms is None or playback_speed is None:
        return None

    duration_ms = row.get("listening_duration_ms")
    return ListeningStateOut(
        position_ms=int(position_ms),
        duration_ms=int(duration_ms) if duration_ms is not None else None,
        playback_speed=float(playback_speed),
        is_completed=bool(row.get("listening_is_completed")),
    )


def _media_out_from_row(
    *,
    row: Mapping[str, object],
    authors: list[MediaAuthorOut],
    chapters: list[PodcastEpisodeChapterOut] | None = None,
    pdf_quote_ready: bool = False,
) -> MediaOut:
    processing_status = _status_to_str(row["processing_status"])
    capabilities = derive_capabilities(
        kind=row["kind"],
        processing_status=processing_status,
        last_error_code=row["last_error_code"],
        media_file_exists=bool(row["has_file"]),
        external_playback_url_exists=row["external_playback_url"] is not None,
        has_fragments=bool(row["has_fragments"]),
        pdf_quote_text_ready=pdf_quote_ready,
        transcript_state=row["transcript_state"],
        transcript_coverage=row["transcript_coverage"],
    )
    playback_source = derive_playback_source(
        kind=row["kind"],
        external_playback_url=row["external_playback_url"],
        canonical_source_url=row["canonical_source_url"],
        provider=row["provider"],
        provider_id=row["provider_id"],
    )
    return MediaOut(
        id=row["id"],
        kind=row["kind"],
        title=row["title"],
        canonical_source_url=row["canonical_source_url"],
        processing_status=processing_status,
        transcript_state=row["transcript_state"],
        transcript_coverage=row["transcript_coverage"],
        failure_stage=row["failure_stage"],
        last_error_code=row["last_error_code"],
        playback_source=playback_source,
        listening_state=_media_listening_state_from_row(row),
        subscription_default_playback_speed=(
            float(row["subscription_default_playback_speed"])
            if row.get("subscription_default_playback_speed") is not None
            else None
        ),
        chapters=chapters or [],
        capabilities=capabilities,
        authors=authors,
        published_date=row["published_date"],
        publisher=row["publisher"],
        language=row["language"],
        description=row["description"],
        description_html=row["podcast_description_html"],
        description_text=row["podcast_description_text"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def get_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> ListeningStateOut:
    """Get listener state for one media item scoped to the viewer."""
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    state = (
        db.query(PodcastListeningState)
        .filter(
            PodcastListeningState.user_id == viewer_id,
            PodcastListeningState.media_id == media_id,
        )
        .one_or_none()
    )
    if state is None:
        return ListeningStateOut(
            position_ms=0,
            duration_ms=None,
            playback_speed=1.0,
            is_completed=False,
        )

    return ListeningStateOut(
        position_ms=int(state.position_ms),
        duration_ms=int(state.duration_ms) if state.duration_ms is not None else None,
        playback_speed=float(state.playback_speed),
        is_completed=bool(state.is_completed),
    )


def _position_meets_completion_threshold(position_ms: int, duration_ms: int | None) -> bool:
    if duration_ms is None or duration_ms <= 0:
        return False
    return position_ms >= int(float(duration_ms) * 0.95)


def upsert_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    body: ListeningStateUpsertRequest,
) -> None:
    """Upsert listener state for one media item scoped to the viewer."""
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    existing_state = (
        db.query(PodcastListeningState)
        .filter(
            PodcastListeningState.user_id == viewer_id,
            PodcastListeningState.media_id == media_id,
        )
        .one_or_none()
    )
    current_position_ms = int(existing_state.position_ms) if existing_state is not None else 0
    current_duration_ms = (
        int(existing_state.duration_ms)
        if existing_state is not None and existing_state.duration_ms is not None
        else None
    )
    current_playback_speed = (
        float(existing_state.playback_speed) if existing_state is not None else 1.0
    )
    current_is_completed = (
        bool(existing_state.is_completed) if existing_state is not None else False
    )

    next_position_ms = (
        int(body.position_ms) if body.position_ms is not None else current_position_ms
    )
    next_duration_ms = (
        int(body.duration_ms) if body.duration_ms is not None else current_duration_ms
    )
    next_playback_speed = (
        float(body.playback_speed) if body.playback_speed is not None else current_playback_speed
    )

    if body.is_completed is not None:
        next_is_completed = bool(body.is_completed)
    elif body.position_ms is not None:
        next_is_completed = current_is_completed or _position_meets_completion_threshold(
            next_position_ms, next_duration_ms
        )
    else:
        next_is_completed = current_is_completed

    insert_values = {
        "user_id": viewer_id,
        "media_id": media_id,
        "position_ms": next_position_ms,
        "duration_ms": next_duration_ms,
        "playback_speed": next_playback_speed,
        "is_completed": next_is_completed,
    }
    update_values = {
        "position_ms": next_position_ms,
        "duration_ms": next_duration_ms,
        "playback_speed": next_playback_speed,
        "is_completed": next_is_completed,
        "updated_at": datetime.now(UTC),
    }

    db.execute(
        pg_insert(PodcastListeningState)
        .values(**insert_values)
        .on_conflict_do_update(
            index_elements=[
                PodcastListeningState.user_id,
                PodcastListeningState.media_id,
            ],
            set_=update_values,
        )
    )
    db.commit()


def batch_mark_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    body: ListeningStateBatchUpsertRequest,
) -> None:
    """Batch mark many visible podcast episodes as played/unplayed."""
    deduped_media_ids: list[UUID] = []
    seen_media_ids: set[UUID] = set()
    for media_id in body.media_ids:
        normalized_media_id = UUID(str(media_id))
        if normalized_media_id in seen_media_ids:
            continue
        seen_media_ids.add(normalized_media_id)
        deduped_media_ids.append(normalized_media_id)

    visible_rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT m.id, m.kind
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            WHERE m.id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": deduped_media_ids},
    ).fetchall()
    if len(visible_rows) != len(deduped_media_ids):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    invalid_kind_media_ids = [
        row[0] for row in visible_rows if row[1] != MediaKind.podcast_episode.value
    ]
    if invalid_kind_media_ids:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Batch listening-state updates are only supported for podcast episodes",
        )

    now = datetime.now(UTC)
    for media_id in deduped_media_ids:
        insert_values = {
            "user_id": viewer_id,
            "media_id": media_id,
            "position_ms": 0,
            "duration_ms": None,
            "playback_speed": 1.0,
            "is_completed": bool(body.is_completed),
        }
        update_values: dict[str, object] = {
            "is_completed": bool(body.is_completed),
            "updated_at": now,
        }
        if not body.is_completed:
            update_values["position_ms"] = 0

        db.execute(
            pg_insert(PodcastListeningState)
            .values(**insert_values)
            .on_conflict_do_update(
                index_elements=[
                    PodcastListeningState.user_id,
                    PodcastListeningState.media_id,
                ],
                set_=update_values,
            )
        )

    db.commit()


def _encode_media_cursor(updated_at: datetime, media_id: UUID) -> str:
    """Encode a keyset cursor for media listing pagination."""
    payload = {
        "updated_at": updated_at.isoformat(),
        "id": str(media_id),
    }
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def _decode_media_cursor(cursor: str) -> tuple[datetime, UUID]:
    """Decode a media listing keyset cursor."""
    try:
        # Restore stripped base64 padding for urlsafe decoding.
        if len(cursor) % 4:
            cursor += "=" * (4 - len(cursor) % 4)
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))
        updated_at = datetime.fromisoformat(payload["updated_at"])
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=UTC)
        media_id = UUID(payload["id"])
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None
    return updated_at, media_id


def _parse_kind_filter(kind: str | None) -> list[str] | None:
    """Parse and validate comma-separated media kind filter."""
    if not kind:
        return None

    parsed = sorted({token.strip() for token in kind.split(",") if token.strip()})
    if not parsed:
        return None

    valid_kinds = {value.value for value in MediaKind}
    invalid = [value for value in parsed if value not in valid_kinds]
    if invalid:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid media kind filter: {', '.join(invalid)}",
        )
    return parsed


def _escape_ilike_pattern(value: str) -> str:
    """Escape wildcard metacharacters for ILIKE pattern matching."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _status_to_str(value: object) -> str:
    """Normalize SQL enum/text status values to a plain string."""
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)


def list_visible_media(
    db: Session,
    viewer_id: UUID,
    *,
    kind: str | None = None,
    search: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[MediaOut], str | None]:
    """List viewer-visible media across all provenance paths with keyset pagination."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    limit = min(limit, 200)
    limit_plus_one = limit + 1
    parsed_kinds = _parse_kind_filter(kind)
    normalized_search = search.strip() if search else None
    if normalized_search == "":
        normalized_search = None

    where_clauses = ["1=1"]
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit_plus_one}

    if parsed_kinds:
        placeholders: list[str] = []
        for index, value in enumerate(parsed_kinds):
            key = f"kind_{index}"
            placeholders.append(f":{key}")
            params[key] = value
        where_clauses.append(f"m.kind IN ({', '.join(placeholders)})")

    if normalized_search:
        where_clauses.append(r"m.title ILIKE :search_pattern ESCAPE '\'")
        params["search_pattern"] = f"%{_escape_ilike_pattern(normalized_search)}%"

    if cursor:
        cursor_updated_at, cursor_id = _decode_media_cursor(cursor)
        where_clauses.append("(m.updated_at, m.id) < (:cursor_updated_at, :cursor_id)")
        params["cursor_updated_at"] = cursor_updated_at
        params["cursor_id"] = cursor_id

    query = text(f"""
        WITH visible_media AS (
            {visible_media_ids_cte_sql()}
        )
        SELECT
            {_media_select_projection_sql(include_listening_state=False)}
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
        LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
        WHERE {" AND ".join(where_clauses)}
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT :limit
    """)
    rows = db.execute(query, params).mappings().all()

    has_more = len(rows) > limit
    page_rows = rows[:limit]

    pdf_media_ids = [
        UUID(str(row["id"])) for row in page_rows if row["kind"] == MediaKind.pdf.value
    ]
    pdf_readiness = batch_pdf_quote_text_ready(db, pdf_media_ids) if pdf_media_ids else {}

    page_media_ids = [UUID(str(row["id"])) for row in page_rows]
    authors_by_media = _load_media_authors_by_ids(db, page_media_ids)
    chapters_by_media = _load_podcast_episode_chapters_by_ids(db, page_media_ids)

    media_list: list[MediaOut] = []
    for row in page_rows:
        media_id = UUID(str(row["id"]))
        media_list.append(
            _media_out_from_row(
                row=row,
                authors=authors_by_media.get(media_id, []),
                chapters=chapters_by_media.get(media_id, []),
                pdf_quote_ready=pdf_readiness.get(media_id, False),
            )
        )

    next_cursor = None
    if has_more and media_list:
        last = media_list[-1]
        next_cursor = _encode_media_cursor(last.updated_at, last.id)

    return media_list, next_cursor


def can_read_media(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    """Check if viewer can read a media item.

    Delegates to the canonical predicate in nexus.auth.permissions.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        True if viewer can read the media, False otherwise.
    """
    return _can_read_media(db, viewer_id, media_id)


def get_media_for_viewer_or_404(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> Media:
    """Get media by ID if readable by viewer, return the ORM model.

    Internal helper for service functions that need the ORM model.
    Returns Media row if readable by viewer.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media to fetch.

    Returns:
        The Media ORM model if found and viewer can read it.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    result = db.execute(
        text("SELECT * FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    )
    row = result.fetchone()

    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Query returns all columns, map to Media model
    return db.get(Media, media_id)


def create_provisional_web_article(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    enqueue_task: bool = False,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create a provisional web_article media row from a URL.

    This creates a media row with:
    - kind = 'web_article'
    - processing_status = 'pending'
    - requested_url = exactly as provided
    - canonical_url = NULL (set after redirect resolution during ingestion)
    - canonical_source_url = normalize_url_for_display(url)
    - title = truncated URL or 'Untitled'

    The media is immediately attached to the viewer's default library.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer creating the media.
        url: The URL to create a provisional media row for.
        enqueue_task: If True, enqueue ingestion task after creating media.
        request_id: Optional request ID for task correlation.

    Returns:
        FromUrlResponse with media_id, duplicate=False, processing_status='pending',
        and ingest_enqueued reflecting whether task was enqueued.

    Raises:
        InvalidRequestError: If URL validation fails.
        NotFoundError: If user's default library doesn't exist.
    """
    # Import here to avoid circular dependency
    from nexus.services.upload import _ensure_in_default_library

    # Validate URL (raises InvalidRequestError on failure)
    validate_requested_url(url)

    # Normalize for display/storage
    canonical_source = normalize_url_for_display(url)

    # Generate placeholder title from URL (truncate to 255 chars)
    title = url[:255] if url else "Untitled"

    now = datetime.now(UTC)

    # Create media row
    media = Media(
        kind=MediaKind.web_article.value,
        title=title,
        requested_url=url,
        canonical_url=None,  # Not set until ingestion resolves redirects
        canonical_source_url=canonical_source,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    db.flush()  # Get the generated ID

    # Attach to viewer's default library
    _ensure_in_default_library(db, viewer_id, media.id)

    ingest_enqueued = False
    try:
        if enqueue_task:
            ingest_enqueued = _enqueue_ingest_task(db, media.id, viewer_id, request_id)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return FromUrlResponse(
        media_id=media.id,
        duplicate=False,  # Always false at creation; dedup happens during ingestion
        idempotency_outcome="created",
        processing_status=ProcessingStatus.pending.value,
        ingest_enqueued=ingest_enqueued,
    )


def enqueue_media_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create media from URL with kind classification and enqueue ingestion.

    Classification:
    - YouTube variants -> shared `video` row (create-or-reuse by canonical video identity)
    - all other URLs -> provisional `web_article`
    """
    validate_requested_url(url)

    youtube_identity = classify_youtube_url(url)
    if youtube_identity is not None:
        return create_or_reuse_youtube_video(
            db=db,
            viewer_id=viewer_id,
            url=url,
            enqueue_task=True,
            request_id=request_id,
        )

    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "YouTube URL must include a valid video ID",
        )

    return create_provisional_web_article(
        db,
        viewer_id,
        url,
        enqueue_task=True,
        request_id=request_id,
    )


def create_or_reuse_youtube_video(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    enqueue_task: bool = False,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create-or-reuse a canonical YouTube video media row.

    Global idempotency is anchored by canonical watch URL derived from
    provider identity (YouTube video ID).
    """
    from nexus.services.upload import _ensure_in_default_library

    validate_requested_url(url)
    identity = classify_youtube_url(url)
    if identity is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL is not a supported YouTube video URL",
        )

    now = datetime.now(UTC)
    created = False
    media = Media(
        kind=MediaKind.video.value,
        title=f"YouTube Video {identity.provider_video_id}",
        requested_url=url,
        canonical_url=identity.watch_url,
        canonical_source_url=identity.watch_url,
        external_playback_url=identity.watch_url,
        provider=identity.provider,
        provider_id=identity.provider_video_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )

    try:
        db.add(media)
        db.flush()
        created = True
    except IntegrityError as exc:
        if not _is_media_canonical_url_conflict(exc):
            raise
        db.rollback()
        media = (
            db.query(Media)
            .filter(
                Media.kind == MediaKind.video.value,
                Media.canonical_url == identity.watch_url,
            )
            .limit(1)
            .one_or_none()
        )
        if media is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INTERNAL, "Unable to resolve canonical video row"
            ) from exc
        # Compatibility/backfill safety for pre-identity rows.
        media.provider = identity.provider
        media.provider_id = identity.provider_video_id
        if not media.external_playback_url:
            media.external_playback_url = identity.watch_url
        if not media.canonical_source_url:
            media.canonical_source_url = identity.watch_url
        media.updated_at = now

    _ensure_in_default_library(db, viewer_id, media.id)

    ingest_enqueued = False
    try:
        if created and enqueue_task:
            ingest_enqueued = _enqueue_youtube_ingest_task(db, media.id, viewer_id, request_id)
        db.commit()
    except Exception:
        db.rollback()
        raise

    processing_status = (
        media.processing_status.value
        if hasattr(media.processing_status, "value")
        else str(media.processing_status)
    )
    return FromUrlResponse(
        media_id=media.id,
        duplicate=not created,
        idempotency_outcome="created" if created else "reused",
        processing_status=processing_status,
        ingest_enqueued=ingest_enqueued,
    )


def enqueue_web_article_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create a provisional web_article and enqueue ingestion.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer creating the media.
        url: The URL to ingest.
        request_id: Optional request ID for task correlation.

    Returns:
        FromUrlResponse with ingest_enqueued=True.
    """
    return create_provisional_web_article(
        db,
        viewer_id,
        url,
        enqueue_task=True,
        request_id=request_id,
    )


def _enqueue_ingest_task(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> bool:
    """Enqueue ingest_web_article in the Postgres queue service."""
    try:
        enqueue_job(
            db,
            kind="ingest_web_article",
            payload={
                "media_id": str(media_id),
                "actor_user_id": str(actor_user_id),
                "request_id": request_id,
            },
        )
        logger.info(
            "ingest_task_enqueued",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
        )
        return True
    except Exception as exc:
        logger.error(
            "ingest_task_enqueue_failed",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error=str(exc),
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue ingest_web_article job.",
        ) from exc


def _enqueue_youtube_ingest_task(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> bool:
    """Enqueue ingest_youtube_video in the Postgres queue service."""
    try:
        enqueue_job(
            db,
            kind="ingest_youtube_video",
            payload={
                "media_id": str(media_id),
                "actor_user_id": str(actor_user_id),
                "request_id": request_id,
            },
        )
        logger.info(
            "ingest_video_task_enqueued",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
        )
        return True
    except Exception as exc:
        logger.error(
            "ingest_video_task_enqueue_failed",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error=str(exc),
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue ingest_youtube_video job.",
        ) from exc


def _is_media_canonical_url_conflict(exc: IntegrityError) -> bool:
    """Return True when IntegrityError is media canonical-url uniqueness conflict."""
    orig = getattr(exc, "orig", None)
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return constraint_name == "uix_media_canonical_url"
    return "uix_media_canonical_url" in str(exc)


def list_fragments_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> list[FragmentOut]:
    """List fragments for a media item if readable by viewer.

    Returns ordered fragments if media is readable.
    Uses the canonical visibility predicate.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        List of fragments ordered by idx ASC.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    # Check readability using the canonical predicate
    # This masks existence - both "not found" and "not readable" return 404
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Query 2: Fetch fragments ordered by idx ASC
    result = db.execute(
        text("""
            SELECT
                f.id,
                f.media_id,
                f.idx,
                f.html_sanitized,
                f.canonical_text,
                f.t_start_ms,
                f.t_end_ms,
                f.speaker_label,
                f.created_at
            FROM fragments f
            LEFT JOIN media_transcript_states mts
              ON mts.media_id = f.media_id
            WHERE f.media_id = :media_id
              AND (
                  f.transcript_version_id IS NULL
                  OR mts.active_transcript_version_id IS NULL
                  OR f.transcript_version_id = mts.active_transcript_version_id
              )
            ORDER BY f.t_start_ms ASC NULLS LAST, f.idx ASC
        """),
        {"media_id": media_id},
    )

    return [
        FragmentOut(
            id=row[0],
            media_id=row[1],
            idx=row[2],
            html_sanitized=row[3],
            canonical_text=row[4],
            t_start_ms=row[5],
            t_end_ms=row[6],
            speaker_label=row[7],
            created_at=row[8],
        )
        for row in result.fetchall()
    ]


# ---------------------------------------------------------------------------
# EPUB asset fetch (S5 PR-02)
# ---------------------------------------------------------------------------

_ASSET_KEY_RE = re.compile(r"^[a-zA-Z0-9_./ -]+$")

# Allowlist of content types served for EPUB-internal assets.
# Intentionally restrictive — only known-safe static asset types.
_EPUB_ASSET_CONTENT_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".css": "text/css",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str


def get_epub_asset_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage_client: StorageClientBase | None = None,
) -> EpubAssetOut:
    """Fetch an EPUB internal asset for an authorized viewer.

    Enforces visibility, kind, readiness, and key-format guards.
    Returns binary payload without exposing raw private storage URLs.
    """
    from nexus.errors import ApiError
    from nexus.storage import get_storage_client

    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != MediaKind.epub.value:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media")

    ready_states = {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
    }
    if media.processing_status not in ready_states:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    if not asset_key or not _ASSET_KEY_RE.match(asset_key):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")

    sc = storage_client or get_storage_client()
    storage_path = f"media/{media_id}/assets/{asset_key}"

    try:
        data = b"".join(sc.stream_object(storage_path))
    except Exception as exc:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found") from exc

    ext = posixpath.splitext(asset_key)[1].lower()
    content_type = _EPUB_ASSET_CONTENT_TYPES.get(ext, "application/octet-stream")

    return EpubAssetOut(data=data, content_type=content_type)
