"""Detached source acquisition and each family's fenced publication policy."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Media, MediaFile, MediaKind, MediaSourceAttempt
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.extension_capture import decode_article_packet
from nexus.services import media_source_types as source_types
from nexus.services.epub_ingest import EpubExtractionPlan
from nexus.services.epub_lifecycle import prepare_epub_source, publish_epub_source
from nexus.services.media_deletion import delete_document_storage_objects
from nexus.services.media_processing_state import mark_extracting
from nexus.services.pdf_ingest import PdfExtractionPlan
from nexus.services.pdf_lifecycle import prepare_pdf_source, publish_pdf_source
from nexus.services.podcasts.transcription import run_podcast_transcription_now
from nexus.services.reader_publication import ReaderPublicationSourceFile
from nexus.services.remote_file import RemoteFile, fetch_remote_file
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.source_publication import (
    SourcePublicationFence,
    record_source_extraction_progress,
    record_source_finalizing,
    run_source_publication_phase,
)
from nexus.services.transcripts.request_reason import require_transcript_request_reason
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article import (
    Article,
    ArticleMetadata,
    byline_observation,
    publish_article,
    publish_fetched_article,
)
from nexus.services.x_ingest import PreparedXSource, prepare_x_source
from nexus.services.youtube import run_youtube_video_ingest
from nexus.services.youtube_identity import classify_youtube_provider_video_id, classify_youtube_url
from nexus.storage.client import StorageClient, StorageError, get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path, get_file_extension
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)

logger = get_logger(__name__)

_WEB_ARTICLE = frozenset({MediaKind.web_article.value})
_DOCUMENT = frozenset({MediaKind.pdf.value, MediaKind.epub.value})

type ExtractionPlan = PdfExtractionPlan | EpubExtractionPlan


@dataclass(frozen=True, slots=True)
class PreparedFileSource:
    """Detached acquisition; the source coordinator owns its atomic publication."""

    plan: ExtractionPlan
    remote_file: RemoteFile | None


def run_source_adapter(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> SourceRunOutcome | PreparedFileSource | PreparedXSource:
    """Acquire one detached attempt, preserving its source-specific refusal order."""
    source_type = attempt.source_type
    if source_type == source_types.GENERIC_WEB_URL:
        _begin_source_extraction(
            session_factory, media_id, fence, expected_kinds=_WEB_ARTICLE, label="generic_web"
        )
        return publish_fetched_article(
            session_factory, media_id=media_id, attempt=attempt, request_id=request_id, fence=fence
        )
    if source_type in {source_types.YOUTUBE_VIDEO, source_types.VIDEO_TRANSCRIPT}:
        payload = dict(attempt.source_payload or {})
        identity = classify_youtube_provider_video_id(
            str(attempt.provider_target_ref or payload.get("video_id") or "")
        ) or classify_youtube_url(str(attempt.canonical_source_url or attempt.requested_url or ""))
        if identity is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Missing YouTube source target.")
        _begin_source_extraction(
            session_factory,
            media_id,
            fence,
            expected_kinds=frozenset({MediaKind.video.value}),
            label="youtube_extraction",
        )
        return run_youtube_video_ingest(
            session_factory, media_id, identity=identity, publication_fence=fence
        )
    if source_type in {source_types.X_AUTHOR_THREAD, source_types.X_POST}:
        _begin_source_extraction(
            session_factory, media_id, fence, expected_kinds=_WEB_ARTICLE, label="x_extraction"
        )
        return prepare_x_source(
            post_id=_x_post_target(attempt),
            author_thread=source_type == source_types.X_AUTHOR_THREAD,
        )
    if source_type in source_types.REMOTE_FILE_SOURCE_TYPES:
        return _run_remote_file(session_factory, media_id, attempt, fence)
    if source_type == source_types.BROWSER_ARTICLE_CAPTURE:
        packet = decode_article_packet(
            _read_stored_source(session_factory, media_id, attempt, fence)
        )
        byline = packet.byline or ""
        fragment_id = publish_article(
            session_factory,
            media_id=media_id,
            request_id=request_id,
            fence=fence,
            article=Article(
                content_html=packet.content_html,
                source_html=packet.source_html or None,
                base_url=packet.base_url,
                document_url=packet.url,
                extract_embeds=True,
                metadata=ArticleMetadata(
                    title=packet.title,
                    byline=byline,
                    excerpt=packet.excerpt or "",
                    site_name=packet.site_name or "",
                    published_time=packet.published_time or "",
                ),
            ),
        )
        return SourceRunOutcome(
            diagnostics={
                "status": "success",
                "source_type": source_types.BROWSER_ARTICLE_CAPTURE,
                "fragment_id": str(fragment_id),
            },
            observations=source_contributor_observations(
                media_id=media_id,
                observation=byline_observation(byline),
                source="web_article_capture",
            ),
            metadata_enrichment=True,
        )
    if source_type == source_types.EMAIL_MESSAGE:
        if not dict(attempt.source_payload or {}).get("has_content"):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Email has no readable text content."
            )
        try:
            content_html = _read_stored_source(session_factory, media_id, attempt, fence).decode(
                "utf-8"
            )
        except UnicodeDecodeError as exc:
            raise InvalidRequestError(
                ApiErrorCode.E_SANITIZATION_FAILED, "Email source is not valid UTF-8."
            ) from exc
        fragment_id = publish_article(
            session_factory,
            media_id=media_id,
            request_id=request_id,
            fence=fence,
            article=Article(
                content_html=content_html,
                source_html=None,
                base_url="",
                document_url="",
                extract_embeds=False,
                metadata=None,
            ),
        )
        return SourceRunOutcome(
            diagnostics={
                "status": "success",
                "source_type": source_types.EMAIL_MESSAGE,
                "fragment_id": str(fragment_id),
            },
            metadata_enrichment=False,
        )
    if source_type in source_types.LOCAL_FILE_SOURCE_TYPES:
        return _run_existing_file(session_factory, media_id, fence)
    if source_type == source_types.PODCAST_EPISODE_TRANSCRIPT:
        request_reason = require_transcript_request_reason(
            dict(attempt.source_payload or {}).get("request_reason")
        )
        _begin_source_extraction(
            session_factory,
            media_id,
            fence,
            expected_kinds=frozenset({MediaKind.podcast_episode.value}),
            label="podcast_transcript_extraction",
        )
        completed = run_podcast_transcription_now(
            session_factory, media_id=media_id, publication_fence=fence
        )
        return SourceRunOutcome(
            diagnostics={
                "status": completed.status,
                "segment_count": completed.segment_count,
                "source_type": source_types.PODCAST_EPISODE_TRANSCRIPT,
            },
            metadata_enrichment=True,
            transcript_request_reason=request_reason,
        )
    raise ApiError(ApiErrorCode.E_INVALID_KIND, f"Unsupported source attempt type: {source_type}")


def _begin_source_extraction(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    fence: SourcePublicationFence,
    *,
    expected_kinds: frozenset[str],
    label: str,
) -> str:
    def begin(db: Session, _attempt: MediaSourceAttempt) -> str:
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.kind not in expected_kinds:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND,
                f"{label} requires {'/'.join(sorted(expected_kinds))} media.",
            )
        mark_extracting(db, media)
        return media.kind

    return run_source_publication_phase(
        session_factory=session_factory,
        label=f"begin_{label}",
        fence=fence,
        media_ids=(media_id,),
        mutate=begin,
    )


def _x_post_target(attempt: MediaSourceAttempt) -> str:
    post_id = str(attempt.provider_target_ref or attempt.source_payload.get("post_id") or "")
    if not post_id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing X source target.")
    return post_id


def _run_remote_file(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt: MediaSourceAttempt,
    fence: SourcePublicationFence,
) -> PreparedFileSource:
    requested_url = attempt.requested_url
    if not requested_url:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing remote file URL.")
    kind = _begin_source_extraction(
        session_factory, media_id, fence, expected_kinds=_DOCUMENT, label="remote_file_extraction"
    )
    storage_client = get_storage_client()
    storage_path = build_source_artifact_storage_path(
        media_id, attempt.id, f"original-{get_file_extension(kind)}"
    )
    with session_factory() as db:
        reserve_storage_object_write(db, media_id=media_id, storage_path=storage_path)
    settings = get_settings()
    fetched = fetch_remote_file(
        requested_url,
        kind=kind,
        storage_path=storage_path,
        storage=storage_client,
        max_bytes=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
    )
    plan = _prepare_file_source(
        session_factory,
        media_id,
        kind,
        fence=fence,
        storage_path=storage_path,
        source_size_bytes=fetched.size_bytes,
        source_sha256=fetched.sha256_hex,
    )

    return PreparedFileSource(plan=plan, remote_file=fetched)


def _run_existing_file(
    session_factory: sessionmaker[Session], media_id: UUID, fence: SourcePublicationFence
) -> PreparedFileSource:
    def begin(db: Session, _attempt: MediaSourceAttempt) -> tuple[str, str, int, str]:
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.kind not in _DOCUMENT:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, "Source file must be PDF or EPUB."
            )
        media_file = db.get(MediaFile, media_id)
        if media_file is None:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING, "Source file metadata missing."
            )
        mark_extracting(db, media)
        return (
            media.kind,
            media_file.storage_path,
            int(media_file.size_bytes),
            str(media_file.source_sha256),
        )

    kind, storage_path, source_size_bytes, source_sha256 = run_source_publication_phase(
        session_factory=session_factory,
        label="begin_existing_file_extraction",
        fence=fence,
        media_ids=(media_id,),
        mutate=begin,
    )
    plan = _prepare_file_source(
        session_factory,
        media_id,
        kind,
        fence=fence,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        source_sha256=source_sha256,
    )
    return PreparedFileSource(plan=plan, remote_file=None)


def _prepare_file_source(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    kind: str,
    *,
    fence: SourcePublicationFence,
    storage_path: str,
    source_size_bytes: int,
    source_sha256: str,
) -> ExtractionPlan:
    def record_progress(completed: int, total: int, unit: Literal["Page", "Chapter"]) -> None:
        record_source_extraction_progress(
            session_factory=session_factory,
            fence=fence,
            media_id=media_id,
            completed=completed,
            total=total,
            unit=unit,
        )

    if kind == MediaKind.pdf.value:
        prepared: ExtractionPlan = prepare_pdf_source(
            media_id=media_id,
            attempt_id=fence.attempt_id,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            expected_source_sha256=source_sha256,
            record_progress=record_progress,
        )
    else:
        prepared = prepare_epub_source(
            session_factory=session_factory,
            media_id=media_id,
            attempt_id=fence.attempt_id,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            expected_source_sha256=source_sha256,
            record_progress=record_progress,
        )
    record_source_finalizing(session_factory=session_factory, fence=fence, media_id=media_id)
    return prepared


def publish_prepared_file_source(
    db: Session,
    *,
    media_id: UUID,
    prepared: PreparedFileSource,
) -> tuple[SourceRunOutcome, list[str]]:
    """Publish files in the source coordinator's fenced terminal transaction."""
    source_file = None
    if prepared.remote_file is not None:
        fetched = prepared.remote_file
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media.canonical_source_url = normalize_url_for_display(fetched.final_url)
        media.updated_at = func.now()
        source_file = ReaderPublicationSourceFile(
            storage_path=prepared.plan.storage_path,
            content_type=fetched.content_type,
            size_bytes=fetched.size_bytes,
            source_sha256=fetched.sha256_hex,
        )
    if isinstance(prepared.plan, PdfExtractionPlan):
        return publish_pdf_source(
            db, media_id=media_id, plan=prepared.plan, source_file=source_file
        )
    return publish_epub_source(db, media_id=media_id, plan=prepared.plan, source_file=source_file)


def finalize_prepared_file_source(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    prepared: PreparedFileSource,
    cleanup_paths: list[str],
) -> None:
    """Finalize referenced reservations and delete superseded objects after commit."""
    storage_client = get_storage_client()
    if prepared.remote_file is not None:
        _finalize(session_factory, media_id, prepared.plan.storage_path, storage_client)
    if isinstance(prepared.plan, EpubExtractionPlan):
        for asset_storage_path in prepared.plan.asset_storage_paths.values():
            _finalize(session_factory, media_id, asset_storage_path, storage_client)
    delete_document_storage_objects(cleanup_paths, storage_client)


def _finalize(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    storage_path: str,
    storage_client: StorageClient,
) -> None:
    with session_factory() as db:
        finalize_storage_object_write(
            db, media_id=media_id, storage_path=storage_path, storage_client=storage_client
        )


def _read_stored_source(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt: MediaSourceAttempt,
    fence: SourcePublicationFence,
) -> bytes:
    storage_path = str(dict(attempt.source_payload or {}).get("storage_path") or "")
    if not storage_path:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing stored source artifact.")
    _begin_source_extraction(
        session_factory,
        media_id,
        fence,
        expected_kinds=_WEB_ARTICLE,
        label="stored_html_extraction",
    )
    try:
        return b"".join(get_storage_client().stream_object(storage_path))
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Stored source is missing from storage."
        ) from exc
