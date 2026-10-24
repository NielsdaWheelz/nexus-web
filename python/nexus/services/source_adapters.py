"""Acquisition per source type, and the file publication the runner fences.

Each adapter opens with one fenced phase that checks the media kind and marks it
extracting (a retained publication keeps it ready), then fetches or reads with no transaction open. Url families publish
through their owners (web article, X, YouTube, podcast transcription) and return an
outcome; files and native articles are prepared here and published by the runner
in its terminal transaction, including current-body facts and source settlement.
Bytes are written before the row that
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

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    XArticleSource,
    XPostAlias,
)
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.extension_capture import XArticleBinding, decode_article_packet
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.schemas.x_source import XSourceScope
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services import x_client
from nexus.services.contributor_taxonomy import ObservedRoleSlices
from nexus.services.epub_ingest import EpubPlan, prepare_epub_source, publish_epub_plan
from nexus.services.media_processing_state import mark_extracting
from nexus.services.media_source_ingest import record_x_article_inspection
from nexus.services.pdf_ingest import PdfPlan, prepare_pdf_source, publish_pdf_plan
from nexus.services.podcasts.transcription import run_podcast_transcription_now
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    lock_publication_generation,
    replace_reader_publication,
    superseded_reader_source_paths,
)
from nexus.services.remote_file import RemoteFile, fetch_remote_file
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection
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
    prepare_article,
    publish_article,
    publish_fetched_article,
    publish_prepared_article,
)
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.services.x_identity import (
    canonical_x_article_url,
    native_x_article_id,
    x_article_provider_id,
)
from nexus.services.x_ingest import PreparedXSource, prepare_x_source
from nexus.services.x_rendering import render_article
from nexus.services.x_source import load_prior_x_source, x_article_content_facts
from nexus.services.youtube import run_youtube_video_ingest
from nexus.services.youtube_identity import classify_youtube_provider_video_id
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path, get_file_extension

_ARTICLE = frozenset({MediaKind.web_article.value})
_DOCUMENT = frozenset({MediaKind.pdf.value, MediaKind.epub.value})


@dataclass(frozen=True, slots=True)
class PreparedFileSource:
    """A prepared PDF/EPUB plan; ``remote_file`` when the run fetched the bytes itself."""

    plan: PdfPlan | EpubPlan
    remote_file: RemoteFile | None


@dataclass(frozen=True, slots=True)
class PreparedNativeArticle:
    article_id: str
    article: Article
    fragment: WebArticlePreparedFragment
    completeness: Literal["unknown", "incomplete"]
    capture_binding: XArticleBinding | None


def acquire(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> SourceRunOutcome | PreparedFileSource | PreparedXSource | PreparedNativeArticle:
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

                def lock_article(db: Session) -> None:
                    sa.lock_identity(db, f"x-article-carrier:{carrier_revision_id}")
                    if article_id is not None:
                        sa.lock_identity(db, f"x-article:{x_article_provider_id(article_id)}")

                run_source_publication_phase(
                    session_factory=session_factory,
                    label="record_x_article_inspection",
                    fence=fence,
                    media_ids=(media_id,),
                    lock_identities=lock_article,
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
            acquired = x_client.fetch_article(post_id=target, expected_article_id=article_id)
            url = canonical_x_article_url(article_id)
            return _prepare_native_article(
                article_id=article_id,
                completeness=acquired.completeness,
                capture_binding=None,
                article=Article(
                    content_html=render_article(acquired),
                    source_html=None,
                    base_url=url,
                    document_url=url,
                    extract_embeds=False,
                    metadata=ArticleMetadata(
                        title=acquired.title or "",
                        byline=acquired.byline or "",
                        excerpt="",
                        site_name="",
                        published_time=acquired.published_date or "",
                    ),
                ),
            )
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
            article = Article(
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
            )
            binding_payload = attempt.source_payload["x_article_binding"]
            binding = (
                XArticleBinding.model_validate(binding_payload)
                if binding_payload is not None
                else None
            )
            if binding is not None and binding.native_target is not None:
                return _prepare_native_article(
                    article_id=binding.article_id,
                    article=article,
                    completeness="unknown",
                    capture_binding=binding,
                )
            fragment_id = publish_article(
                session_factory,
                media_id=media_id,
                request_id=request_id,
                fence=fence,
                article=article,
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


def _prepare_native_article(
    *,
    article_id: str,
    article: Article,
    completeness: Literal["unknown", "incomplete"],
    capture_binding: XArticleBinding | None,
) -> PreparedNativeArticle:
    return PreparedNativeArticle(
        article_id=article_id,
        article=article,
        completeness=completeness,
        capture_binding=capture_binding,
        fragment=prepare_article(
            article.content_html,
            base_url=article.base_url,
            document_url=article.document_url,
            extract_embeds=article.extract_embeds,
            embed_source_html=article.source_html,
        ),
    )


def publish_prepared_native_article(
    db: Session,
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    prepared: PreparedNativeArticle,
    locked_target_ids: frozenset[UUID],
    request_id: str | None,
) -> SourceRunOutcome:
    """Publish body and provenance in the runner's existing terminal transaction."""
    media = db.get(Media, media_id)
    assert media is not None
    owner = attempt.created_by_user_id
    if (
        owner is None
        or media.created_by_user_id != owner
        or not can_read_media(db, owner, media_id)
    ):
        raise ApiError(ApiErrorCode.E_REPAIR_NOT_ALLOWED, "This article is no longer writable.")
    if (
        native_x_article_id(kind=media.kind, provider=media.provider, provider_id=media.provider_id)
        != prepared.article_id
    ):
        raise ApiError(ApiErrorCode.E_X_ARTICLE_IDENTITY_CHANGED, "The article identity changed.")
    if prepared.capture_binding is not None:
        target = prepared.capture_binding.native_target
        assert target is not None
        if (
            target.media_id != media_id
            or target.expected_reader_generation
            != lock_publication_generation(db, media_id=media_id)
        ):
            raise ApiError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "The article changed. Capture it again."
            )
    elif (
        facts := x_article_content_facts(db, media_ids=[media_id]).get(media_id)
    ) is not None and facts.representation == "browser_capture":
        raise ApiError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Capture the page again to replace the browser copy."
        )
    fragment_id = publish_prepared_article(
        db,
        media_id=media_id,
        attempt=attempt,
        article=prepared.article,
        prepared=prepared.fragment,
        request_id=request_id,
        locked_target_ids=locked_target_ids,
        remap_cursors=True,
    )
    metadata = prepared.article.metadata
    assert metadata is not None
    media.title = metadata.title.strip()[:255] or "X article"
    media.description = metadata.excerpt.strip()[:2000] or None
    media.publisher = metadata.site_name.strip()[:255] or None
    media.edition_published_date = normalize_source_publication_date(metadata.published_time)
    facts_row = db.get(XArticleSource, media_id)
    if facts_row is None:
        db.add(
            XArticleSource(
                media_id=media_id, source_attempt_id=attempt.id, completeness=prepared.completeness
            )
        )
    else:
        facts_row.source_attempt_id = attempt.id
        facts_row.completeness = prepared.completeness
    db.flush()
    projection.refresh(db, "media", [media_id])
    projection.refresh_subject_dossiers(db, [ResourceRef("media", media_id)])
    observation = byline_observation(metadata.byline)
    if not isinstance(observation, ObservedRoleSlices):
        observation = ObservedRoleSlices(frozenset({"author"}), ())
    return SourceRunOutcome(
        diagnostics=_published(attempt, fragment_id),
        observations=((media_id, observation, "x_article"),),
        metadata_enrichment=False,
    )


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
    """The run's first fenced write: the media is of an expected kind and extracting, or
    ready on its retained publication."""

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
) -> PdfPlan | EpubPlan:
    def progress(completed: int, total: int, unit: Literal["Page", "Chapter"]) -> None:
        record_source_progress(
            session_factory=session_factory,
            fence=fence,
            media_id=media_id,
            stage="Extract",
            counted=(completed, total, unit),
        )

    plan: PdfPlan | EpubPlan
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
    """Publish a prepared plan in the runner's fenced transaction (the fence is its licence:
    a refresh keeps a retained publication ready); also returns the paths to delete once it
    commits (the superseded file)."""
    plan = prepared.plan
    source_file = None
    media = db.get(Media, media_id)
    assert media is not None  # locked by the fence
    if (fetched := prepared.remote_file) is not None:
        media.canonical_source_url = normalize_url_for_display(fetched.final_url)
        media.updated_at = func.now()
        source_file = ReaderPublicationSourceFile(
            storage_path=plan.storage_path,
            content_type=fetched.content_type,
            size_bytes=fetched.size_bytes,
            source_sha256=fetched.sha256_hex,
        )
    superseded = superseded_reader_source_paths(db, media_id=media_id, source_file=source_file)
    if isinstance(plan, PdfPlan):
        outcome = replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind="pdf",
            replace_projection=lambda locked: publish_pdf_plan(db, locked, plan),
            issues=(),
            source_file=source_file,
        )
    else:
        outcome = replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind="epub",
            replace_projection=lambda locked: publish_epub_plan(db, locked, plan),
            issues=plan.source_issues,
            source_file=source_file,
        )
    return outcome, superseded


def _read_stored(attempt: MediaSourceAttempt) -> bytes:
    """The attempt's stored artifact (a capture packet, an email body)."""
    path = st.stored_artifact_path(attempt.source_payload)
    assert path is not None  # admission stores the artifact before the attempt names it
    return get_storage_client().read_object(path)
