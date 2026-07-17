"""Media catalog and browser-capture service layer."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    non_system_media_ref_exists_sql,
    visible_media_ids_cte_sql,
)
from nexus.db.models import MediaKind
from nexus.db.sql_patterns import escape_ilike_pattern
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.media import (
    FragmentOut,
    ListeningStateOut,
    MediaOut,
    PodcastEpisodeChapterOut,
)
from nexus.schemas.presence import absent, present
from nexus.services import attention
from nexus.services.capabilities import derive_capabilities, is_text_document_ready
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
)
from nexus.services.document_embeds import (
    document_embed_summaries_for_media,
    list_document_embeds_for_fragments,
)
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source

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
    "m.created_by_user_id = :viewer_id AS is_creator",
    "m.requested_url IS NOT NULL AS has_requested_url",
    """EXISTS(
        SELECT 1
        FROM media_source_attempts msa
        WHERE msa.media_id = m.id
          AND msa.status = 'failed'
          AND msa.source_type IN (
              'generic_web_url',
              'x_author_thread',
              'x_post',
              'youtube_video',
              'remote_pdf_url',
              'remote_epub_url',
              'uploaded_pdf_file',
              'uploaded_epub_file',
              'browser_article_capture',
              'browser_pdf_capture',
              'browser_epub_capture',
              'podcast_episode_transcript',
              'video_transcript'
          )
          AND NOT (
              msa.source_type IN (
                  'uploaded_pdf_file',
                  'uploaded_epub_file',
                  'browser_article_capture',
                  'browser_pdf_capture',
                  'browser_epub_capture'
              )
              AND m.last_error_code IN (
                  'E_SIGN_UPLOAD_FAILED',
                  'E_STORAGE_MISSING',
                  'E_STORAGE_ERROR',
                  'E_INVALID_FILE_TYPE'
              )
          )
          AND msa.id = (
              SELECT latest.id
              FROM media_source_attempts latest
              WHERE latest.media_id = m.id
              ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
              LIMIT 1
          )
    ) AS source_retry_available""",
    """EXISTS(
        SELECT 1
        FROM media_source_attempts msa
        WHERE msa.media_id = m.id
          AND msa.source_type IN (
              'generic_web_url',
              'x_author_thread',
              'x_post',
              'youtube_video',
              'remote_pdf_url',
              'remote_epub_url',
              'uploaded_pdf_file',
              'uploaded_epub_file',
              'browser_article_capture',
              'browser_pdf_capture',
              'browser_epub_capture',
              'podcast_episode_transcript',
              'video_transcript'
          )
          AND NOT (
              msa.source_type IN (
                  'uploaded_pdf_file',
                  'uploaded_epub_file',
                  'browser_article_capture',
                  'browser_pdf_capture',
                  'browser_epub_capture'
              )
              AND m.last_error_code IN (
                  'E_SIGN_UPLOAD_FAILED',
                  'E_STORAGE_MISSING',
                  'E_STORAGE_ERROR',
                  'E_INVALID_FILE_TYPE'
              )
          )
          AND msa.id = (
              SELECT latest.id
              FROM media_source_attempts latest
              WHERE latest.media_id = m.id
              ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
              LIMIT 1
          )
    ) AS source_refresh_available""",
    "m.published_date",
    "m.publisher",
    "m.language",
    "m.description",
    "m.authors_manually_managed",
    "m.metadata_enriched_at",
    "pe.description_html AS podcast_description_html",
    "pe.description_text AS podcast_description_text",
    "mts.transcript_state",
    "mts.transcript_coverage",
    "COALESCE(mcis.status, 'pending') AS retrieval_status",
    "mcis.status_reason AS retrieval_status_reason",
    f"""(
        m.kind IN ('pdf', 'epub', 'web_article')
        AND {non_system_media_ref_exists_sql("m.id")}
    ) AS can_delete""",
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


def _dedupe_uuid_order(values: Iterable[UUID]) -> list[UUID]:
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        normalized = UUID(str(value))
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


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
    *,
    is_admin: bool = False,
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
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    rows = list_media_for_viewer_by_ids(db, viewer_id, [media_id], is_admin=is_admin)
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return rows[0]


def list_media_for_viewer_by_ids(
    db: Session,
    viewer_id: UUID,
    media_ids: list[UUID],
    *,
    is_admin: bool = False,
) -> list[MediaOut]:
    """Batch-hydrate viewer-visible media rows by ID, preserving input order."""
    if not media_ids:
        return []

    ordered_media_ids = _dedupe_uuid_order(media_ids)

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
            LEFT JOIN content_index_states mcis
              ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
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
    contributors_by_media = load_contributor_credits_for_media(db, list(row_by_media_id.keys()))
    chapters_by_media = _load_podcast_episode_chapters_by_ids(db, list(row_by_media_id.keys()))
    embed_summaries_by_media = document_embed_summaries_for_media(db, list(row_by_media_id.keys()))

    media_list: list[MediaOut] = []
    for media_id in ordered_media_ids:
        row = row_by_media_id.get(media_id)
        if row is None:
            continue
        media = _media_out_from_row(
            row=row,
            contributors=contributors_by_media.get(media_id, []),
            chapters=chapters_by_media.get(media_id, []),
            pdf_quote_ready=pdf_readiness.get(media_id, False),
            is_admin=is_admin,
        )
        media.document_embed_summary = embed_summaries_by_media.get(media_id)
        media_list.append(media)
    _apply_consumption_state(db, viewer_id, media_list)
    return media_list


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
    contributors: list[ContributorCreditOut],
    chapters: list[PodcastEpisodeChapterOut] | None = None,
    pdf_quote_ready: bool = False,
    is_admin: bool = False,
) -> MediaOut:
    processing_status = _status_to_str(row["processing_status"])
    capabilities = derive_capabilities(
        kind=row["kind"],
        processing_status=processing_status,
        last_error_code=row["last_error_code"],
        media_file_exists=bool(row["has_file"]),
        external_playback_url_exists=row["external_playback_url"] is not None,
        pdf_quote_text_ready=pdf_quote_ready,
        transcript_state=row["transcript_state"],
        transcript_coverage=row["transcript_coverage"],
        retrieval_status=row["retrieval_status"],
        can_delete=bool(row.get("can_delete")),
        is_creator=bool(row.get("is_creator")),
        is_admin=is_admin,
        requested_url_exists=bool(row.get("has_requested_url"))
        and not (
            row["kind"] == MediaKind.web_article.value and row.get("provider") == "browser_capture"
        ),
        source_retry_available=bool(row.get("source_retry_available")),
        source_refresh_available=bool(row.get("source_refresh_available")),
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
        retrieval_status=row["retrieval_status"],
        retrieval_status_reason=row["retrieval_status_reason"],
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
        contributors=contributors,
        author_mode="manual" if row["authors_manually_managed"] else "automatic",
        published_date=row["published_date"],
        publisher=row["publisher"],
        language=row["language"],
        description=row["description"],
        description_html=row["podcast_description_html"],
        description_text=row["podcast_description_text"],
        metadata_enriched_at=row["metadata_enriched_at"],
        # Overwritten by `_apply_consumption_state` for a qualifying podcast
        # episode; every other media stays Absent.
        player_descriptor=absent(),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _apply_consumption_state(
    db: Session,
    viewer_id: UUID,
    media_outs: list[MediaOut],
) -> None:
    """Populate per-viewer read-state + engagement recency onto MediaOuts, in place.

    Read-state (`read_state`, `progress_fraction`) is derived by the consumption
    projection (`services.consumption`), which owns the explicit override +
    listening-threshold + attention-aggregate model. `last_engaged_at` is a distinct
    recency concern read through the listening owner (audio) and the attention owner
    (documents).
    """
    if not media_outs:
        return

    media_ids = [media.id for media in media_outs]
    states = consumption_service.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)
    for media in media_outs:
        state = states.get(media.id)
        if state is not None:
            media.read_state = state.state
            media.progress_fraction = state.progress_fraction

    # Engagement recency: audio rows take their listening-state recency (consumption
    # owner), documents their reading-session recency (attention owner).
    audio_media_ids = [media.id for media in media_outs if media.listening_state is not None]
    doc_media_ids = [media.id for media in media_outs if media.listening_state is None]

    if audio_media_ids:
        listening_updated_at_by_id = consumption_service.listening_recency(
            db, viewer_id=viewer_id, media_ids=audio_media_ids
        )
        for media in media_outs:
            if media.listening_state is not None:
                media.last_engaged_at = listening_updated_at_by_id.get(media.id)

    if doc_media_ids:
        doc_updated_at_by_id = attention.reading_recency(
            db, viewer_id=viewer_id, media_ids=doc_media_ids
        )
        for media in media_outs:
            if media.listening_state is None:
                media.last_engaged_at = doc_updated_at_by_id.get(media.id)

    # Player descriptor (spec §6): server-derived FooterAudio descriptor for
    # podcast-episode media, batched through the one projection owner to avoid
    # N+1 across a page (spec §4 "derive exactly like Lectern items"). Every
    # MediaOut already starts Absent (`_media_out_from_row`); only a qualifying
    # episode (playable audio -> FooterAudio) gets overwritten to Present.
    episode_media_ids = [
        media.id for media in media_outs if media.kind == MediaKind.podcast_episode.value
    ]
    if episode_media_ids:
        descriptors = consumption_service.player_descriptors(
            db, viewer_id=viewer_id, media_ids=episode_media_ids
        )
        for media in media_outs:
            descriptor = descriptors.get(media.id)
            if descriptor is not None:
                media.player_descriptor = present(descriptor)


def refresh_source_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict[str, object]:
    """Refresh source content through the durable source lifecycle."""
    from nexus.services.media_source_ingest import refresh_source_for_viewer as refresh_source

    return refresh_source(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        request_id=request_id,
    )


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
    except (KeyError, ValueError) as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from exc
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
    is_admin: bool = False,
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
        params["search_pattern"] = f"%{escape_ilike_pattern(normalized_search)}%"

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
            {_media_select_projection_sql(include_listening_state=True)}
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
        LEFT JOIN content_index_states mcis ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
        LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
        {_media_listening_state_join_sql(include_listening_state=True)}
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
    contributors_by_media = load_contributor_credits_for_media(db, page_media_ids)
    chapters_by_media = _load_podcast_episode_chapters_by_ids(db, page_media_ids)
    embed_summaries_by_media = document_embed_summaries_for_media(db, page_media_ids)

    media_list: list[MediaOut] = []
    for row in page_rows:
        media_id = UUID(str(row["id"]))
        media = _media_out_from_row(
            row=row,
            contributors=contributors_by_media.get(media_id, []),
            chapters=chapters_by_media.get(media_id, []),
            pdf_quote_ready=pdf_readiness.get(media_id, False),
            is_admin=is_admin,
        )
        media.document_embed_summary = embed_summaries_by_media.get(media_id)
        media_list.append(media)

    _apply_consumption_state(db, viewer_id, media_list)

    next_cursor = None
    if has_more and media_list:
        last = media_list[-1]
        next_cursor = _encode_media_cursor(last.updated_at, last.id)

    return media_list, next_cursor


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
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_row = db.execute(
        text("""
            SELECT m.kind, m.processing_status, mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :media_id
        """),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_kind = str(media_row[0])
    if media_kind in {
        "web_article",
        "epub",
        "podcast_episode",
        "video",
    } and not is_text_document_ready(
        media_kind,
        str(media_row[1]),
        str(media_row[2]) if media_row[2] is not None else None,
        str(media_row[3]) if media_row[3] is not None else None,
    ):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

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
            WHERE f.media_id = :media_id
            ORDER BY f.t_start_ms ASC NULLS LAST, f.idx ASC
        """),
        {"media_id": media_id},
    )

    fragments = [
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
    embeds_by_fragment = list_document_embeds_for_fragments(
        db, viewer_id=viewer_id, fragment_ids=[fragment.id for fragment in fragments]
    )
    for fragment in fragments:
        fragment.document_embeds = embeds_by_fragment.get(fragment.id, [])
    return fragments


@dataclass(frozen=True)
class MediaEventSnapshot:
    payload: dict[str, Any]
    terminal: bool  # owns the former route-level _TERMINAL_STATUSES


def read_event_snapshot(db: Session, *, viewer_id: UUID, media_id: UUID) -> MediaEventSnapshot:
    """State payload + terminal flag for the media-processing SSE.

    Raises E_MEDIA_NOT_FOUND if the media is gone/unreadable (the SSE tail treats
    that as a clean close).
    """
    media = get_media_for_viewer(db, viewer_id, media_id)
    payload = {
        "processing_status": media.processing_status,
        "last_error_code": media.last_error_code,
        "failure_stage": media.failure_stage,
        "capabilities": media.capabilities.model_dump(mode="json"),
        "transcript_state": media.transcript_state,
        "transcript_coverage": media.transcript_coverage,
        "updated_at": media.updated_at.isoformat(),
    }
    return MediaEventSnapshot(
        payload=payload,
        terminal=media.processing_status in ("ready_for_reading", "failed"),
    )
