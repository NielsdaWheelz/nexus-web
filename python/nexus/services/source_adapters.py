"""Acquisition per source type, and the file publication the runner fences.

Each adapter opens with one fenced phase that checks the media kind and marks it
extracting, then fetches or reads with no transaction open. Url families publish
through their owners (web article, X, YouTube, podcast transcription) and return an
outcome; files are prepared here (PDF/EPUB plans with counted progress) and published
by the runner in its terminal transaction. Bytes are written before the row that
names them: a write that never commits is an orphan the storage sweep reclaims.
A stored artifact that is missing raises ``E_STORAGE_MISSING``, which is terminal;
any other storage error is the queue's to retry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Media, MediaFile, MediaKind, MediaSourceAttempt, XPostAlias
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.extension_capture import decode_article_packet
from nexus.schemas.x_source import XSourceScope
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services import x_client
from nexus.services.epub_ingest import EpubExtractionPlan
from nexus.services.epub_lifecycle import prepare_epub_source, publish_epub_source
from nexus.services.media_processing_state import mark_extracting
from nexus.services.media_source_ingest import record_x_article_inspection
from nexus.services.pdf_ingest import PdfExtractionPlan
from nexus.services.pdf_lifecycle import prepare_pdf_source, publish_pdf_source
from nexus.services.podcasts.transcription import run_podcast_transcription_now
from nexus.services.reader_publication import ReaderPublicationSourceFile
from nexus.services.remote_file import RemoteFile, fetch_remote_file
from nexus.services.source_outcome import (
    SourceDiagnostics,
    SourceRunOutcome,
    source_contributor_observations,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    record_source_progress,
    run_source_publication_phase,
)
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article import (
    Article,
    ArticleMetadata,
    byline_observation,
    publish_article,
    publish_fetched_article,
)
from nexus.services.x_identity import x_article_provider_id
from nexus.services.x_ingest import PreparedXSource, prepare_x_source
from nexus.services.x_source import load_prior_x_source
from nexus.services.youtube import run_youtube_video_ingest
from nexus.services.youtube_identity import classify_youtube_provider_video_id
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path, get_file_extension

_ARTICLE = frozenset({MediaKind.web_article.value})
_DOCUMENT = frozenset({MediaKind.pdf.value, MediaKind.epub.value})


@dataclass(frozen=True, slots=True)
class PreparedFileSource:
    """A prepared PDF/EPUB plan; ``remote_file`` when the run fetched the bytes itself."""

    plan: PdfExtractionPlan | EpubExtractionPlan
    remote_file: RemoteFile | None


def acquire(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> SourceRunOutcome | PreparedFileSource | PreparedXSource:
    """Acquire one detached attempt in its source type's own refusal order.

    Admission wrote every provider target and url these read (0282 backfilled the
    rest), so their absence is a defect, not a refusal.
    """
    target = attempt.provider_target_ref
    match attempt.source_type:
        case st.GENERIC_WEB_URL:
            _begin(session_factory, media_id, fence, _ARTICLE)
            return publish_fetched_article(
                session_factory,
                media_id=media_id,
                attempt=attempt,
                request_id=request_id,
                fence=fence,
            )
        case st.YOUTUBE_VIDEO:
            identity = classify_youtube_provider_video_id(target)
            assert identity is not None
            _begin(session_factory, media_id, fence, frozenset({MediaKind.video.value}))
            return run_youtube_video_ingest(
                session_factory, media_id, identity=identity, publication_fence=fence
            )
        case st.X_AUTHOR_THREAD | st.X_POST:
            assert target is not None
            _begin(session_factory, media_id, fence, _ARTICLE)
            scope: XSourceScope = (
                "author_thread" if attempt.source_type == st.X_AUTHOR_THREAD else "post"
            )
            with session_factory() as db:
                get_repeatable_read_db(db)
                prior = load_prior_x_source(
                    db, media_id=media_id, requested_revision_id=target, scope=scope
                )
                requested_owner = db.scalar(
                    select(XPostAlias.post_media_id).where(XPostAlias.revision_id == target)
                )
                baseline_ids = {media_id, *(post.media_id for post in prior.posts)}
                if requested_owner is not None:
                    baseline_ids.add(requested_owner)
                baselines = {}
                for identity in baseline_ids:
                    latest = sa.latest_attempt(db, identity, lock=False)
                    baselines[identity] = latest.id if latest else None
            carrier = x_client.lookup_x_carrier(requested_revision_id=target, prior=prior)
            carrier_revision_id = carrier.source_revision_id
            article_id = carrier.article_id
            if scope == "author_thread" and carrier_revision_id is not None:
                run_source_publication_phase(
                    session_factory=session_factory,
                    label="record_x_article_inspection",
                    fence=fence,
                    media_ids=(media_id,),
                    lock_identities=lambda db: sa.lock_identity(
                        db, f"x-article:{x_article_provider_id(article_id)}"
                    )
                    if article_id is not None
                    else None,
                    discover=lambda db: list(
                        db.scalars(
                            select(Media.id).where(
                                Media.provider == "x",
                                Media.provider_id == x_article_provider_id(article_id),
                            )
                        )
                    )
                    if article_id is not None
                    else [],
                    mutate=lambda db, locked: record_x_article_inspection(
                        db,
                        attempt=locked,
                        carrier_post_id=carrier_revision_id,
                        article_id=article_id,
                        request_id=request_id,
                    ),
                )
            return prepare_x_source(
                acquired=x_client.fetch_x_source(carrier=carrier, scope=scope),
                prior=prior,
                baseline_attempt_ids=baselines,
            )
        case st.X_ARTICLE:
            assert target is not None
            article_id = attempt.source_payload["article_id"]
            assert isinstance(article_id, str)
            _begin(session_factory, media_id, fence, _ARTICLE)
            x_client.fetch_article(post_id=target, expected_article_id=article_id)
        case st.REMOTE_PDF_URL | st.REMOTE_EPUB_URL:
            assert attempt.requested_url is not None
            kind = _begin(session_factory, media_id, fence, _DOCUMENT)
            path = build_source_artifact_storage_path(
                media_id, attempt.id, f"original-{get_file_extension(kind)}"
            )
            settings = get_settings()
            fetched = fetch_remote_file(
                attempt.requested_url,
                kind=kind,
                storage_path=path,
                storage=get_storage_client(),
                max_bytes=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
            )
            plan = _prepare(
                session_factory, media_id, kind, fence, path, fetched.size_bytes, fetched.sha256_hex
            )
            return PreparedFileSource(plan=plan, remote_file=fetched)
        case st.BROWSER_ARTICLE_CAPTURE:
            _begin(session_factory, media_id, fence, _ARTICLE)
            packet = decode_article_packet(_read_stored(attempt))
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
                diagnostics=_published(attempt, fragment_id),
                observations=source_contributor_observations(
                    media_id=media_id,
                    observation=byline_observation(byline),
                    source="web_article_capture",
                ),
                metadata_enrichment=True,
            )
        case st.EMAIL_MESSAGE:
            _begin(session_factory, media_id, fence, _ARTICLE)
            try:
                html = _read_stored(attempt).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise InvalidRequestError(
                    ApiErrorCode.E_SANITIZATION_FAILED, "Email source is not valid UTF-8."
                ) from exc
            if not html:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Email has no readable text content."
                )
            fragment_id = publish_article(
                session_factory,
                media_id=media_id,
                request_id=request_id,
                fence=fence,
                article=Article(
                    content_html=html,
                    source_html=None,
                    base_url="",
                    document_url="",
                    extract_embeds=False,
                    metadata=None,
                ),
            )
            return SourceRunOutcome(
                diagnostics=_published(attempt, fragment_id), metadata_enrichment=False
            )
        case st.PODCAST_EPISODE_TRANSCRIPT:
            reason = cast(TranscriptRequestReason, attempt.source_payload["request_reason"])
            _begin(session_factory, media_id, fence, frozenset({MediaKind.podcast_episode.value}))
            completed = run_podcast_transcription_now(
                session_factory, media_id=media_id, publication_fence=fence
            )
            return SourceRunOutcome(
                diagnostics={
                    "status": completed.status,
                    "segment_count": completed.segment_count,
                    "source_type": attempt.source_type,
                },
                metadata_enrichment=True,
                transcript_request_reason=reason,
            )
        case (
            st.UPLOADED_PDF_FILE
            | st.UPLOADED_EPUB_FILE
            | st.BROWSER_PDF_CAPTURE
            | st.BROWSER_EPUB_CAPTURE
        ):
            return _stored_file(session_factory, media_id, fence)
    raise ApiError(ApiErrorCode.E_INVALID_KIND, f"Unsupported source type: {attempt.source_type}")


def _published(attempt: MediaSourceAttempt, fragment_id: UUID) -> SourceDiagnostics:
    return {
        "status": "success",
        "source_type": attempt.source_type,
        "fragment_id": str(fragment_id),
    }


def _begin(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    fence: SourcePublicationFence,
    kinds: frozenset[str],
) -> str:
    """The run's first fenced write: the media is of an expected kind and extracting."""

    def begin(db: Session, _attempt: MediaSourceAttempt) -> str:
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.kind not in kinds:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, f"Source requires {'/'.join(sorted(kinds))} media."
            )
        mark_extracting(db, media)
        return media.kind

    return run_source_publication_phase(
        session_factory=session_factory,
        label="begin_source_extraction",
        fence=fence,
        media_ids=(media_id,),
        mutate=begin,
    )


def _stored_file(
    session_factory: sessionmaker[Session], media_id: UUID, fence: SourcePublicationFence
) -> PreparedFileSource:
    """An uploaded or captured PDF/EPUB: its bytes are the media's file."""

    def begin(db: Session, _attempt: MediaSourceAttempt) -> tuple[str, str, int, str]:
        media, file = db.get(Media, media_id), db.get(MediaFile, media_id)
        if media is None or media.kind not in _DOCUMENT:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, "Source file must be PDF or EPUB."
            )
        if file is None:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING, "Source file metadata missing."
            )
        mark_extracting(db, media)
        return media.kind, file.storage_path, file.size_bytes, str(file.source_sha256)

    kind, path, size, sha256 = run_source_publication_phase(
        session_factory=session_factory,
        label="begin_stored_file_extraction",
        fence=fence,
        media_ids=(media_id,),
        mutate=begin,
    )
    plan = _prepare(session_factory, media_id, kind, fence, path, size, sha256)
    return PreparedFileSource(plan=plan, remote_file=None)


def _prepare(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    kind: str,
    fence: SourcePublicationFence,
    path: str,
    size: int,
    sha256: str,
) -> PdfExtractionPlan | EpubExtractionPlan:
    def progress(completed: int, total: int, unit: Literal["Page", "Chapter"]) -> None:
        record_source_progress(
            session_factory=session_factory,
            fence=fence,
            media_id=media_id,
            stage="Extract",
            counted=(completed, total, unit),
        )

    plan: PdfExtractionPlan | EpubExtractionPlan
    if kind == MediaKind.pdf.value:
        plan = prepare_pdf_source(
            media_id=media_id,
            attempt_id=fence.attempt_id,
            storage_path=path,
            source_size_bytes=size,
            expected_source_sha256=sha256,
            record_progress=progress,
        )
    else:
        plan = prepare_epub_source(
            media_id=media_id,
            attempt_id=fence.attempt_id,
            storage_path=path,
            source_size_bytes=size,
            expected_source_sha256=sha256,
            record_progress=progress,
        )
    record_source_progress(
        session_factory=session_factory, fence=fence, media_id=media_id, stage="Finalize"
    )
    return plan


def publish_prepared_file(
    db: Session, *, media_id: UUID, prepared: PreparedFileSource
) -> tuple[SourceRunOutcome, list[str]]:
    """Publish a prepared plan in the runner's fenced transaction; also returns the paths
    to delete once it commits (the superseded file, or the rejected one)."""
    source_file = None
    if (fetched := prepared.remote_file) is not None:
        media = db.get(Media, media_id)
        assert media is not None  # locked by the fence
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


def _read_stored(attempt: MediaSourceAttempt) -> bytes:
    """The attempt's stored artifact (a capture packet, an email body)."""
    path = st.stored_artifact_path(attempt.source_payload)
    assert path is not None  # admission stores the artifact before the attempt names it
    return get_storage_client().read_object(path)
