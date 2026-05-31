"""Media service layer.

All media-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from __future__ import annotations

import base64
import hashlib
import json
import posixpath
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import unquote, urljoin, urlparse
from uuid import UUID, uuid4

import httpx

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    FailureStage,
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    PodcastListeningState,
    ProcessingStatus,
)
from nexus.db.session import get_session_factory, transaction
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
from nexus.services import libraries as libraries_service
from nexus.services.capabilities import derive_capabilities
from nexus.services.content_indexing import (
    delete_media_content_index,
    mark_content_index_failed,
    rebuild_fragment_content_index,
)
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    replace_media_contributor_credits,
)
from nexus.services.epub_lifecycle import delete_extraction_artifacts
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.fragment_blocks import FragmentBlockSpec, insert_fragment_blocks
from nexus.services.pdf_ingest import (
    delete_pdf_text_artifacts,
    invalidate_pdf_quote_match_metadata,
)
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.podcasts.transcripts import requeue_podcast_transcription_for_source_refresh
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.web_article_structure import prepare_web_article_fragment
from nexus.services.x_api import (
    XAuthorThreadSnapshot,
    XPostSnapshot,
    canonical_x_post_url,
    fetch_author_thread_snapshot,
    post_description,
    post_title,
    render_author_thread_fragment_html,
    render_single_post_html,
    thread_description,
    thread_title,
    x_author_thread_provider_id,
)
from nexus.services.x_identity import classify_x_url, is_x_url
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_staging_storage_path,
    get_file_extension,
)

logger = get_logger(__name__)

_REMOTE_FILE_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "epub": "application/epub+zip",
}
_REMOTE_FILE_CHUNK_BYTES = 1024 * 1024
_REMOTE_FILE_REDIRECT_LIMIT = 3
_REMOTE_FILE_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_REMOTE_FILE_USER_AGENT = "Nexus Media Ingestion/1.0"
_CAPTURED_ARTICLE_HTML_MAX_BYTES = 2 * 1024 * 1024
_X_OEMBED_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

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


@dataclass(frozen=True)
class _PreparedXFragment:
    fragment: Fragment
    fragment_blocks: list[FragmentBlockSpec]


@dataclass(frozen=True)
class _WebArticleIndexTarget:
    media_id: UUID
    fragment_id: UUID
    fragments: list[Fragment]
    reason: str
    language: str | None


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


def get_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> ListeningStateOut:
    """Get listener state for one media item scoped to the viewer."""
    if not can_read_media(db, viewer_id, media_id):
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

    x_refresh_identity = _x_refresh_identity(media)
    if media.kind == MediaKind.web_article.value and x_refresh_identity is not None:
        x_refresh_post_id, x_refresh_username_hint = x_refresh_identity
        return _refresh_x_author_thread_media_for_viewer(
            db,
            viewer_id,
            media=media,
            post_id=x_refresh_post_id,
            username_hint=x_refresh_username_hint,
            request_id=request_id,
        )

    if media.kind == MediaKind.web_article.value:
        _reset_media_for_reingest(media)
        _enqueue_ingest_task(db, media.id, viewer_id, request_id)
    elif media.kind == MediaKind.video.value:
        _reset_media_for_reingest(media)
        _enqueue_youtube_ingest_task(db, media.id, viewer_id, request_id)
    elif media.kind == MediaKind.pdf.value:
        invalidate_pdf_quote_match_metadata(db, media.id)
        delete_pdf_text_artifacts(db, media.id)
        _reset_media_for_reingest(media)
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
        _reset_media_for_reingest(media)
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


def _position_meets_completion_threshold(position_ms: int, duration_ms: int | None) -> bool:
    if duration_ms is None or duration_ms <= 0:
        return False
    return position_ms >= int(float(duration_ms) * 0.95)


def upsert_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    position_ms: int | None = None,
    duration_ms: int | None = None,
    playback_speed: float | None = None,
    is_completed: bool | None = None,
) -> None:
    """Upsert listener state for one media item scoped to the viewer."""
    if (
        position_ms is None
        and duration_ms is None
        and playback_speed is None
        and is_completed is None
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one listening-state field is required",
        )

    with transaction(db):
        if not can_read_media(db, viewer_id, media_id):
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

        next_position_ms = int(position_ms) if position_ms is not None else current_position_ms
        next_duration_ms = int(duration_ms) if duration_ms is not None else current_duration_ms
        next_playback_speed = (
            float(playback_speed) if playback_speed is not None else current_playback_speed
        )

        if is_completed is not None:
            next_is_completed = bool(is_completed)
        elif position_ms is not None:
            next_is_completed = current_is_completed or _position_meets_completion_threshold(
                next_position_ms, next_duration_ms
            )
        else:
            next_is_completed = current_is_completed

        if existing_state is None:
            db.add(
                PodcastListeningState(
                    user_id=viewer_id,
                    media_id=media_id,
                    position_ms=next_position_ms,
                    duration_ms=next_duration_ms,
                    playback_speed=next_playback_speed,
                    is_completed=next_is_completed,
                )
            )
            return

        existing_state.position_ms = next_position_ms
        existing_state.duration_ms = next_duration_ms
        existing_state.playback_speed = next_playback_speed
        existing_state.is_completed = next_is_completed
        existing_state.updated_at = db.execute(text("SELECT now()")).scalar_one()


def batch_mark_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media_ids: list[UUID],
    is_completed: bool,
) -> None:
    """Batch mark many visible podcast episodes as played/unplayed."""
    deduped_media_ids = _dedupe_uuid_order(media_ids)
    if not deduped_media_ids:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one media_id is required",
        )

    with transaction(db):
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

        now = db.execute(text("SELECT now()")).scalar_one()
        for media_id in deduped_media_ids:
            existing_state = (
                db.query(PodcastListeningState)
                .filter(
                    PodcastListeningState.user_id == viewer_id,
                    PodcastListeningState.media_id == media_id,
                )
                .one_or_none()
            )
            if existing_state is None:
                db.add(
                    PodcastListeningState(
                        user_id=viewer_id,
                        media_id=media_id,
                        position_ms=0,
                        duration_ms=None,
                        playback_speed=1.0,
                        is_completed=is_completed,
                    )
                )
                continue
            existing_state.is_completed = is_completed
            existing_state.updated_at = now
            if not is_completed:
                existing_state.position_ms = 0


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


def _reset_media_for_reingest(media: Media) -> None:
    """Clear failure metadata and mark a media row ready for re-ingestion."""
    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.extracting
    media.processing_started_at = now
    media.processing_completed_at = None
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now


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


def _remote_file_kind_from_url(url: str) -> str | None:
    path = urlparse(url).path.lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".epub") or path.endswith(".epub.noimages") or path.endswith(".epub.images"):
        return "epub"
    return None


def _remote_file_name(url: str, kind: str) -> str:
    name = unquote(posixpath.basename(urlparse(url).path)).strip()
    return name or f"download.{get_file_extension(kind)}"


def _download_remote_file(url: str, kind: str) -> tuple[bytes, str]:
    from nexus.services.image_proxy import (
        check_hostname_denylist,
        validate_dns_resolution,
        validate_url,
    )

    max_bytes = get_settings().max_pdf_bytes if kind == "pdf" else get_settings().max_epub_bytes
    current_url = url

    with httpx.Client(
        timeout=_REMOTE_FILE_TIMEOUT,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        for _ in range(_REMOTE_FILE_REDIRECT_LIMIT + 1):
            normalized_url, hostname, _ = validate_url(current_url)
            check_hostname_denylist(hostname)
            validate_dns_resolution(hostname)

            try:
                with client.stream(
                    "GET",
                    normalized_url,
                    headers={
                        "User-Agent": _REMOTE_FILE_USER_AGENT,
                        "Accept": (
                            f"{_REMOTE_FILE_CONTENT_TYPES[kind]},application/octet-stream,*/*;q=0.8"
                        ),
                    },
                ) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise ApiError(
                                ApiErrorCode.E_INGEST_FAILED,
                                "Remote file redirect did not include a Location header.",
                            )
                        current_url = urljoin(normalized_url, location)
                        continue

                    if response.status_code < 200 or response.status_code >= 300:
                        raise ApiError(
                            ApiErrorCode.E_INGEST_FAILED,
                            f"Remote file returned status {response.status_code}.",
                        )

                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > max_bytes:
                        raise InvalidRequestError(
                            ApiErrorCode.E_FILE_TOO_LARGE,
                            f"Remote {kind.upper()} exceeds maximum size.",
                        )

                    data = bytearray()
                    for chunk in response.iter_bytes(chunk_size=_REMOTE_FILE_CHUNK_BYTES):
                        data.extend(chunk)
                        if len(data) > max_bytes:
                            raise InvalidRequestError(
                                ApiErrorCode.E_FILE_TOO_LARGE,
                                f"Remote {kind.upper()} exceeds maximum size.",
                            )

                    payload = bytes(data)
                    if not has_valid_file_signature(payload, kind):
                        raise InvalidRequestError(
                            ApiErrorCode.E_INVALID_FILE_TYPE,
                            f"Remote URL did not return a valid {kind.upper()} file.",
                        )

                    return payload, _REMOTE_FILE_CONTENT_TYPES[kind]
            except ValueError as exc:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Invalid remote file response.",
                ) from exc
            except httpx.TimeoutException as exc:
                raise ApiError(
                    ApiErrorCode.E_INGEST_TIMEOUT, "Remote file fetch timed out."
                ) from exc
            except httpx.RequestError as exc:
                raise ApiError(
                    ApiErrorCode.E_INGEST_FAILED, "Failed to fetch remote file."
                ) from exc

    raise ApiError(ApiErrorCode.E_INGEST_FAILED, "Remote file had too many redirects.")


def _create_file_media_from_remote_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    kind: str,
    request_id: str | None = None,
) -> FromUrlResponse:
    from nexus.services.epub_lifecycle import confirm_ingest_for_viewer

    if kind not in _REMOTE_FILE_CONTENT_TYPES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Remote URL must be a PDF or EPUB.")

    payload, content_type = _download_remote_file(url, kind)
    validate_file_ingest_request(kind, content_type, len(payload))

    media_id = uuid4()
    storage_path = build_upload_staging_storage_path(media_id, get_file_extension(kind))
    storage_client = get_storage_client()
    try:
        storage_client.put_object(storage_path, payload, content_type)
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Failed to store remote file.") from exc

    now = datetime.now(UTC)
    media = Media(
        id=media_id,
        kind=kind,
        title=_remote_file_name(url, kind)[:255],
        requested_url=url,
        canonical_source_url=normalize_url_for_display(url),
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    media_file = MediaFile(
        media_id=media_id,
        storage_path=storage_path,
        content_type=content_type,
        size_bytes=len(payload),
    )

    try:
        db.add(media)
        db.add(media_file)
        db.flush()
        libraries_service.ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()
    except Exception:
        db.rollback()
        try:
            storage_client.delete_object(storage_path)
        except StorageError as cleanup_error:
            # justify-ignore-error: remote upload cleanup is best-effort; preserving
            # the original DB failure gives the caller the actionable error.
            logger.warning(
                "remote_file_cleanup_failed media_id=%s storage_path=%s error=%s",
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

    return FromUrlResponse(
        media_id=UUID(result["media_id"]),
        idempotency_outcome="reused" if result["duplicate"] else "created",
        processing_status=str(result["processing_status"]),
        ingest_enqueued=bool(result["ingest_enqueued"]),
    )


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
    libraries_service.validate_libraries_accessible(db, viewer_id, library_ids)
    validate_requested_url(url)

    if len(content_html.encode("utf-8")) > _CAPTURED_ARTICLE_HTML_MAX_BYTES:
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

        libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)
        fragment_id = fragment.id
        media_id = media.id
        media_language = media.language
        db.commit()
    except Exception:
        db.rollback()
        raise

    _rebuild_web_article_index_or_mark_failed(
        db,
        media_id=media_id,
        fragment_id=fragment_id,
        fragments=[fragment],
        reason="web_article_capture",
        language=media_language,
        log_event="captured_web_article_content_index_failed",
    )

    _try_enrich_dispatch(str(media.id), None)

    libraries_service.assign_libraries_for_media(db, viewer_id, media_id, library_ids)

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

    libraries_service.validate_libraries_accessible(db, viewer_id, library_ids)
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
        title = _remote_file_name(clean_source_url, kind)
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
        libraries_service.ensure_media_in_default_library(db, viewer_id, media_id)
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
    libraries_service.assign_libraries_for_media(db, viewer_id, resolved_media_id, library_ids)
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

    libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)

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


def enqueue_media_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create media from URL with kind classification and enqueue ingestion.

    Classification:
    - YouTube variants -> shared `video` row (create-or-reuse by canonical video identity)
    - all other URLs -> provisional `web_article`
    """
    libraries_service.validate_libraries_accessible(db, viewer_id, library_ids)
    validate_requested_url(url)

    youtube_identity = classify_youtube_url(url)
    if youtube_identity is not None:
        result = create_or_reuse_youtube_video(
            db=db,
            viewer_id=viewer_id,
            url=url,
            enqueue_task=True,
            request_id=request_id,
        )
        libraries_service.assign_libraries_for_media(db, viewer_id, result.media_id, library_ids)
        return result

    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "YouTube URL must include a valid video ID",
        )

    x_identity = classify_x_url(url)
    if x_identity is not None:
        return create_or_reuse_x_author_thread_article(
            db=db,
            viewer_id=viewer_id,
            url=url,
            library_ids=library_ids,
        )
    if is_x_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "X URL must include a valid post ID",
        )

    remote_file_kind = _remote_file_kind_from_url(url)
    if remote_file_kind is not None:
        result = _create_file_media_from_remote_url(
            db=db,
            viewer_id=viewer_id,
            url=url,
            kind=remote_file_kind,
            request_id=request_id,
        )
        libraries_service.assign_libraries_for_media(db, viewer_id, result.media_id, library_ids)
        return result

    result = create_provisional_web_article(
        db,
        viewer_id,
        url,
        enqueue_task=True,
        request_id=request_id,
    )
    libraries_service.assign_libraries_for_media(db, viewer_id, result.media_id, library_ids)
    return result


def create_or_reuse_x_author_thread_article(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    library_ids: list[UUID],
) -> FromUrlResponse:
    """Create-or-reuse an archival same-author X thread snapshot."""
    validate_requested_url(url)
    identity = classify_x_url(url)
    if identity is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL is not a supported X post URL",
        )

    provider_id = x_author_thread_provider_id(identity.provider_id)
    media = (
        db.query(Media)
        .filter(Media.provider == identity.provider, Media.provider_id == provider_id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
        return FromUrlResponse(
            media_id=media.id,
            idempotency_outcome="reused",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )

    snapshot = fetch_author_thread_snapshot(
        identity.provider_id,
        username_hint=identity.username,
    )
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    now = datetime.now(UTC)
    created_index_targets: list[_WebArticleIndexTarget] = []
    quoted_media_ids: dict[str, UUID] = {}
    for quoted_id, quoted_post in snapshot.quoted_posts.items():
        quote_media, quote_fragment, quote_created = _create_or_reuse_x_snapshot_post_media(
            db,
            viewer_id,
            post=quoted_post,
            snapshot=snapshot,
            library_ids=library_ids,
            now=now,
        )
        quoted_media_ids[quoted_id] = quote_media.id
        if quote_created and quote_fragment is not None:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=quote_media.id,
                    fragment_id=quote_fragment.fragment.id,
                    fragments=[quote_fragment.fragment],
                    reason="x_api_quoted_post",
                    language=quote_media.language,
                )
            )

    rendered_fragments = render_author_thread_fragment_html(
        snapshot,
        quoted_media_ids=quoted_media_ids,
        app_public_url=get_settings().app_public_url,
    )
    prepared_fragments: list[_PreparedXFragment] = []
    for idx, (post, fragment_html) in enumerate(rendered_fragments):
        prepared_fragments.append(
            _build_x_fragment(
                media_id=None,
                idx=idx,
                html=fragment_html,
                base_url=post.permalink,
                created_at=now,
            )
        )

    fragments = [prepared.fragment for prepared in prepared_fragments]
    canonical_text = "\n\n".join(fragment.canonical_text for fragment in fragments)
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")

    media = Media(
        kind=MediaKind.web_article.value,
        title=thread_title(snapshot)[:255],
        requested_url=url,
        canonical_url=None,
        canonical_source_url=identity.canonical_url,
        provider=identity.provider,
        provider_id=provider_id,
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher="X",
        description=thread_description(snapshot),
    )

    created = False
    try:
        db.add(media)
        db.flush()
        created = True
        for prepared_fragment in prepared_fragments:
            prepared_fragment.fragment.media_id = media.id
            db.add(prepared_fragment.fragment)
        db.flush()
        for prepared_fragment in prepared_fragments:
            insert_fragment_blocks(
                db,
                prepared_fragment.fragment.id,
                prepared_fragment.fragment_blocks,
            )
        replace_media_contributor_credits(
            db,
            media_id=media.id,
            credits=[
                {
                    "name": snapshot.author.name[:255],
                    "handle": snapshot.author.username[:255],
                    "role": "author",
                    "source": "x_api_author_thread",
                    "source_ref": {"media_id": str(media.id), "x_user_id": snapshot.author.id},
                }
            ],
        )
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
    except IntegrityError as exc:
        if not _is_media_provider_conflict(exc):
            db.rollback()
            raise
        db.rollback()
        created = False
        media = (
            db.query(Media)
            .filter(Media.provider == identity.provider, Media.provider_id == provider_id)
            .limit(1)
            .one_or_none()
        )
        if media is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to resolve canonical X thread") from exc
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
    except Exception:
        db.rollback()
        raise

    if created:
        fragment_ids = [fragment.id for fragment in fragments]
        if fragment_ids:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=media.id,
                    fragment_id=fragment_ids[0],
                    fragments=fragments,
                    reason="x_api_author_thread",
                    language=media.language,
                )
            )
        for target in created_index_targets:
            _rebuild_web_article_index_or_mark_failed(
                db,
                media_id=target.media_id,
                fragment_id=target.fragment_id,
                fragments=target.fragments,
                reason=target.reason,
                language=target.language,
                log_event=f"{target.reason}_content_index_failed",
            )
            _try_enrich_dispatch_with_session(db, str(target.media_id), None)

    return FromUrlResponse(
        media_id=media.id,
        idempotency_outcome="created" if created else "reused",
        processing_status=ProcessingStatus.ready_for_reading.value,
        ingest_enqueued=False,
    )


def _x_refresh_identity(media: Media) -> tuple[str, str | None] | None:
    username_hint = _x_username_hint(media)
    if media.provider == "x":
        provider_id = str(media.provider_id or "").strip()
        if provider_id.startswith("thread:"):
            post_id = provider_id.removeprefix("thread:")
            if post_id:
                return post_id, username_hint
        elif provider_id:
            return provider_id, username_hint

    for candidate_url in (media.requested_url, media.canonical_source_url, media.canonical_url):
        if not candidate_url:
            continue
        identity = classify_x_url(candidate_url)
        if identity is not None:
            return identity.provider_id, identity.username
    return None


def _x_username_hint(media: Media) -> str | None:
    for candidate_url in (media.requested_url, media.canonical_source_url, media.canonical_url):
        if not candidate_url:
            continue
        identity = classify_x_url(candidate_url)
        if identity is not None and identity.username:
            return identity.username
    return None


def _refresh_x_author_thread_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media: Media,
    post_id: str,
    username_hint: str | None,
    request_id: str | None,
) -> dict[str, object]:
    provider_id = x_author_thread_provider_id(post_id)
    existing_thread_media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == provider_id, Media.id != media.id)
        .limit(1)
        .one_or_none()
    )
    source_library_ids = _attached_library_ids(db, media.id)
    if existing_thread_media is not None:
        libraries_service.assign_libraries_for_media(
            db,
            viewer_id,
            existing_thread_media.id,
            source_library_ids,
        )
        db.commit()
        return {
            "media_id": str(existing_thread_media.id),
            "processing_status": _status_to_str(existing_thread_media.processing_status),
            "refresh_enqueued": False,
            "idempotency_outcome": "reused",
        }

    snapshot = fetch_author_thread_snapshot(post_id, username_hint=username_hint)
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    now = datetime.now(UTC)
    created_index_targets: list[_WebArticleIndexTarget] = []
    quoted_media_ids: dict[str, UUID] = {}
    for quoted_id, quoted_post in snapshot.quoted_posts.items():
        quote_media, quote_fragment, quote_created = _create_or_reuse_x_snapshot_post_media(
            db,
            viewer_id,
            post=quoted_post,
            snapshot=snapshot,
            library_ids=source_library_ids,
            now=now,
        )
        quoted_media_ids[quoted_id] = quote_media.id
        if quote_created and quote_fragment is not None:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=quote_media.id,
                    fragment_id=quote_fragment.fragment.id,
                    fragments=[quote_fragment.fragment],
                    reason="x_api_quoted_post",
                    language=quote_media.language,
                )
            )

    prepared_fragments: list[_PreparedXFragment] = []
    for idx, (post, fragment_html) in enumerate(
        render_author_thread_fragment_html(
            snapshot,
            quoted_media_ids=quoted_media_ids,
            app_public_url=get_settings().app_public_url,
        )
    ):
        prepared_fragments.append(
            _build_x_fragment(
                media_id=media.id,
                idx=idx,
                html=fragment_html,
                base_url=post.permalink,
                created_at=now,
            )
        )

    fragments = [prepared.fragment for prepared in prepared_fragments]
    canonical_text = "\n\n".join(fragment.canonical_text for fragment in fragments)
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")

    _delete_web_article_refresh_artifacts(db, media.id)
    media.title = thread_title(snapshot)[:255]
    media.canonical_url = None
    media.canonical_source_url = canonical_x_post_url(snapshot.root_post_id)
    media.provider = "x"
    media.provider_id = provider_id
    media.processing_status = ProcessingStatus.ready_for_reading
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = now
    media.processing_completed_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    media.publisher = "X"
    media.description = thread_description(snapshot)

    for prepared_fragment in prepared_fragments:
        db.add(prepared_fragment.fragment)
    db.flush()
    for prepared_fragment in prepared_fragments:
        insert_fragment_blocks(
            db,
            prepared_fragment.fragment.id,
            prepared_fragment.fragment_blocks,
        )
    replace_media_contributor_credits(
        db,
        media_id=media.id,
        credits=[
            {
                "name": snapshot.author.name[:255],
                "handle": snapshot.author.username[:255],
                "role": "author",
                "source": "x_api_author_thread",
                "source_ref": {"media_id": str(media.id), "x_user_id": snapshot.author.id},
            }
        ],
    )
    db.commit()

    created_index_targets.append(
        _WebArticleIndexTarget(
            media_id=media.id,
            fragment_id=fragments[0].id,
            fragments=fragments,
            reason="x_api_author_thread_refresh",
            language=media.language,
        )
    )
    for target in created_index_targets:
        _rebuild_web_article_index_or_mark_failed(
            db,
            media_id=target.media_id,
            fragment_id=target.fragment_id,
            fragments=target.fragments,
            reason=target.reason,
            language=target.language,
            log_event=f"{target.reason}_content_index_failed",
        )
        _try_enrich_dispatch_with_session(db, str(target.media_id), request_id)

    return {
        "media_id": str(media.id),
        "processing_status": ProcessingStatus.ready_for_reading.value,
        "refresh_enqueued": False,
        "idempotency_outcome": "refreshed",
    }


def _attached_library_ids(db: Session, media_id: UUID) -> list[UUID]:
    return [
        UUID(str(row[0]))
        for row in db.execute(
            text("SELECT library_id FROM library_entries WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).fetchall()
    ]


def _delete_web_article_refresh_artifacts(db: Session, media_id: UUID) -> None:
    delete_media_content_index(db, media_id=media_id)
    db.execute(
        text(
            """
            DELETE FROM highlights AS h
            USING highlight_fragment_anchors AS hfa
            JOIN fragments AS f ON f.id = hfa.fragment_id
            WHERE h.id = hfa.highlight_id
              AND f.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM fragment_blocks
            WHERE fragment_id IN (
                SELECT id
                FROM fragments
                WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
    db.execute(
        text("DELETE FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.flush()


def _create_or_reuse_x_snapshot_post_media(
    db: Session,
    viewer_id: UUID,
    *,
    post: XPostSnapshot,
    snapshot: XAuthorThreadSnapshot,
    library_ids: list[UUID],
    now: datetime,
) -> tuple[Media, _PreparedXFragment | None, bool]:
    media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == post.id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        return media, None, False

    prepared_fragment = _build_x_fragment(
        media_id=None,
        idx=0,
        html=render_single_post_html(post, users=snapshot.users, media=snapshot.media),
        base_url=canonical_x_post_url(post.id),
        created_at=now,
    )
    media = Media(
        kind=MediaKind.web_article.value,
        title=post_title(post, snapshot.users)[:255],
        requested_url=canonical_x_post_url(post.id),
        canonical_url=canonical_x_post_url(post.id),
        canonical_source_url=canonical_x_post_url(post.id),
        provider="x",
        provider_id=post.id,
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher="X",
        description=post_description(post),
    )
    db.add(media)
    db.flush()
    prepared_fragment.fragment.media_id = media.id
    db.add(prepared_fragment.fragment)
    db.flush()
    insert_fragment_blocks(
        db,
        prepared_fragment.fragment.id,
        prepared_fragment.fragment_blocks,
    )
    author = snapshot.users.get(post.author_id)
    if author is not None:
        replace_media_contributor_credits(
            db,
            media_id=media.id,
            credits=[
                {
                    "name": author.name[:255],
                    "handle": author.username[:255],
                    "role": "author",
                    "source": "x_api_quoted_post",
                    "source_ref": {"media_id": str(media.id), "x_user_id": author.id},
                }
            ],
        )
    libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
    return media, prepared_fragment, True


def _build_x_fragment(
    *,
    media_id: UUID | None,
    idx: int,
    html: str,
    base_url: str,
    created_at: datetime,
) -> _PreparedXFragment:
    if len(html.encode("utf-8")) > _CAPTURED_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "X thread HTML is too large")
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            fragment_idx=idx,
            media_title=None,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "X thread could not be sanitized"
        ) from exc
    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")
    fragment = Fragment(
        media_id=media_id,
        idx=idx,
        html_sanitized=prepared.html_sanitized,
        canonical_text=canonical_text,
        created_at=created_at,
    )
    return _PreparedXFragment(fragment=fragment, fragment_blocks=prepared.fragment_blocks)


def _rebuild_web_article_index_or_mark_failed(
    db: Session,
    *,
    media_id: UUID,
    fragment_id: UUID,
    fragments: list[Fragment],
    reason: str,
    language: str | None,
    log_event: str,
) -> None:
    try:
        rebuild_fragment_content_index(
            db,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment_id}",
            fragments=fragments,
            reason=reason,
            language=language,
        )
        db.commit()
    except (SQLAlchemyError, ApiError) as exc:
        db.rollback()
        logger.exception(log_event, media_id=str(media_id), error=str(exc))
        media = db.get(Media, media_id)
        if media is not None:
            now = datetime.now(UTC)
            error_code = (
                exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INGEST_FAILED.value
            )
            media.failure_stage = FailureStage.embed
            media.last_error_code = error_code
            media.last_error_message = f"Web article evidence index failed: {exc}"[:1000]
            media.failed_at = now
            media.updated_at = now
            mark_content_index_failed(
                db,
                media_id=media_id,
                failure_code=error_code,
                failure_message=media.last_error_message,
            )
            db.commit()


def create_or_reuse_x_oembed_article(
    db: Session,
    viewer_id: UUID,
    url: str,
) -> FromUrlResponse:
    """Create-or-reuse a public X post from official oEmbed HTML."""
    validate_requested_url(url)
    identity = classify_x_url(url)
    if identity is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL is not a supported X post URL",
        )

    media = (
        db.query(Media)
        .filter(Media.provider == identity.provider, Media.provider_id == identity.provider_id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)
        db.commit()
        return FromUrlResponse(
            media_id=media.id,
            idempotency_outcome="reused",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )

    try:
        with httpx.Client(timeout=_X_OEMBED_TIMEOUT, trust_env=False) as client:
            response = client.get(
                "https://publish.x.com/oembed",
                params={
                    "url": identity.canonical_url,
                    "omit_script": "1",
                    "dnt": "1",
                    "hide_thread": "1",
                },
                headers={"User-Agent": "Nexus Media Ingestion/1.0"},
            )
    except httpx.TimeoutException as exc:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "X oEmbed fetch timed out.") from exc
    except httpx.RequestError as exc:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "Failed to fetch X oEmbed.") from exc

    if response.status_code < 200 or response.status_code >= 300:
        raise ApiError(
            ApiErrorCode.E_INGEST_FAILED,
            f"X oEmbed returned status {response.status_code}.",
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X oEmbed returned invalid JSON.") from exc

    content_html = data.get("html")
    if not isinstance(content_html, str) or not content_html.strip():
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X oEmbed returned no readable HTML.")
    if len(content_html.encode("utf-8")) > _CAPTURED_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "X oEmbed HTML is too large")

    author_name = data.get("author_name")
    author_name = author_name.strip() if isinstance(author_name, str) else ""
    try:
        prepared = prepare_web_article_fragment(
            html=content_html,
            base_url=identity.canonical_url,
            fragment_idx=0,
            media_title=f"X post by {author_name}"
            if author_name
            else f"X post {identity.provider_id}",
        )
    except ValueError as exc:
        raise ApiError(ApiErrorCode.E_SANITIZATION_FAILED, "X post could not be sanitized") from exc

    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")

    provider_name = data.get("provider_name")
    provider_name = provider_name.strip() if isinstance(provider_name, str) else "X"
    now = datetime.now(UTC)
    media = Media(
        kind=MediaKind.web_article.value,
        title=f"X post by {author_name}" if author_name else f"X post {identity.provider_id}",
        requested_url=url,
        canonical_url=identity.canonical_url,
        canonical_source_url=identity.canonical_url,
        provider=identity.provider,
        provider_id=identity.provider_id,
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher=provider_name or "X",
        description=canonical_text[:2000],
    )

    created = False
    try:
        db.add(media)
        db.flush()
        created = True

        fragment = Fragment(
            media_id=media.id,
            idx=0,
            html_sanitized=prepared.html_sanitized,
            canonical_text=canonical_text,
            created_at=now,
        )
        db.add(fragment)
        db.flush()
        insert_fragment_blocks(db, fragment.id, prepared.fragment_blocks)

        if author_name:
            replace_media_contributor_credits(
                db,
                media_id=media.id,
                credits=[
                    {
                        "name": author_name[:255],
                        "role": "author",
                        "source": "x_oembed_article",
                        "source_ref": {"media_id": str(media.id)},
                    }
                ],
            )

        libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)
        fragment_id = fragment.id
        media_id = media.id
        media_language = media.language
        db.commit()
    except IntegrityError as exc:
        if not _is_media_provider_conflict(exc):
            db.rollback()
            raise
        db.rollback()
        created = False
        media = (
            db.query(Media)
            .filter(Media.provider == identity.provider, Media.provider_id == identity.provider_id)
            .limit(1)
            .one_or_none()
        )
        if media is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to resolve canonical X post") from exc
        libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)
        db.commit()
    except Exception:
        db.rollback()
        raise

    if created:
        _rebuild_web_article_index_or_mark_failed(
            db,
            media_id=media_id,
            fragment_id=fragment_id,
            fragments=[fragment],
            reason="x_oembed_article",
            language=media_language,
            log_event="x_oembed_content_index_failed",
        )

    _try_enrich_dispatch(str(media.id), None)

    return FromUrlResponse(
        media_id=media.id,
        idempotency_outcome="created" if created else "reused",
        processing_status=ProcessingStatus.ready_for_reading.value,
        ingest_enqueued=False,
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
        # Keep canonical identity columns populated when an existing row is reused.
        media.provider = identity.provider
        media.provider_id = identity.provider_video_id
        if not media.external_playback_url:
            media.external_playback_url = identity.watch_url
        if not media.canonical_source_url:
            media.canonical_source_url = identity.watch_url
        media.updated_at = now

    libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)

    ingest_enqueued = False
    try:
        if created and enqueue_task:
            ingest_enqueued = _enqueue_youtube_ingest_task(db, media.id, viewer_id, request_id)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return FromUrlResponse(
        media_id=media.id,
        idempotency_outcome="created" if created else "reused",
        processing_status=_status_to_str(media.processing_status),
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


def _try_enrich_dispatch_with_session(
    db: Session,
    media_id: str,
    request_id: str | None,
) -> None:
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
    except SQLAlchemyError as exc:
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
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_canonical_url"
    return "uix_media_canonical_url" in str(exc)


def _is_media_provider_conflict(exc: IntegrityError) -> bool:
    """Return True when IntegrityError is media provider uniqueness conflict."""
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_x_provider_id"
    return "uix_media_x_provider_id" in str(exc)


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
            LEFT JOIN media_transcript_states mts
              ON mts.media_id = f.media_id
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
            source_version=row[8],
            created_at=row[9],
        )
        for row in result.fetchall()
    ]


# ---------------------------------------------------------------------------
# EPUB asset fetch
# ---------------------------------------------------------------------------

_ASSET_KEY_RE = re.compile(r"^[a-zA-Z0-9_./-]+$")

_EPUB_ASSET_CONTENT_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/svg+xml",
        "image/webp",
    }
)


@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str


@dataclass(frozen=True)
class _EpubAssetMetadata:
    storage_path: str
    content_type: str
    size_bytes: int
    sha256: str


def get_epub_asset_for_viewer(
    *,
    session_factory: Callable[[], Session],
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage_client: StorageClientBase | None = None,
) -> EpubAssetOut:
    """Fetch an EPUB internal asset for an authorized viewer.

    Enforces visibility, kind, readiness, and key-format guards.
    Returns binary payload without exposing raw private storage URLs.
    """
    from nexus.storage.client import get_storage_client

    with session_factory() as db:
        asset_metadata = _get_epub_asset_metadata_for_viewer(
            db=db,
            viewer_id=viewer_id,
            media_id=media_id,
            asset_key=asset_key,
        )

    sc = storage_client or get_storage_client()
    try:
        hasher = hashlib.sha256()
        chunks = []
        total_bytes = 0
        for chunk in sc.stream_object(asset_metadata.storage_path):
            total_bytes += len(chunk)
            if total_bytes > asset_metadata.size_bytes:
                raise StorageError("Stored EPUB asset is larger than persisted metadata")
            hasher.update(chunk)
            chunks.append(chunk)
        if total_bytes != asset_metadata.size_bytes or hasher.hexdigest() != asset_metadata.sha256:
            raise StorageError("Stored EPUB asset integrity mismatch")
        data = b"".join(chunks)
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Stored EPUB asset object is missing or unreadable",
        ) from exc

    return EpubAssetOut(data=data, content_type=asset_metadata.content_type)


def _get_epub_asset_metadata_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
) -> _EpubAssetMetadata:
    if not can_read_media(db, viewer_id, media_id):
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
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")

    row = (
        db.execute(
            text(
                """
                SELECT storage_path, content_type, size_bytes, sha256
                FROM epub_resources
                WHERE media_id = :media_id
                  AND asset_key = :asset_key
                """
            ),
            {"media_id": media_id, "asset_key": asset_key},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "EPUB asset not found")

    content_type = str(row["content_type"])
    if content_type not in _EPUB_ASSET_CONTENT_TYPES:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "EPUB asset not found")

    return _EpubAssetMetadata(
        storage_path=str(row["storage_path"]),
        content_type=content_type,
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
    )
