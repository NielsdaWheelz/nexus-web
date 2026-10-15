"""Source admission: every way a source becomes, or becomes again, a media's content.

Classifies a url (YouTube, X thread, remote PDF/EPUB, else a web page), reuses the
media a known source already became, and accepts one attempt with its job in the
same transaction (I11). Recovery (retry a failed source, repair a dead job, refresh
a settled one) admits the latest attempt's successor under the same locks. Nothing
here touches storage or a provider: the worker acquires (``source_runner``).

Retry rules (no replay ledger): a url accept carries a client-minted attempt id, so a
resend finds its own attempt; a retry or refresh finds its own effect as the expected
attempt's successor (I10), and a refresh joins the run already in flight; a repair
finds its job no longer dead. A url accept of a deduped source takes its identity lock
before any row lock (I12).
"""

from __future__ import annotations

import posixpath
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import unquote, urlparse
from uuid import UUID

from sqlalchemy import exists, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    MediaTeardownIntent,
    ProcessingStatus,
)
from nexus.db.retries import admit_serializable, retry_read_committed
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.jobs.queue import jobs_for_payload, requeue_dead_job, supersede_unclaimed_job
from nexus.schemas.import_history import (
    RepairSourceRecovery,
    ReprocessSourceRecovery,
    RetrySourceRecovery,
    SourceRecoveryAccepted,
    SourceSucceeded,
)
from nexus.schemas.import_refs import MediaImportRef, format_import_ref
from nexus.schemas.imports import RepairSourceOffer, RetrySourceOffer
from nexus.schemas.media_sources import FromUrlOut, SourceAdmission, SourceRepairAdmission
from nexus.services import libraries, library_entries
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.media_processing_state import mark_extracting
from nexus.services.reader_publication import ensure_reader_publication
from nexus.services.remote_file import remote_file_kind_from_url
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.x_identity import classify_x_url, is_x_url, x_post_provider_id
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url, placeholder_title
from nexus.storage.paths import get_file_extension

_RESTRICTED = {
    "NotOwner": "Only the creator can retry source content.",
    "SameSourceTerminal": "Retrying cannot change this failure. Add a new source.",
    "SourceNotReacquirable": "The original source bytes are gone. Add the source again.",
}


# --- classification ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class UrlSourceSpec:
    """Everything a url decides about the media and attempt it becomes."""

    source_type: str
    kind: str
    title: str
    canonical_source_url: str | None
    canonical_url: str | None = None
    external_playback_url: str | None = None
    provider: str | None = None
    provider_id: str | None = None
    provider_target_ref: str | None = None


def url_source_spec(url: str) -> UrlSourceSpec:
    """YouTube, then X, then a remote file, else a web page."""
    if (video := classify_youtube_url(url)) is not None:
        return UrlSourceSpec(
            source_type=st.YOUTUBE_VIDEO,
            kind=MediaKind.video.value,
            title=placeholder_title(video.provider_video_id),
            canonical_source_url=video.watch_url,
            canonical_url=video.watch_url,
            external_playback_url=video.watch_url,
            provider=video.provider,
            provider_id=video.provider_video_id,
            provider_target_ref=video.provider_video_id,
        )
    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "YouTube URL must include a valid video ID"
        )
    if (post := classify_x_url(url)) is not None:
        return UrlSourceSpec(
            source_type=st.X_AUTHOR_THREAD,
            kind=MediaKind.web_article.value,
            title=f"X post {post.provider_id}",
            canonical_source_url=post.canonical_url,
            provider=post.provider,
            provider_target_ref=post.provider_id,
        )
    if is_x_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "X URL must include a valid post ID"
        )
    if (kind := remote_file_kind_from_url(url)) is not None:
        name = unquote(posixpath.basename(urlparse(url).path)).strip()
        return UrlSourceSpec(
            source_type=st.REMOTE_PDF_URL if kind == "pdf" else st.REMOTE_EPUB_URL,
            kind=kind,
            title=name or f"download.{get_file_extension(kind)}",
            canonical_source_url=normalize_url_for_display(url),
        )
    return UrlSourceSpec(
        source_type=st.GENERIC_WEB_URL,
        kind=MediaKind.web_article.value,
        title=url[:255],
        canonical_source_url=normalize_url_for_display(url),
    )


def _embedded_spec(url: str) -> UrlSourceSpec | None:
    """A trusted document embed's child source: a YouTube video or one X post."""
    spec = url_source_spec(url)
    if spec.source_type == st.X_AUTHOR_THREAD and spec.provider_target_ref is not None:
        return UrlSourceSpec(
            source_type=st.X_POST,
            kind=spec.kind,
            title=spec.title,
            canonical_source_url=spec.canonical_source_url,
            provider=spec.provider,
            provider_id=x_post_provider_id(spec.provider_target_ref),
            provider_target_ref=spec.provider_target_ref,
        )
    return spec if spec.source_type == st.YOUTUBE_VIDEO else None


def _identity_key(spec: UrlSourceSpec) -> str | None:
    """The lock key of a deduped source (I12); an X post's is the one its publisher takes."""
    match spec.source_type:
        case st.YOUTUBE_VIDEO:
            return f"youtube:{spec.provider_id}"
        case st.X_AUTHOR_THREAD:
            return f"x-thread:{spec.provider_target_ref}"
        case st.X_POST:
            return spec.provider_id
        case st.GENERIC_WEB_URL:
            return f"web:{spec.canonical_source_url}"
    return None


def _reusable_media(db: Session, spec: UrlSourceSpec) -> Media | None:
    """The media a known source already became."""
    match spec.source_type:
        case st.YOUTUBE_VIDEO:
            where = (Media.kind == MediaKind.video.value, Media.canonical_url == spec.canonical_url)
        case st.X_POST:
            where = (Media.provider == "x", Media.provider_id == spec.provider_id)
        case st.X_AUTHOR_THREAD:
            return db.scalars(
                select(Media)
                .join(MediaSourceAttempt, MediaSourceAttempt.media_id == Media.id)
                .where(
                    MediaSourceAttempt.source_type == st.X_AUTHOR_THREAD,
                    MediaSourceAttempt.provider_target_ref == spec.provider_target_ref,
                    Media.provider == "x",
                )
                .order_by(MediaSourceAttempt.created_at, MediaSourceAttempt.id)
                .limit(1)
            ).one_or_none()
        case st.GENERIC_WEB_URL:
            # the exact re-add of a page an article already holds as its final url. an
            # article in teardown is passed over: the new one's run supersedes onto it and
            # converges once the teardown removes it (a video or X media carries its
            # identity from birth, so its re-add is refused until then)
            where = (
                Media.kind == MediaKind.web_article.value,
                Media.canonical_url == spec.canonical_source_url,
                ~exists().where(MediaTeardownIntent.media_id == Media.id),
            )
        case _:
            return None
    return db.scalars(select(Media).where(*where)).one_or_none()


def reusable_embedded_source_media_ids(db: Session, *, urls: list[str]) -> set[UUID]:
    """The pre-existing media an embed publication must lock with its parent."""
    found: set[UUID] = set()
    for url in urls:
        validate_requested_url(url)
        spec = _embedded_spec(url)
        if spec is not None and (media := _reusable_media(db, spec)) is not None:
            found.add(media.id)
    return found


def _new_media(db: Session, spec: UrlSourceSpec, *, url: str, actor_id: UUID) -> Media:
    now = datetime.now(UTC)
    media = Media(
        kind=spec.kind,
        title=spec.title[:255],
        requested_url=url,
        canonical_url=spec.canonical_url,
        canonical_source_url=spec.canonical_source_url,
        external_playback_url=spec.external_playback_url,
        provider=spec.provider,
        provider_id=spec.provider_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=actor_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    db.flush()
    return media


def _adopt_video_identity(media: Media, spec: UrlSourceSpec) -> None:
    """A video matched on its canonical url adopts the url's provider identity."""
    media.provider, media.provider_id = spec.provider, spec.provider_id
    media.external_playback_url = media.external_playback_url or spec.external_playback_url
    media.canonical_source_url = media.canonical_source_url or spec.canonical_source_url
    media.updated_at = datetime.now(UTC)


# --- url acceptance ------------------------------------------------------------


def accept_url_source(
    *,
    db: Session,
    viewer_id: UUID,
    id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None,
    ingest_purpose: Literal["artifact_research"] | None = None,
) -> FromUrlOut:
    """Accept a url on a fresh session; ``id`` is the client-minted attempt id.

    Retry rule: the same id answers its own acceptance (destinations as first sent);
    another user's id is a 409.
    """

    def admit() -> FromUrlOut:
        with transaction(db):
            sa.lock_identity(db, f"attempt:{id}")
            if (sent := db.get(MediaSourceAttempt, id)) is not None:
                if sent.created_by_user_id != viewer_id:
                    raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt id is taken.")
                return _from_url_out(db, sent, id)
            libraries.resolve_writable_destinations(db, viewer_id, library_ids)
            payload: dict[str, object] = {"library_ids": [str(i) for i in library_ids]}
            if ingest_purpose is not None:
                payload["ingest_purpose"] = ingest_purpose
            return _accept_url(db, viewer_id, id, url, library_ids, payload, request_id)

    return retry_read_committed(db, "accept_url_source", admit)


def accept_system_url_source(
    *,
    db: Session,
    actor_user_id: UUID,
    id: UUID,
    url: str,
    expected_kind: str,
    request_id: str | None,
) -> FromUrlOut:
    """A system-owned url in the caller's transaction; the owning service files it.

    Retry rule: as ``accept_url_source``; the system mints a deterministic id.
    """
    if (sent := db.get(MediaSourceAttempt, id)) is not None:
        if sent.created_by_user_id != actor_user_id:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt id is taken.")
        return _from_url_out(db, sent, id)
    if (kind := url_source_spec(url).kind) != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"URL source produced {kind!r}; expected {expected_kind!r}.",
        )
    return _accept_url(db, actor_user_id, id, url, None, {}, request_id)


def _accept_url(
    db: Session,
    actor_id: UUID,
    id: UUID,
    url: str,
    library_ids: list[UUID] | None,
    payload: dict[str, object],
    request_id: str | None,
) -> FromUrlOut:
    validate_requested_url(url)
    spec = url_source_spec(url)
    if (key := _identity_key(spec)) is not None:
        sa.lock_identity(db, key)
    media = _reusable_media(db, spec)
    if media is None:
        media = _new_media(db, spec, url=url, actor_id=actor_id)
        if library_ids is not None:
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, actor_id, media.id, library_ids
            )
        attempt = _url_attempt(db, media, spec, id=id, actor_id=actor_id, url=url, payload=payload)
        sa.enqueue_attempt(db, attempt, actor_id=actor_id, request_id=request_id)
        return _from_url_out(db, attempt, id)
    if library_ids is not None:
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, actor_id, media.id, library_ids
        )
        db.refresh(media)
        if spec.source_type == st.X_AUTHOR_THREAD:
            _file_thread_targets(db, actor_id, media.id, library_ids)
    if spec.source_type == st.YOUTUBE_VIDEO:
        _adopt_video_identity(media, spec)
    latest = sa.latest_attempt(db, media.id, lock=False)
    if latest is not None and latest.status in st.IN_FLIGHT:
        return _from_url_out(db, latest, id)  # I2: join the run in flight
    settled = st.FAILED if media.processing_status == ProcessingStatus.failed else st.SUCCEEDED
    attempt = _url_attempt(
        db, media, spec, id=id, actor_id=actor_id, url=url, payload=payload, status=settled
    )
    return _from_url_out(db, attempt, id)


def _url_attempt(
    db: Session,
    media: Media,
    spec: UrlSourceSpec,
    *,
    id: UUID,
    actor_id: UUID,
    url: str,
    payload: dict[str, object],
    status: Literal["accepted", "succeeded", "failed"] = "accepted",
) -> MediaSourceAttempt:
    return sa.create_attempt(
        db,
        id=id,
        media=media,
        actor_id=actor_id,
        source_type=spec.source_type,
        requested_url=url,
        canonical_source_url=spec.canonical_source_url,
        provider=spec.provider,
        provider_target_ref=spec.provider_target_ref,
        payload=payload,
        status=status,
    )


def _from_url_out(db: Session, attempt: MediaSourceAttempt, id: UUID) -> FromUrlOut:
    """``created``: the answered attempt is this request's own and its media's first."""
    media = db.get(Media, attempt.media_id)
    assert media is not None  # an attempt never outlives its media (foreign key)
    return FromUrlOut(
        import_ref=format_import_ref(MediaImportRef(media_id=media.id)),
        media_id=media.id,
        source_attempt_id=attempt.id,
        created=attempt.id == id and attempt.attempt_no == 1,
        processing_status=media.processing_status,
    )


def _file_thread_targets(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    """A reused X thread files its embedded posts where the thread went."""
    from nexus.services.document_embeds import (
        reconcile_document_embed_edges_for_viewer,
        resolved_document_embed_target_media_ids,
    )

    for target_id in resolved_document_embed_target_media_ids(db, media_id=media_id):
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, target_id, library_ids
        )
    reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=media_id)


# --- programmatic children -----------------------------------------------------


@dataclass(frozen=True, slots=True)
class EmbeddedSourceAcceptance:
    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    provider_target_ref: str | None
    source_attempt_status: str
    processing_status: str
    needs_enqueue: bool


def accept_embedded_source(
    *, db: Session, viewer_id: UUID, url: str, library_ids: list[UUID]
) -> EmbeddedSourceAcceptance:
    """Create or reuse the child source of a trusted embed, flush-only: the publisher
    enqueues a ``needs_enqueue`` child in its own transaction (I11).

    The publisher already holds media rows. An X post locks its post key (every taker of
    that key holds its rows first); a video locks nothing, since the url accept takes the
    video's key before its rows, and dedupes on ``uix_media_canonical_url`` (retryable)."""
    validate_requested_url(url)
    spec = _embedded_spec(url)
    if spec is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unsupported embedded source provider."
        )
    if spec.source_type == st.X_POST and (key := _identity_key(spec)) is not None:
        sa.lock_identity(db, key)
    media = _reusable_media(db, spec)
    created = media is None
    if media is None:
        media = _new_media(db, spec, url=url, actor_id=viewer_id)
        attempt = _url_attempt(
            db,
            media,
            spec,
            id=new_uuid7(),
            actor_id=viewer_id,
            url=url,
            payload={"library_ids": [str(i) for i in library_ids]},
        )
    else:
        if spec.source_type == st.YOUTUBE_VIDEO:
            _adopt_video_identity(media, spec)
        latest = sa.latest_attempt(db, media.id, lock=False)
        assert latest is not None  # a reusable media was accepted through an attempt
        attempt = latest
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    return EmbeddedSourceAcceptance(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        provider_target_ref=attempt.provider_target_ref,
        source_attempt_status=attempt.status,
        processing_status=media.processing_status.value,
        needs_enqueue=created,
    )


def enqueue_podcast_episode_transcript_source_attempt(
    *,
    db: Session,
    media_id: UUID,
    viewer_id: UUID,
    request_reason: TranscriptRequestReason,
    request_id: str | None,
) -> Literal["created", "idempotent"]:
    """Bind transcript work in the caller's transaction; an attempt in flight suffices."""
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.podcast_episode.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Transcript attempts target podcast episodes."
        )
    latest = sa.latest_attempt(db, media_id, lock=False)
    if latest is not None and latest.status in st.IN_FLIGHT:
        return "idempotent"
    attempt = sa.create_attempt(
        db,
        id=new_uuid7(),
        media=media,
        actor_id=viewer_id,
        source_type=st.PODCAST_EPISODE_TRANSCRIPT,
        requested_url=media.requested_url,
        canonical_source_url=media.canonical_source_url,
        provider=media.provider,
        provider_target_ref=media.provider_id,
        payload={"request_reason": request_reason},
    )
    mark_extracting(db, media)
    sa.enqueue_attempt(db, attempt, actor_id=viewer_id, request_id=request_id)
    return "created"


def complete_x_post_snapshot_attempt(
    db: Session,
    *,
    media: Media,
    source_attempt_id: UUID,
    parent_source_attempt_id: UUID,
    viewer_id: UUID,
    post_id: str,
    canonical_url: str,
) -> MediaSourceAttempt:
    """Settle an X-post child from its parent thread's snapshot, under the parent's fence;
    the settled attempt names the parent attempt it came from.

    A settled child gains a succeeded successor; an in-flight one succeeds in place and
    its unclaimed job is retired. The jobs are read unlocked: a worker holding the
    child's job row may be waiting on this media, and a claimed run can never publish
    over the succeeded attempt (the fence requires a nonterminal attempt).
    """
    attempt = db.get(MediaSourceAttempt, source_attempt_id)
    assert attempt is not None and attempt.media_id == media.id  # the accepted child
    parent: dict[str, object] = {"parent_source_attempt_id": str(parent_source_attempt_id)}
    if attempt.status in (st.FAILED, st.SUCCEEDED):
        return sa.create_attempt(
            db,
            id=sa.successor_id(attempt.id),
            media=media,
            actor_id=viewer_id,
            source_type=st.X_POST,
            requested_url=canonical_url,
            canonical_source_url=canonical_url,
            provider="x",
            provider_target_ref=post_id,
            payload=parent,
            status="succeeded",
        )
    if attempt.status == st.QUEUED and attempt.job_id is not None:
        for job in jobs_for_payload(
            db,
            kind="ingest_media_source",
            match={"attempt_id": str(attempt.id)},
            statuses=("pending", "failed"),
        ):
            if job.id == attempt.job_id:
                supersede_unclaimed_job(db, job_id=job.id, kind="ingest_media_source")
    now = datetime.now(UTC)
    attempt.source_payload = {**(attempt.source_payload or {}), **parent}
    attempt.status = st.SUCCEEDED
    attempt.error_code = attempt.error_message = None
    attempt.finished_at = attempt.updated_at = now
    sa.record_event(db, attempt, SourceSucceeded(source_attempt_id=attempt.id, execution_id=None))
    return attempt


# --- recovery ------------------------------------------------------------------


def _owned_media(db: Session, viewer_id: UUID, media_id: UUID) -> Media:
    """The viewer's own media, key-share locked: invisible is 404, another's is 403."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
    return media


def _require_unpublished_document(db: Session, media: Media) -> None:
    """I9: an epub's reader identities are never replaced."""
    if media.kind != MediaKind.epub.value:
        return
    exposed = db.scalar(
        text("""
            SELECT EXISTS (SELECT 1 FROM reader_publications WHERE media_id = :id)
                OR EXISTS (SELECT 1 FROM fragments WHERE media_id = :id)
                OR EXISTS (SELECT 1 FROM reader_media_state
                           WHERE media_id = :id AND locator IS NOT NULL)
                OR EXISTS (SELECT 1 FROM highlights WHERE anchor_media_id = :id)
                OR EXISTS (SELECT 1 FROM passage_anchors
                           WHERE owner_scheme = 'media' AND owner_id = :id)
        """),
        {"id": media.id},
    )
    if exposed:
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Reader content already exists for this media."
        )


def _admit_successor(
    db: Session, media: Media, latest: MediaSourceAttempt, *, actor_id: UUID, request_id: str | None
) -> MediaSourceAttempt:
    """The one recovery step: the latest attempt's source becomes its successor (I10),
    a transcript job is reset, the media extracts again and the successor is enqueued."""
    _require_unpublished_document(db, media)
    payload = dict(latest.source_payload or {})
    payload.pop("parent_source_attempt_id", None)  # a successor runs on its own
    if latest.source_type == st.PODCAST_EPISODE_TRANSCRIPT:
        from nexus.services.podcasts.transcription import reset_podcast_transcription_job

        payload["request_reason"] = "operator_requeue"
        reset_podcast_transcription_job(db, media_id=media.id, request_reason="operator_requeue")
    successor = sa.create_attempt(
        db,
        id=sa.successor_id(latest.id),
        media=media,
        actor_id=actor_id,
        source_type=latest.source_type,
        requested_url=latest.requested_url,
        canonical_source_url=latest.canonical_source_url,
        provider=latest.provider,
        provider_target_ref=latest.provider_target_ref,
        payload=payload,
    )
    mark_extracting(db, media)
    sa.enqueue_attempt(db, successor, actor_id=actor_id, request_id=request_id)
    return successor


def _admission(attempt: MediaSourceAttempt) -> SourceAdmission:
    return SourceAdmission(
        media_id=attempt.media_id, source_attempt_id=attempt.id, job_id=attempt.job_id
    )


def _stale(latest: MediaSourceAttempt | None, message: str) -> ConflictError:
    current = {"attempt_id": None if latest is None else str(latest.id)}
    return ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, message, details={"current": current})


def retry_source(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_attempt_id: UUID,
    request_id: str | None,
) -> SourceAdmission:
    """Retry a terminally failed source through a new attempt.

    Retry rule: when the expected attempt's successor exists the retry already
    landed and answers it; an expectation that is no longer latest is a 409.
    """

    def admit() -> SourceAdmission:
        media = _owned_media(db, viewer_id, media_id)
        latest = sa.latest_attempt(db, media.id, lock=True)
        landed = db.get(MediaSourceAttempt, sa.successor_id(expected_attempt_id))
        if landed is not None and landed.media_id == media.id:
            db.commit()
            return _admission(landed)
        if latest is None or latest.id != expected_attempt_id:
            raise _stale(latest, "The inspected source attempt is no longer current.")
        offer = sa.source_recovery(sa.recovery_facts(db, media, latest, viewer_id=viewer_id))
        if not isinstance(offer, RetrySourceOffer):
            reason = _RESTRICTED[offer] if isinstance(offer, str) else "Nothing to retry."
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, reason)
        successor = _admit_successor(db, media, latest, actor_id=viewer_id, request_id=request_id)
        sa.record_event(
            db,
            latest,
            SourceRecoveryAccepted(
                source_attempt_id=latest.id,
                recovery=RetrySourceRecovery(new_source_attempt_id=successor.id),
            ),
        )
        db.commit()
        return _admission(successor)

    return admit_serializable(db, "retry_source", admit)


def reprocess_failed_stored_epub(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_attempt_id: UUID,
    expected_source_sha256: str,
    request_id: str | None,
) -> SourceAdmission:
    """Operator-only admission after diagnosed processing conditions have changed.

    Ordinary retry eligibility stays unchanged. The inspected failed attempt and
    stored source are fenced; its deterministic successor makes replay read-only.
    The normal worker still verifies the bytes and all archive/publication limits.
    """

    def admit() -> SourceAdmission:
        media = _owned_media(db, viewer_id, media_id)
        latest = sa.latest_attempt(db, media.id, lock=True)
        expected = db.get(MediaSourceAttempt, expected_attempt_id, with_for_update=True)
        if expected is None or expected.media_id != media.id:
            raise _stale(latest, "The inspected source attempt does not belong to this media.")
        if (
            media.kind != MediaKind.epub.value
            or expected.status != st.FAILED
            or expected.source_type not in (st.UPLOADED_EPUB_FILE, st.BROWSER_EPUB_CAPTURE)
        ):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "A failed stored EPUB source is required."
            )
        original = db.get(MediaFile, media.id, with_for_update=True)
        if original is None or original.source_sha256 != expected_source_sha256:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "The inspected stored source has changed."
            )
        landed = db.get(MediaSourceAttempt, sa.successor_id(expected.id))
        if landed is not None and landed.media_id == media.id:
            db.commit()
            return _admission(landed)
        if latest is None or latest.id != expected.id:
            raise _stale(latest, "The inspected source attempt is no longer current.")
        if media.processing_status != ProcessingStatus.failed:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "The inspected media is no longer failed."
            )
        successor = _admit_successor(db, media, latest, actor_id=viewer_id, request_id=request_id)
        sa.record_event(
            db,
            latest,
            SourceRecoveryAccepted(
                source_attempt_id=latest.id,
                recovery=ReprocessSourceRecovery(new_source_attempt_id=successor.id),
            ),
        )
        db.commit()
        return _admission(successor)

    return admit_serializable(db, "reprocess_failed_stored_epub", admit)


def refresh_source(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_attempt_id: UUID,
    request_id: str | None,
) -> SourceAdmission:
    """Re-acquire the settled source the viewer inspected through a new attempt.

    Retry rule: when the expected attempt's successor exists the refresh already landed
    and answers it; an expected run still in flight answers itself (a second press joins
    it); an expectation that is no longer latest is a 409. A stopped run is the repair
    offer's, never refresh's.
    """

    def admit() -> SourceAdmission:
        media = _owned_media(db, viewer_id, media_id)
        latest = sa.latest_attempt(db, media.id, lock=True)
        landed = db.get(MediaSourceAttempt, sa.successor_id(expected_attempt_id))
        if landed is not None and landed.media_id == media.id:
            db.commit()
            return _admission(landed)
        if latest is None or latest.id != expected_attempt_id:
            raise _stale(latest, "The inspected source attempt is no longer current.")
        facts = sa.recovery_facts(db, media, latest, viewer_id=viewer_id)
        if latest.status in st.IN_FLIGHT and latest.job_id is not None and not facts.repairable:
            db.commit()
            return _admission(latest)
        if not sa.source_refreshable(facts):
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "Nothing to refresh.")
        if media.kind == MediaKind.web_article.value and media.provider == "x":
            # the readable copy is retained while the refresh runs, and if it fails
            ensure_reader_publication(db, media_id=media.id)
        successor = _admit_successor(db, media, latest, actor_id=viewer_id, request_id=request_id)
        db.commit()
        return _admission(successor)

    return admit_serializable(db, "refresh_source", admit)


def repair_source(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_attempt_id: UUID,
    expected_job_id: UUID,
) -> SourceRepairAdmission:
    """Requeue the exact dead job of the latest in-flight attempt.

    Retry rule: the same attempt and job, no longer dead, is the repair that landed.
    """

    def admit() -> SourceRepairAdmission:
        media = _owned_media(db, viewer_id, media_id)
        latest = sa.latest_attempt(db, media.id, lock=True)
        if latest is None or (latest.id, latest.job_id) != (expected_attempt_id, expected_job_id):
            raise _stale(latest, "The inspected source execution is no longer current.")
        answer = SourceRepairAdmission(
            media_id=media.id, source_attempt_id=latest.id, job_id=expected_job_id
        )
        offer = sa.source_recovery(sa.recovery_facts(db, media, latest, viewer_id=viewer_id))
        if not isinstance(offer, RepairSourceOffer):
            if latest.status in st.IN_FLIGHT:
                db.commit()
                return answer
            raise ConflictError(ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Nothing to repair.")
        _require_unpublished_document(db, media)
        requeue_dead_job(db, job_id=expected_job_id)
        sa.record_event(
            db,
            latest,
            SourceRecoveryAccepted(
                source_attempt_id=latest.id, recovery=RepairSourceRecovery(job_id=expected_job_id)
            ),
        )
        db.commit()
        return answer

    return admit_serializable(db, "repair_source", admit)


def repair_source_for_system_media(
    *, db: Session, actor_user_id: UUID, media_id: UUID, request_id: str | None
) -> None:
    """The system owner's retry, in its transaction: a run in flight or a settled success
    needs nothing; a re-acquirable failure gets its successor."""
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    latest = sa.latest_attempt(db, media.id, lock=True)
    if latest is None or latest.status in st.IN_FLIGHT or latest.status == st.SUCCEEDED:
        return
    offer = sa.source_recovery(sa.recovery_facts(db, media, latest, viewer_id=actor_user_id))
    if not isinstance(offer, RetrySourceOffer):
        raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "System source cannot be retried.")
    _admit_successor(db, media, latest, actor_id=actor_user_id, request_id=request_id)
