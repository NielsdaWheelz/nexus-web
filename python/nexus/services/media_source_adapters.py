"""Detached source acquisition and each family's fenced publication policy."""

from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Media, MediaFile, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.extension_capture import ArticlePacket, decode_article_packet
from nexus.schemas.presence import Present, absent, nullable_from_presence, present
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services import media_source_types as source_types
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.document_embeds import delete_document_embed_artifacts
from nexus.services.epub_ingest import EpubExtractionPlan
from nexus.services.epub_lifecycle import prepare_epub_source, publish_epub_source
from nexus.services.file_ingest_validation import validate_file_ingest_request
from nexus.services.media_deletion import delete_document_storage_objects
from nexus.services.media_fact_revisions import bump_all_media_fact_collections
from nexus.services.media_processing_state import mark_extracting
from nexus.services.media_source_ingest import reusable_embedded_source_media_ids
from nexus.services.pdf_ingest import PdfExtractionPlan
from nexus.services.pdf_lifecycle import prepare_pdf_source, publish_pdf_source
from nexus.services.podcasts.transcription import run_podcast_transcription_now
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    ReplaceSourceIssues,
    replace_reader_publication,
)
from nexus.services.remote_file_client import REMOTE_FILE_CONTENT_TYPES, fetch_binary_to_storage
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.source_publication import (
    SourcePublicationFence,
    record_source_extraction_progress,
    record_source_finalizing,
    run_source_publication_phase,
)
from nexus.services.transcripts.request_reason import require_transcript_request_reason
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article_artifacts import (
    ArticleEmbedReplacement,
    install_prepared_article_apparatus,
    replace_prepared_article_content,
)
from nexus.services.web_article_ingest import materialize_web_article_source
from nexus.services.web_article_structure import prepare_web_article_fragment
from nexus.services.x_ingest import materialize_x_author_thread_media, materialize_x_post_media
from nexus.services.youtube_identity import classify_youtube_provider_video_id, classify_youtube_url
from nexus.services.youtube_video_ingest import run_youtube_video_ingest
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


def run_source_adapter(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> SourceRunOutcome:
    """Acquire one detached attempt, preserving its source-specific refusal order."""
    source_type = attempt.source_type
    if source_type == source_types.GENERIC_WEB_URL:
        _begin_source_extraction(
            session_factory, media_id, fence, expected_kinds=_WEB_ARTICLE, label="generic_web"
        )
        return materialize_web_article_source(
            session_factory,
            media_id,
            actor_user_id,
            request_id,
            source_attempt_id=attempt.id,
            extract_embeds=(
                dict(attempt.source_payload or {}).get("ingest_purpose") != "artifact_research"
            ),
            publication_fence=fence,
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
            session_factory,
            media_id,
            actor_user_id,
            request_id,
            identity=identity,
            publication_fence=fence,
        )
    if source_type == source_types.X_AUTHOR_THREAD:
        _begin_source_extraction(
            session_factory,
            media_id,
            fence,
            expected_kinds=_WEB_ARTICLE,
            label="x_thread_extraction",
        )
        return materialize_x_author_thread_media(
            session_factory,
            viewer_id=actor_user_id,
            media_id=media_id,
            post_id=_x_post_target(attempt),
            source_attempt_id=attempt.id,
            request_id=request_id,
            publication_fence=fence,
        )
    if source_type == source_types.X_POST:
        _begin_source_extraction(
            session_factory, media_id, fence, expected_kinds=_WEB_ARTICLE, label="x_post_extraction"
        )
        return materialize_x_post_media(
            session_factory,
            viewer_id=actor_user_id,
            media_id=media_id,
            post_id=_x_post_target(attempt),
            request_id=request_id,
            publication_fence=fence,
        )
    if source_type in source_types.REMOTE_FILE_SOURCE_TYPES:
        return _run_remote_file(session_factory, media_id, attempt, fence)
    if source_type == source_types.BROWSER_ARTICLE_CAPTURE:
        packet = decode_article_packet(
            _read_stored_source(session_factory, media_id, attempt, fence)
        )
        fragment_id, observation = _publish_stored_html(
            session_factory,
            media_id,
            attempt,
            content_html=packet.content_html,
            embed_source_html=packet.source_html or None,
            base_url=packet.base_url,
            packet=packet,
            request_id=request_id,
            fence=fence,
        )
        return SourceRunOutcome(
            diagnostics={
                "status": "success",
                "source_type": source_types.BROWSER_ARTICLE_CAPTURE,
                "fragment_id": str(fragment_id),
            },
            observations=source_contributor_observations(
                media_id=media_id, observation=observation, source="web_article_capture"
            ),
            metadata_enrichment=present(True),
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
        fragment_id, _observation = _publish_stored_html(
            session_factory,
            media_id,
            attempt,
            content_html=content_html,
            embed_source_html=None,
            base_url=str(attempt.requested_url or ""),
            packet=None,
            request_id=request_id,
            fence=fence,
        )
        return SourceRunOutcome(
            diagnostics={
                "status": "success",
                "source_type": source_types.EMAIL_MESSAGE,
                "fragment_id": str(fragment_id),
            },
            metadata_enrichment=present(False),
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
            metadata_enrichment=present(True),
            transcript_request_reason=present(request_reason),
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
        changed = media.processing_status != ProcessingStatus.extracting
        mark_extracting(db, media)
        if changed:
            bump_all_media_fact_collections(db)
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
) -> SourceRunOutcome:
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
    content_type = REMOTE_FILE_CONTENT_TYPES[kind]
    settings = get_settings()
    fetched = fetch_binary_to_storage(
        url=requested_url,
        storage_path=storage_path,
        storage_client=storage_client,
        content_type=content_type,
        max_bytes=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
        accept=f"{content_type},application/octet-stream,*/*;q=0.8",
        signature_kind=kind,
    )
    validate_file_ingest_request(kind, fetched.content_type, fetched.size_bytes)
    prepared = _prepare_file_source(
        session_factory,
        media_id,
        kind,
        fence=fence,
        storage_path=storage_path,
        source_size_bytes=fetched.size_bytes,
        source_sha256=fetched.sha256_hex,
    )

    def publish(db: Session, _locked: MediaSourceAttempt) -> tuple[SourceRunOutcome, list[str]]:
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media.canonical_source_url = normalize_url_for_display(fetched.final_url)
        media.updated_at = func.now()
        return _publish_file_source(
            db,
            media_id=media_id,
            prepared=prepared,
            source_file=ReaderPublicationSourceFile(
                storage_path=storage_path,
                content_type=fetched.content_type,
                size_bytes=fetched.size_bytes,
                source_sha256=fetched.sha256_hex,
            ),
        )

    outcome, cleanup_paths = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_remote_file_reference",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
    )
    _finalize(session_factory, media_id, storage_path, storage_client)
    _finalize_file_source(session_factory, media_id=media_id, prepared=prepared)
    delete_document_storage_objects(cleanup_paths, storage_client)
    return outcome


def _run_existing_file(
    session_factory: sessionmaker[Session], media_id: UUID, fence: SourcePublicationFence
) -> SourceRunOutcome:
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
        bump_all_media_fact_collections(db)
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
    prepared = _prepare_file_source(
        session_factory,
        media_id,
        kind,
        fence=fence,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        source_sha256=source_sha256,
    )
    outcome, cleanup_paths = run_source_publication_phase(
        session_factory=session_factory,
        label=f"publish_{kind}_source_artifacts",
        fence=fence,
        media_ids=(media_id,),
        mutate=lambda db, _attempt: _publish_file_source(db, media_id=media_id, prepared=prepared),
    )
    _finalize_file_source(session_factory, media_id=media_id, prepared=prepared)
    delete_document_storage_objects(cleanup_paths, get_storage_client())
    return outcome


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


def _publish_file_source(
    db: Session,
    *,
    media_id: UUID,
    prepared: ExtractionPlan,
    source_file: ReaderPublicationSourceFile | None = None,
) -> tuple[SourceRunOutcome, list[str]]:
    if isinstance(prepared, PdfExtractionPlan):
        return publish_pdf_source(db, media_id=media_id, plan=prepared, source_file=source_file)
    return publish_epub_source(db, media_id=media_id, plan=prepared, source_file=source_file)


def _finalize_file_source(
    session_factory: sessionmaker[Session], *, media_id: UUID, prepared: ExtractionPlan
) -> None:
    if not isinstance(prepared, EpubExtractionPlan):
        return
    storage_client = get_storage_client()
    for asset_storage_path in prepared.asset_storage_paths.values():
        _finalize(session_factory, media_id, asset_storage_path, storage_client)


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


def _publish_stored_html(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt: MediaSourceAttempt,
    *,
    content_html: str,
    embed_source_html: str | None,
    base_url: str,
    packet: ArticlePacket | None,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> tuple[UUID, ContributorObservationBatch]:
    extract_embeds = packet is not None
    try:
        prepared = prepare_web_article_fragment(
            html=content_html,
            embed_source_html=embed_source_html,
            base_url=base_url,
            document_url=packet.url if packet is not None else base_url,
            fragment_idx=0,
            extract_embeds=extract_embeds,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "Article could not be sanitized."
        ) from exc
    if not prepared.canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Article has no readable text.")

    owner_user_id = attempt.created_by_user_id
    embed_urls = [
        item.detected.canonical_source_url
        for item in prepared.document_embeds
        if extract_embeds
        and item.detected.resolution_status == "pending"
        and item.detected.canonical_source_url
    ]
    locked_embed_media_ids: set[UUID] = set()

    def discover(db: Session) -> list[UUID]:
        locked_embed_media_ids.clear()
        if owner_user_id is not None and embed_urls:
            locked_embed_media_ids.update(reusable_embedded_source_media_ids(db, urls=embed_urls))
        return sorted(locked_embed_media_ids)

    def publish(
        db: Session, locked: MediaSourceAttempt
    ) -> tuple[UUID, ContributorObservationBatch]:
        def replace_projection(media: Media) -> tuple[UUID, ContributorObservationBatch]:
            owner = locked.created_by_user_id or media.created_by_user_id
            if owner is None:
                raise ApiError(ApiErrorCode.E_INTERNAL, "Stored HTML source attempt has no owner.")
            if packet is None:
                delete_document_embed_artifacts(db, owner_user_id=owner, media_id=media_id)
            fragment_id = replace_prepared_article_content(
                db,
                media_id=media_id,
                prepared=prepared,
                embeds=(
                    present(
                        ArticleEmbedReplacement(
                            owner_user_id=owner,
                            child_actor_user_id=owner,
                            source_attempt_id=locked.id,
                            request_id=request_id,
                            locked_existing_target_media_ids=frozenset(locked_embed_media_ids),
                        )
                    )
                    if packet is not None
                    else absent()
                ),
            )
            install_prepared_article_apparatus(
                db,
                media_id=media_id,
                fragment_id=fragment_id,
                prepared=prepared,
                source_html=content_html,
            )
            if packet is None:
                return fragment_id, NOT_OBSERVED
            title = packet.title.strip()
            if title:
                media.title = title[:255]
            return fragment_id, _persist_capture_metadata(db, media, packet)

        return replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind="web_article",
            issues=ReplaceSourceIssues(issues=()),
            replace_projection=replace_projection,
        )

    return run_source_publication_phase(
        session_factory=session_factory,
        label="publish_stored_html_artifacts",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=discover,
    )


def _persist_capture_metadata(
    db: Session, media: Media, packet: ArticlePacket
) -> ContributorObservationBatch:
    excerpt = (nullable_from_presence(packet.excerpt) or "").strip()
    site_name = (nullable_from_presence(packet.site_name) or "").strip()
    byline = (nullable_from_presence(packet.byline) or "").strip()
    if excerpt:
        media.description = excerpt[:2000]
    if site_name:
        media.publisher = site_name[:255]
    edition_date = normalize_source_publication_date(nullable_from_presence(packet.published_time))
    if isinstance(edition_date, Present):
        media.edition_published_date = edition_date.value
    bump_all_media_fact_collections(db)
    if not byline:
        return NOT_OBSERVED
    names = [
        name.strip()
        for name in re.split(
            r"\s*[,;]\s*|\s+and\s+",
            re.sub(r"^by\s+", "", byline, flags=re.IGNORECASE),
            flags=re.IGNORECASE,
        )
        if name.strip()
    ]
    observation, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=name) for name in names]}
    )
    if truncated:
        logger.info("web_article_capture_author_truncated", media_id=str(media.id))
    return observation
