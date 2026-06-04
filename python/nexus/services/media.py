"""Media catalog and browser-capture service layer."""

from __future__ import annotations

import base64
import json
import posixpath
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import Fragment, Media, MediaFile, MediaKind, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.db.sql_patterns import escape_ilike_pattern
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.media import (
    ArticleCaptureResponse,
    FragmentOut,
    FromUrlResponse,
    ListeningStateOut,
    MediaOut,
    PodcastEpisodeChapterOut,
)
from nexus.services import (
    library_entries,
    library_governance,
    web_article_indexing,
    x_ingest,
    youtube_ingest,
)
from nexus.services.capabilities import derive_capabilities
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    replace_media_contributor_credits,
)
from nexus.services.epub_lifecycle import delete_extraction_artifacts
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.media_processing_state import reset_for_reingest
from nexus.services.pdf_ingest import (
    delete_pdf_text_artifacts,
    invalidate_pdf_quote_match_metadata,
)
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.podcasts.transcription import requeue_podcast_transcription_for_source_refresh
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_staging_storage_path,
    get_file_extension,
)

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
    "m.published_date",
    "m.publisher",
    "m.language",
    "m.description",
    "m.metadata_enriched_at",
    "pe.description_html AS podcast_description_html",
    "pe.description_text AS podcast_description_text",
    "mts.transcript_state",
    "mts.transcript_coverage",
    "COALESCE(mcis.status, 'pending') AS retrieval_status",
    "mcis.status_reason AS retrieval_status_reason",
    """(
        SELECT ss.source_version
        FROM content_blocks cb
        JOIN source_snapshots ss
          ON ss.id = cb.source_snapshot_id
        WHERE cb.media_id = m.id
          AND cb.index_run_id = mcis.active_run_id
        ORDER BY cb.block_idx ASC
        LIMIT 1
    ) AS source_version""",
    """EXISTS(
        SELECT 1
        WHERE m.kind IN ('pdf', 'epub', 'web_article')
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
            LEFT JOIN media_content_index_states mcis
              ON mcis.media_id = m.id
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

    media_list: list[MediaOut] = []
    for media_id in ordered_media_ids:
        row = row_by_media_id.get(media_id)
        if row is None:
            continue
        media_list.append(
            _media_out_from_row(
                row=row,
                contributors=contributors_by_media.get(media_id, []),
                chapters=chapters_by_media.get(media_id, []),
                pdf_quote_ready=pdf_readiness.get(media_id, False),
            )
        )
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
        requested_url_exists=bool(row.get("has_requested_url"))
        and not (
            row["kind"] == MediaKind.web_article.value and row.get("provider") == "browser_capture"
        ),
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
        source_version=row["source_version"] if isinstance(row["source_version"], str) else None,
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
        published_date=row["published_date"],
        publisher=row["publisher"],
        language=row["language"],
        description=row["description"],
        description_html=row["podcast_description_html"],
        description_text=row["podcast_description_text"],
        metadata_enriched_at=row["metadata_enriched_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def refresh_source_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict[str, object]:
    """Requeue source acquisition for URL-backed media."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can refresh source content.",
        )

    if media.processing_status not in {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
        ProcessingStatus.failed,
    }:
        raise ConflictError(
            ApiErrorCode.E_MEDIA_NOT_READY,
            "Media source refresh is not available in the current processing state.",
        )

    if media.kind == MediaKind.web_article.value and (
        not media.requested_url or media.provider == "browser_capture"
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source refresh is not available because the original URL is missing.",
        )

    if media.kind == MediaKind.video.value and not (
        media.requested_url or media.canonical_source_url or media.external_playback_url
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source refresh is not available because the video source is missing.",
        )

    if media.kind == MediaKind.podcast_episode.value and not media.external_playback_url:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source refresh is not available because the episode audio source is missing.",
        )

    if media.kind in {MediaKind.pdf.value, MediaKind.epub.value} and media.media_file is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source file is missing.",
        )

    epub_storage_paths_to_delete: list[str] = []

    if media.kind == MediaKind.web_article.value:
        x_refresh = x_ingest.maybe_refresh_x_author_thread_media_for_viewer(
            db,
            viewer_id,
            media=media,
            request_id=request_id,
        )
        if x_refresh is not None:
            return x_refresh

    if media.kind == MediaKind.web_article.value:
        reset_for_reingest(db, media)
        _enqueue_ingest_task(db, media.id, viewer_id, request_id)
    elif media.kind == MediaKind.video.value:
        reset_for_reingest(db, media)
        youtube_ingest.enqueue_youtube_ingest_task(db, media.id, viewer_id, request_id)
    elif media.kind == MediaKind.pdf.value:
        invalidate_pdf_quote_match_metadata(db, media.id)
        delete_pdf_text_artifacts(db, media.id)
        reset_for_reingest(db, media)
        enqueue_job(
            db,
            kind="ingest_pdf",
            payload={
                "media_id": str(media.id),
                "request_id": request_id,
                "embedding_only": False,
            },
        )
    elif media.kind == MediaKind.epub.value:
        epub_storage_paths_to_delete = delete_extraction_artifacts(db, media.id)
        reset_for_reingest(db, media)
        enqueue_job(
            db,
            kind="ingest_epub",
            payload={
                "media_id": str(media.id),
                "request_id": request_id,
            },
        )
    else:
        requeue_podcast_transcription_for_source_refresh(
            db,
            media_id=media.id,
            requested_by_user_id=viewer_id,
            request_id=request_id,
        )

    db.commit()

    if epub_storage_paths_to_delete:
        storage_client = get_storage_client()
        for path in epub_storage_paths_to_delete:
            try:
                storage_client.delete_object(path)
            except StorageError as exc:
                # justify-ignore-error: refresh committed the DB artifact reset first,
                # so stale extraction objects are now unreachable and can be removed
                # by operational cleanup without corrupting DB/storage references.
                logger.warning(
                    "epub_refresh_artifact_storage_delete_failed media_id=%s storage_path=%s error=%s",
                    media.id,
                    path,
                    exc.message,
                )

    return {
        "media_id": str(media.id),
        "processing_status": "extracting",
        "refresh_enqueued": True,
    }


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
            {_media_select_projection_sql(include_listening_state=False)}
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
        LEFT JOIN media_content_index_states mcis ON mcis.media_id = m.id
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
    contributors_by_media = load_contributor_credits_for_media(db, page_media_ids)
    chapters_by_media = _load_podcast_episode_chapters_by_ids(db, page_media_ids)

    media_list: list[MediaOut] = []
    for row in page_rows:
        media_id = UUID(str(row["id"]))
        media_list.append(
            _media_out_from_row(
                row=row,
                contributors=contributors_by_media.get(media_id, []),
                chapters=chapters_by_media.get(media_id, []),
                pdf_quote_ready=pdf_readiness.get(media_id, False),
            )
        )

    next_cursor = None
    if has_more and media_list:
        last = media_list[-1]
        next_cursor = _encode_media_cursor(last.updated_at, last.id)

    return media_list, next_cursor


def create_captured_web_article(
    db: Session,
    viewer_id: UUID,
    *,
    url: str,
    content_html: str,
    library_ids: list[UUID],
    title: str | None = None,
    byline: str | None = None,
    excerpt: str | None = None,
    site_name: str | None = None,
    published_time: str | None = None,
) -> ArticleCaptureResponse:
    """Persist a browser-rendered article capture as readable media."""
    library_governance.validate_libraries_accessible(db, viewer_id, library_ids)
    validate_requested_url(url)

    if len(content_html.encode("utf-8")) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_CAPTURE_TOO_LARGE,
            "Captured article HTML is too large",
        )

    try:
        prepared = prepare_web_article_fragment(
            html=content_html,
            base_url=url,
            fragment_idx=0,
            media_title=title,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED,
            "Captured article could not be sanitized",
        ) from exc

    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Captured article has no readable text",
        )

    now = datetime.now(UTC)
    media = Media(
        kind=MediaKind.web_article.value,
        title=(title or url).strip()[:255] or "Untitled",
        requested_url=url,
        canonical_url=None,
        canonical_source_url=normalize_url_for_display(url),
        provider="browser_capture",
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        description=excerpt.strip()[:2000] if excerpt and excerpt.strip() else None,
        publisher=site_name.strip()[:255] if site_name and site_name.strip() else None,
        published_date=published_time.strip()[:64]
        if published_time and published_time.strip()
        else None,
    )

    try:
        db.add(media)
        db.flush()
        fragment = Fragment(
            media_id=media.id,
            idx=0,
            html_sanitized=prepared.html_sanitized,
            canonical_text=canonical_text,
        )
        db.add(fragment)
        db.flush()
        insert_fragment_blocks(db, fragment.id, prepared.fragment_blocks)

        if byline and byline.strip():
            clean_byline = re.sub(r"^by\s+", "", byline.strip(), flags=re.IGNORECASE)
            credits: list[dict[str, object]] = []
            for ordinal, name in enumerate(
                re.split(r"\s*[,;]\s*|\s+and\s+", clean_byline, flags=re.IGNORECASE)
            ):
                if name.strip():
                    credits.append(
                        {
                            "name": name.strip(),
                            "role": "author",
                            "ordinal": ordinal,
                            "source": "web_article_capture",
                            "source_ref": {"media_id": str(media.id)},
                        }
                    )
            replace_media_contributor_credits(db, media_id=media.id, credits=credits)

        library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
        fragment_id = fragment.id
        media_id = media.id
        media_language = media.language
        db.commit()
    except Exception:
        db.rollback()
        raise

    web_article_indexing.rebuild_web_article_index_or_mark_failed(
        db,
        media_id=media_id,
        fragment_id=fragment_id,
        fragments=[fragment],
        reason="web_article_capture",
        language=media_language,
        log_event="captured_web_article_content_index_failed",
    )

    _try_enrich_dispatch(str(media.id), None)

    library_entries.assign_libraries_for_media(db, viewer_id, media_id, library_ids)

    return ArticleCaptureResponse(
        media_id=media.id,
        processing_status=ProcessingStatus.ready_for_reading.value,
    )


def create_captured_file(
    db: Session,
    viewer_id: UUID,
    *,
    payload: bytes,
    filename: str,
    content_type: str,
    library_ids: list[UUID],
    source_url: str | None = None,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Persist a browser-fetched PDF/EPUB and run the existing file ingest lifecycle."""
    from nexus.services.epub_lifecycle import confirm_ingest_for_viewer

    library_governance.validate_libraries_accessible(db, viewer_id, library_ids)
    cleaned_filename = (filename or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    lower_filename = cleaned_filename.lower()

    if normalized_content_type == "application/pdf":
        kind = MediaKind.pdf.value
    elif normalized_content_type == "application/epub+zip":
        kind = MediaKind.epub.value
    elif lower_filename.endswith(".pdf"):
        kind = MediaKind.pdf.value
        normalized_content_type = "application/pdf"
    elif lower_filename.endswith(".epub"):
        kind = MediaKind.epub.value
        normalized_content_type = "application/epub+zip"
    else:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            "Captured files must be PDF or EPUB.",
        )

    if not payload:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Captured file is empty.")

    validate_file_ingest_request(kind, normalized_content_type, len(payload))
    if not has_valid_file_signature(payload, kind):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE,
            f"Captured file is not a valid {kind.upper()}.",
        )

    clean_source_url = source_url.strip() if source_url and source_url.strip() else None
    if clean_source_url is not None:
        validate_requested_url(clean_source_url)

    media_id = uuid4()
    storage_path = build_upload_staging_storage_path(media_id, get_file_extension(kind))
    storage_client = get_storage_client()
    try:
        storage_client.put_object(storage_path, payload, normalized_content_type)
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Failed to store captured file.") from exc

    title = cleaned_filename
    if not title and clean_source_url is not None:
        title = unquote(posixpath.basename(urlparse(clean_source_url).path)).strip()
        if not title:
            title = f"download.{get_file_extension(kind)}"
    if not title:
        title = f"capture.{get_file_extension(kind)}"

    now = datetime.now(UTC)
    media = Media(
        id=media_id,
        kind=kind,
        title=title[:255],
        requested_url=clean_source_url,
        canonical_source_url=(
            normalize_url_for_display(clean_source_url) if clean_source_url is not None else None
        ),
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    media_file = MediaFile(
        media_id=media_id,
        storage_path=storage_path,
        content_type=normalized_content_type,
        size_bytes=len(payload),
    )

    try:
        db.add(media)
        db.add(media_file)
        db.flush()
        library_entries.ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()
    except Exception:
        db.rollback()
        try:
            storage_client.delete_object(storage_path)
        except StorageError as cleanup_error:
            # justify-ignore-error: captured upload cleanup is best-effort;
            # preserving the original DB failure gives the caller the actionable error.
            logger.warning(
                "captured_file_cleanup_failed media_id=%s storage_path=%s error=%s",
                media_id,
                storage_path,
                cleanup_error,
            )
        raise

    result = confirm_ingest_for_viewer(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        library_ids=[],
        request_id=request_id,
    )
    resolved_media_id = UUID(result["media_id"])
    library_entries.assign_libraries_for_media(db, viewer_id, resolved_media_id, library_ids)
    return FromUrlResponse(
        media_id=resolved_media_id,
        idempotency_outcome="reused" if result["duplicate"] else "created",
        processing_status=str(result["processing_status"]),
        ingest_enqueued=bool(result["ingest_enqueued"]),
    )


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
        FromUrlResponse with media_id, processing_status='pending', and
        ingest_enqueued reflecting whether task was enqueued.

    Raises:
        InvalidRequestError: If URL validation fails.
        NotFoundError: If user's default library doesn't exist.
    """
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

    library_entries.ensure_media_in_default_library(db, viewer_id, media.id)

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
        idempotency_outcome="created",
        processing_status=ProcessingStatus.pending.value,
        ingest_enqueued=ingest_enqueued,
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
    except SQLAlchemyError as exc:
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


def _try_enrich_dispatch(media_id: str, request_id: str | None) -> None:
    session_factory = get_session_factory()
    db = session_factory()
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": media_id, "request_id": request_id},
            max_attempts=1,
        )
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()


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
                f_source.source_version,
                f.created_at
            FROM fragments f
            LEFT JOIN podcast_transcript_versions ptv
              ON ptv.media_id = f.media_id AND ptv.is_active
            LEFT JOIN media_content_index_states mcis
              ON mcis.media_id = f.media_id
            LEFT JOIN LATERAL (
                SELECT ss.source_version
                FROM content_blocks cb
                JOIN source_snapshots ss
                  ON ss.id = cb.source_snapshot_id
                WHERE cb.media_id = f.media_id
                  AND cb.index_run_id = mcis.active_run_id
                  AND (
                      cb.locator->>'fragment_id' = f.id::text
                      OR (
                          cb.locator->>'kind' = 'transcript_time_text'
                          AND f.t_start_ms IS NOT NULL
                          AND f.t_end_ms IS NOT NULL
                          AND CAST(cb.locator->>'t_start_ms' AS integer) < f.t_end_ms
                          AND CAST(cb.locator->>'t_end_ms' AS integer) > f.t_start_ms
                      )
                  )
                ORDER BY cb.block_idx ASC
                LIMIT 1
            ) f_source ON TRUE
            WHERE f.media_id = :media_id
              AND (
                  f.transcript_version_id IS NULL
                  OR ptv.id IS NULL
                  OR f.transcript_version_id = ptv.id
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
            source_version=row[8],
            created_at=row[9],
        )
        for row in result.fetchall()
    ]


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
        payload=payload, terminal=media.processing_status in ("ready", "failed")
    )
