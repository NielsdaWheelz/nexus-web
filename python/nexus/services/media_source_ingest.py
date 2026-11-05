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
after the viewer lock and before media/library locks (I12). The frozen removal
fence and destination authority apply to every fresh acquisition; an append compares
no library order. An existing own receipt only answers identity; it never retains or
files again. Capture-input receipts survive physical teardown as acceptance facts;
other source receipts share their media's lifetime. Automatic children
require current parent access and preserve child removal markers.
"""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import unquote, urlparse
from uuid import UUID

from sqlalchemy import exists, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import (
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    MediaTeardownIntent,
    ProcessingStatus,
    XArticleInspection,
)
from nexus.db.retries import retry_serializable
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.jobs.queue import get_job, requeue_dead_job, resume_held_job, supersede_unclaimed_job
from nexus.schemas.acquisition import ExtensionSourceAdmission
from nexus.schemas.extension_capture import CreateExtensionSourceRequest, XStatusSource
from nexus.schemas.import_history import SourceRecoveryAccepted
from nexus.schemas.import_refs import MediaImportRef, format_import_ref
from nexus.schemas.imports import RepairSourceOffer, RetrySourceOffer
from nexus.schemas.media_sources import (
    FromUrlOut,
    FromXCaptureOut,
    SourceAdmission,
    SourceAttemptOut,
    SourceRepairAdmission,
)
from nexus.schemas.x_source import XAuthorThreadPayload, XCaptureInput
from nexus.services import libraries, library_entries, media_locks, source_targets, users
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.media_processing_state import mark_extracting
from nexus.services.reader_publication import ensure_reader_publication, lock_publication_generation
from nexus.services.remote_file import remote_file_kind_from_url
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.url_normalize import (
    normalize_url_for_display,
    normalize_url_for_identity,
    validate_requested_url,
)
from nexus.services.x_identity import (
    canonical_x_article_url,
    canonical_x_post_url,
    classify_x_article_carrier_url,
    classify_x_article_url,
    classify_x_url,
    is_x_url,
    native_x_article_id,
    x_article_provider_id,
)
from nexus.services.x_source import x_article_child_media_ids, x_thread_candidates
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
    if classify_x_article_url(url) is not None or classify_x_article_carrier_url(url) is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_X_ARTICLE_POST_LINK_REQUIRED, "Use the article's post link."
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
    return spec if spec.source_type == st.YOUTUBE_VIDEO else None


def _identity_key(spec: UrlSourceSpec) -> str | None:
    """The lock key of a deduped source (I12); an X post's is the one its publisher takes."""
    match spec.source_type:
        case st.YOUTUBE_VIDEO:
            return f"youtube:{spec.provider_id}"
        case st.X_AUTHOR_THREAD | st.X_POST:
            return f"x-post:{spec.provider_target_ref}"
        case st.X_ARTICLE:
            return f"x-article:{spec.provider_id}"
        case st.GENERIC_WEB_URL:
            assert spec.canonical_source_url is not None
            return f"web:{normalize_url_for_identity(spec.canonical_source_url)}"
    return None


def _reusable_media(
    db: Session, spec: UrlSourceSpec, *, viewer_id: UUID | None = None
) -> Media | None:
    """The media a known source already became."""
    match spec.source_type:
        case st.YOUTUBE_VIDEO:
            where = (Media.kind == MediaKind.video.value, Media.canonical_url == spec.canonical_url)
        case st.X_ARTICLE:
            assert spec.provider_id is not None
            article_id = spec.provider_id.removeprefix("article:")
            candidates = source_targets.article_candidates(db, article_id)
            if len(candidates) > 1 or any(
                native_x_article_id(kind=m.kind, provider=m.provider, provider_id=m.provider_id)
                != article_id
                for m in candidates
            ):
                raise ConflictError(
                    ApiErrorCode.E_X_IDENTITY_CONFLICT,
                    "A saved copy already holds this article identity.",
                )
            return candidates[0] if candidates else None
        case st.X_AUTHOR_THREAD:
            assert viewer_id is not None and spec.provider_target_ref is not None
            holders = x_thread_candidates(
                db, viewer_id=viewer_id, revision_ids=(spec.provider_target_ref,)
            )[spec.provider_target_ref]
            if len(holders) > 1:
                raise ConflictError(
                    ApiErrorCode.E_X_IDENTITY_CONFLICT,
                    "these saved threads overlap. both were kept; repair is required.",
                )
            return db.get(Media, holders[0]) if holders else None
        case st.GENERIC_WEB_URL:
            # the re-add of a page an article already holds as its final url. an
            # article in teardown is passed over: the new one's run supersedes onto it and
            # converges once the teardown removes it (a video or X media carries its
            # identity from birth, so its re-add is refused until then)
            assert spec.canonical_source_url is not None
            identity = normalize_url_for_identity(spec.canonical_source_url)
            matches = [
                media
                for media in db.scalars(
                    select(Media).where(
                        Media.kind == MediaKind.web_article.value,
                        Media.canonical_url.is_not(None),
                        ~exists().where(MediaTeardownIntent.media_id == Media.id),
                    )
                )
                if media.canonical_url is not None
                and normalize_url_for_identity(media.canonical_url) == identity
            ]
            if len(matches) > 1:
                raise ConflictError(
                    ApiErrorCode.E_SOURCE_TARGET_AMBIGUOUS,
                    "Several saved items have this source.",
                )
            return matches[0] if matches else None
        case _:
            return None
    return db.scalars(select(Media).where(*where)).one_or_none()


def reusable_embedded_source_media_ids(db: Session, *, urls: list[str]) -> set[UUID]:
    """Lock aliases before discovering the children an embed publisher must lock.

    Called only in publication discovery, before any media row lock.
    """
    specs = [_embedded_spec(url) for url in urls]
    for key in sorted(
        {
            key
            for spec in specs
            if spec is not None
            and spec.source_type == st.X_POST
            and (key := _identity_key(spec)) is not None
        }
    ):
        sa.lock_identity(db, key)
    found: set[UUID] = set()
    for url, spec in zip(urls, specs, strict=True):
        validate_requested_url(url)
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
    projection.refresh(db, "media", [media.id])
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
    expected_removal_revision: int,
    destinations: list[UUID],
    request_id: str | None,
) -> FromUrlOut:
    """Accept a url on a fresh session; ``id`` is the client-minted attempt id.

    Retry rule: the same id answers its own acceptance without reapplying destinations;
    another user's id is a 409.
    """

    def admit() -> FromUrlOut:
        users.lock_viewer(db, viewer_id)
        sa.lock_identity(db, f"attempt:{id}")
        # A replay only reads after this: keep teardown from removing its
        # media between the attempt and destination reads.
        if (sent := db.get(MediaSourceAttempt, id, with_for_update={"read": True})) is not None:
            if sent.created_by_user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt id is taken.")
            if _capture_receipt_id(sent) is not None:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "attempt id already saved a captured post"
                )
        superseded = db.execute(
            text(
                "SELECT media_id, created_by_user_id FROM media_source_supersessions"
                " WHERE source_attempt_id = :id FOR SHARE"
            ),
            {"id": id},
        ).one_or_none()
        if superseded is not None:
            if superseded.created_by_user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt id is taken.")
            latest = sa.latest_attempt(db, superseded.media_id, lock=False)
            assert latest is not None
            return _from_url_out(db, latest, id).model_copy(update={"source_attempt_id": id})
        if sent is not None:
            return _from_url_out(db, sent, id)
        result = _accept_url(
            db,
            viewer_id,
            id,
            url,
            destinations,
            {},
            request_id,
            expected_removal_revision=expected_removal_revision,
        )
        shared_viewers = db.scalars(
            text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
            {"ids": destinations},
        ).all()
        projection.refresh_viewer_contributors(db, [viewer_id, *shared_viewers])
        record_input_change(db, owners=(f"media:{result.media_id}",))
        return result

    # justify-retry-schedule: lab-scale evidence only. there, with tables small enough that
    # every serializable read locks its whole relation, the account's own background
    # settlement cancelled acceptance as a pivot in bursts: 8 of 449 exhausted three
    # immediate attempts, 0 of 877 exhausted six. production's rate is unknown, and the wide
    # reads that cause it stay open in lone-acquisition-exhausts-serializable-retry.
    return retry_serializable(db, "accept_url_source", admit, retries=6)


def accept_extension_source(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateExtensionSourceRequest,
    request_id: str | None,
) -> FromUrlOut:
    """Each fresh post invocation owns an attempt; its exact replay only reads."""
    source = source_targets.source_for_url(request.url)
    if not isinstance(source, XStatusSource):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "An X post URL is required.")
    payload = XAuthorThreadPayload(
        capture_input=None,
        parent_source_attempt_id=None,
        extension_source=ExtensionSourceAdmission(
            expected_target=request.expected_target,
            expected_removal_revision=request.expected_removal_revision,
        ),
    ).model_dump(mode="json")

    def admit() -> FromUrlOut:
        users.lock_viewer(db, viewer_id)
        sa.lock_identity(db, f"attempt:{request.id}")
        superseded = db.execute(
            text(
                "SELECT media_id, created_by_user_id FROM media_source_supersessions "
                "WHERE source_attempt_id=:id FOR SHARE"
            ),
            {"id": request.id},
        ).one_or_none()
        if superseded is not None:
            if superseded.created_by_user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt id is taken.")
            latest = sa.latest_attempt(db, superseded.media_id, lock=False)
            assert latest is not None
            return _from_url_out(db, latest, request.id).model_copy(
                update={"source_attempt_id": request.id}
            )
        sent = db.get(MediaSourceAttempt, request.id, with_for_update={"read": True})
        if sent is not None:
            if (
                sent.created_by_user_id != viewer_id
                or sent.source_type != st.X_AUTHOR_THREAD
                or sent.requested_url != request.url
                or sent.source_payload != payload
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Attempt intent changed.")
            return _from_url_out(db, sent, request.id)
        media = source_targets.lock_target(
            db,
            viewer_id=viewer_id,
            source_url=request.url,
            source=source,
            target=request.expected_target,
            kind="web_article",
        )
        spec = url_source_spec(request.url)
        if media is None:
            media = _new_media(db, spec, url=request.url, actor_id=viewer_id)
        prior = sa.latest_attempt(db, media.id, lock=False)
        library_entries.validate_acquisition_destinations(
            db,
            viewer_id=viewer_id,
            expected_removal_revision=int(request.expected_removal_revision),
            library_ids=[],
        )
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, []
        )
        attempt = _url_attempt(
            db, media, spec, id=request.id, actor_id=viewer_id, url=request.url, payload=payload
        )
        if prior is not None and prior.job_id is not None:
            supersede_unclaimed_job(db, job_id=prior.job_id, kind="ingest_media_source")
        mark_extracting(db, media)
        sa.enqueue_attempt(db, attempt, actor_id=viewer_id, request_id=request_id)
        projection.refresh_viewer_contributors(db, [viewer_id])
        record_input_change(db, owners=(f"media:{media.id}",))
        return _from_url_out(db, attempt, request.id)

    return retry_serializable(db, "accept_extension_source", admit)


def read_source_attempt(
    db: Session, *, viewer_id: UUID, source_attempt_id: UUID
) -> SourceAttemptOut:
    """Resolve an accepted source under one read snapshot, including after loser teardown.

    Visibility belongs to the current media, not the attempt's original actor: a
    source admission may legitimately join another actor's active run. Reads neither
    file destinations nor restart work. Settlement follows the current destination's
    latest source attempt: terminal or stopped at its exact dead job. This says
    nothing about usability; explicit repair, retry or refresh can reopen identity work.
    """
    media_id = db.scalar(
        text("SELECT media_id FROM media_source_supersessions WHERE source_attempt_id = :id"),
        {"id": source_attempt_id},
    )
    if media_id is None:
        attempt = db.get(MediaSourceAttempt, source_attempt_id)
        if attempt is None:
            raise NotFoundError(ApiErrorCode.E_IMPORT_NOT_FOUND, "Source import not found.")
        media_id = attempt.media_id
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_IMPORT_NOT_FOUND, "Source import not found.")
    latest = sa.latest_attempt(db, media_id, lock=False)
    assert latest is not None  # every source destination has an admitted attempt
    return SourceAttemptOut(
        import_ref=format_import_ref(MediaImportRef(media_id=media_id)),
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        settled=latest.status not in st.IN_FLIGHT
        or bool(
            db.scalar(
                text(f"SELECT {sa.source_repairable_sql('m')} FROM media m WHERE m.id = :id"),
                {"id": media_id},
            )
        ),
    )


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
    *,
    expected_removal_revision: int | None = None,
    capture_input: XCaptureInput | None = None,
) -> FromUrlOut:
    validate_requested_url(url)
    spec = url_source_spec(url)
    if spec.source_type == st.X_AUTHOR_THREAD:
        assert not payload
        payload = XAuthorThreadPayload(
            capture_input=capture_input, parent_source_attempt_id=None, extension_source=None
        ).model_dump(mode="json")
    if (key := _identity_key(spec)) is not None:
        sa.lock_identity(db, key)
    owned_web = False
    media = None
    if spec.source_type == st.GENERIC_WEB_URL and library_ids is not None:
        # The first generic attempt freezes the original admission URL as provenance.
        assert spec.canonical_source_url is not None
        identity = normalize_url_for_identity(spec.canonical_source_url)
        original_url = (
            select(MediaSourceAttempt.canonical_source_url)
            .where(MediaSourceAttempt.media_id == Media.id)
            .order_by(MediaSourceAttempt.attempt_no)
            .limit(1)
            .scalar_subquery()
        )
        matches = [
            media
            for media, admitted_url in db.execute(
                select(Media, original_url)
                .where(
                    Media.created_by_user_id == actor_id,
                    Media.kind == "web_article",
                    Media.canonical_url.is_(None),
                    Media.requested_url.is_not(None),
                    ~exists().where(MediaTeardownIntent.media_id == Media.id),
                    text(
                        "(SELECT source_type FROM media_source_attempts a WHERE a.media_id=media.id ORDER BY attempt_no LIMIT 1) = 'generic_web_url'"
                    ),
                    text(f"media.id IN ({visible_media_ids_cte_sql()})"),
                )
                .params(viewer_id=actor_id)
            ).tuples()
            if admitted_url is not None and normalize_url_for_identity(admitted_url) == identity
        ]
        if len(matches) > 1:
            raise ConflictError(
                ApiErrorCode.E_SOURCE_TARGET_AMBIGUOUS,
                "several imports use this address. choose the import in imports.",
            )
        if matches:
            media = matches[0]
            owned_web = True
            media_locks.lock_media_rows_in_order(db, [media.id])
            db.refresh(media)
            latest = sa.latest_attempt(db, media.id, lock=False)
            if latest is not None and latest.status in st.IN_FLIGHT:
                raise ConflictError(
                    ApiErrorCode.E_SOURCE_IMPORT_ACTIVE,
                    "this source is already importing. view its import.",
                )
    if media is None:
        media = _reusable_media(db, spec, viewer_id=actor_id)
    if media is None:
        media = _new_media(db, spec, url=url, actor_id=actor_id)
        if library_ids is not None:
            assert expected_removal_revision is not None
            library_entries.validate_acquisition_destinations(
                db,
                viewer_id=actor_id,
                expected_removal_revision=expected_removal_revision,
                library_ids=library_ids,
            )
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, actor_id, media.id, library_ids
            )
        attempt = _url_attempt(db, media, spec, id=id, actor_id=actor_id, url=url, payload=payload)
        sa.enqueue_attempt(db, attempt, actor_id=actor_id, request_id=request_id)
        return _from_url_out(db, attempt, id)
    article_ids = (
        x_article_child_media_ids(db, thread_media_ids=(media.id,))
        if spec.source_type == st.X_AUTHOR_THREAD
        else set()
    )
    media_locks.lock_media_rows_in_order(db, [media.id, *article_ids])
    db.refresh(media)
    latest = sa.latest_attempt(db, media.id, lock=False)
    if spec.source_type == st.X_AUTHOR_THREAD:
        assert latest is not None
        if latest.status in st.IN_FLIGHT:
            raise ConflictError(
                ApiErrorCode.E_SOURCE_IMPORT_ACTIVE,
                "this source is already importing. view its import.",
            )
        if latest.status != st.SUCCEEDED:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "this source needs attention. view its import.",
            )
    if library_ids is not None:
        assert expected_removal_revision is not None
        library_entries.validate_acquisition_destinations(
            db,
            viewer_id=actor_id,
            expected_removal_revision=expected_removal_revision,
            library_ids=library_ids,
        )
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, actor_id, media.id, library_ids
        )
        for child_id in sorted(article_ids):
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, actor_id, child_id, library_ids
            )
        db.refresh(media)
    if spec.source_type == st.YOUTUBE_VIDEO:
        _adopt_video_identity(media, spec)
    if latest is not None and latest.status in st.IN_FLIGHT:
        return _from_url_out(db, latest, id)  # I2: other source families join the run in flight
    if spec.source_type == st.X_AUTHOR_THREAD:
        revision_id = spec.provider_target_ref
        inspection = db.get(XArticleInspection, (media.id, revision_id))
        if inspection is None or (
            inspection.article_id is not None and inspection.article_media_id is None
        ):
            attempt = _url_attempt(
                db, media, spec, id=id, actor_id=actor_id, url=url, payload=payload
            )
            mark_extracting(db, media)
            sa.enqueue_attempt(db, attempt, actor_id=actor_id, request_id=request_id)
            return _from_url_out(db, attempt, id)
    settled = st.FAILED if media.processing_status == ProcessingStatus.failed else st.SUCCEEDED
    if owned_web and latest is not None:
        attempt = sa.create_attempt(
            db,
            id=id,
            media=media,
            actor_id=actor_id,
            source_type=latest.source_type,
            requested_url=latest.requested_url,
            canonical_source_url=latest.canonical_source_url,
            provider=latest.provider,
            provider_target_ref=latest.provider_target_ref,
            payload=latest.source_payload,
            status=settled,
            failure_code=latest.error_code,
            failure_message=latest.error_message,
        )
        return _from_url_out(db, attempt, id)
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
    assert (
        media is not None
    )  # URL-source callers establish their live-media owner before this projection
    return FromUrlOut(
        import_ref=format_import_ref(MediaImportRef(media_id=media.id)),
        media_id=media.id,
        source_attempt_id=attempt.id,
        created=attempt.id == id and attempt.attempt_no == 1,
        processing_status=media.processing_status,
    )


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
    *, db: Session, viewer_id: UUID, url: str, library_ids: list[UUID], retaining_media_id: UUID
) -> EmbeddedSourceAcceptance:
    """Create or reuse the child source of a trusted embed, flush-only: the publisher
    enqueues a ``needs_enqueue`` child in its own transaction (I11).

    The publisher already holds x alias locks before its ordered media locks.
    Context is not filed: the containing publication supplies access and retention.
    Other providers retain their existing filing behavior.
    """
    validate_requested_url(url)
    spec = _embedded_spec(url)
    if spec is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unsupported embedded source provider."
        )
    return _accept_child(
        db, viewer_id, url, library_ids, spec, {}, retaining_media_id=retaining_media_id
    )


def _accept_child(
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    spec: UrlSourceSpec,
    payload: dict[str, object],
    *,
    retaining_media_id: UUID,
) -> EmbeddedSourceAcceptance:
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
            payload=payload,
        )
    else:
        if spec.source_type == st.YOUTUBE_VIDEO:
            _adopt_video_identity(media, spec)
        latest = sa.latest_attempt(db, media.id, lock=False)
        assert latest is not None  # a reusable media was accepted through an attempt
        attempt = latest
    if can_read_media(db, viewer_id, retaining_media_id) and not db.scalar(
        text("SELECT 1 FROM user_media_deletions WHERE user_id=:u AND media_id=:m"),
        {"u": viewer_id, "m": media.id},
    ):
        destinations = libraries.writable_destinations(db, viewer_id, library_ids)
        libraries.lock_library_rows_in_order(
            db, [libraries.default_library_id(db, viewer_id), *destinations]
        )
        library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
        for library_id in libraries.writable_destinations(db, viewer_id, destinations):
            library_entries.ensure_entry(db, library_id, library_entries.media_target(media.id))
    return EmbeddedSourceAcceptance(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        provider_target_ref=attempt.provider_target_ref,
        source_attempt_status=attempt.status,
        processing_status=media.processing_status.value,
        needs_enqueue=created,
    )


def record_x_article_inspection(
    db: Session,
    *,
    attempt: MediaSourceAttempt,
    carrier_post_id: str,
    article_id: str | None,
    request_id: str | None,
) -> None:
    """Commit discovery, child admission, destinations and enqueue under the root fence.

    Retry rule: native identity reuses a child's latest attempt, including failures;
    repeated discovery never retries that child. Only explicit recovery does.
    """
    viewer_id = attempt.created_by_user_id
    assert viewer_id is not None
    child_id = None
    if article_id is not None:
        url = canonical_x_article_url(article_id)
        libraries_to_file = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=attempt.media_id
        )
        accepted = _accept_child(
            db,
            viewer_id,
            canonical_x_post_url(carrier_post_id),
            libraries_to_file,
            UrlSourceSpec(
                source_type=st.X_ARTICLE,
                kind=MediaKind.web_article.value,
                title="X article",
                canonical_source_url=url,
                provider="x",
                provider_id=x_article_provider_id(article_id),
                provider_target_ref=carrier_post_id,
            ),
            {"article_id": article_id},
            retaining_media_id=attempt.media_id,
        )
        child_id = accepted.media_id
        if accepted.needs_enqueue:
            child_attempt = db.get(MediaSourceAttempt, accepted.source_attempt_id)
            assert child_attempt is not None
            sa.enqueue_attempt(db, child_attempt, actor_id=viewer_id, request_id=request_id)
    row = db.get(XArticleInspection, (attempt.media_id, carrier_post_id))
    if row is None:
        db.add(
            XArticleInspection(
                thread_media_id=attempt.media_id,
                carrier_post_id=carrier_post_id,
                article_id=article_id,
                article_media_id=child_id,
            )
        )
    else:
        row.article_id, row.article_media_id = article_id, child_id
    db.flush()


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


# --- recovery ------------------------------------------------------------------


def _owned_media(db: Session, viewer_id: UUID, media_id: UUID) -> Media:
    """The viewer's own media, key-share locked: invisible is 404, another's is 403."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_locks.lock_media_rows_in_order(db, [media_id])
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
    return media


def require_unpublished_document(db: Session, media: Media) -> None:
    """I9: an epub's reader identities are never replaced."""
    if media.kind != MediaKind.epub.value:
        return
    exposed = db.scalar(
        text("""
            SELECT EXISTS (SELECT 1 FROM reader_publications WHERE media_id = :id)
                OR EXISTS (SELECT 1 FROM fragments WHERE media_id = :id)
                OR EXISTS (SELECT 1 FROM reader_media_state
                           WHERE media_id = :id AND cursor IS NOT NULL)
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
    from nexus.services.media_parts import require_unpinned_source

    require_unpinned_source(db, media_id=media.id)
    if media.kind == MediaKind.text_part.value:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "pieces have no source attempt")
    require_unpublished_document(db, media)
    payload = dict(latest.source_payload or {})
    if latest.source_type == st.X_AUTHOR_THREAD:
        payload["parent_source_attempt_id"] = None
        payload["extension_source"] = None
    else:
        payload.pop("parent_source_attempt_id", None)  # a successor runs on its own
    if latest.source_type in (
        st.BROWSER_ARTICLE_CAPTURE,
        st.BROWSER_PDF_CAPTURE,
        st.BROWSER_EPUB_CAPTURE,
    ):
        payload["base_reader_generation"] = lock_publication_generation(db, media_id=media.id)
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
            return _admission(landed)
        if latest is None or latest.id != expected_attempt_id:
            raise _stale(latest, "The inspected source attempt is no longer current.")
        offer = sa.source_recovery(sa.recovery_facts(db, media, latest, viewer_id=viewer_id))
        if not isinstance(offer, RetrySourceOffer):
            reason = _RESTRICTED[offer] if isinstance(offer, str) else "Nothing to retry."
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, reason)
        successor = _admit_successor(db, media, latest, actor_id=viewer_id, request_id=request_id)
        sa.record_event(
            db, latest, SourceRecoveryAccepted(source_attempt_id=latest.id, recovery="RetrySource")
        )
        result = _admission(successor)
        record_input_change(db, owners=(f"media:{media.id}",))
        return result

    return retry_serializable(db, "retry_source", admit)


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
            SourceRecoveryAccepted(source_attempt_id=latest.id, recovery="ReprocessSource"),
        )
        result = _admission(successor)
        record_input_change(db, owners=(f"media:{media.id}",))
        return result

    return retry_serializable(db, "reprocess_failed_stored_epub", admit)


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
            return _admission(landed)
        if latest is None or latest.id != expected_attempt_id:
            raise _stale(latest, "The inspected source attempt is no longer current.")
        facts = sa.recovery_facts(db, media, latest, viewer_id=viewer_id)
        if latest.status in st.IN_FLIGHT and latest.job_id is not None and not facts.repairable:
            return _admission(latest)
        if not sa.source_refreshable(facts):
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "Nothing to refresh.")
        if media.kind == MediaKind.web_article.value and media.provider == "x":
            # the readable copy is retained while the refresh runs, and if it fails
            ensure_reader_publication(db, media_id=media.id)
        successor = _admit_successor(db, media, latest, actor_id=viewer_id, request_id=request_id)
        result = _admission(successor)
        record_input_change(db, owners=(f"media:{media.id}",))
        return result

    return retry_serializable(db, "refresh_source", admit)


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
                return answer
            raise ConflictError(ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Nothing to repair.")
        require_unpublished_document(db, media)
        job = get_job(db, expected_job_id, lock=True)
        assert job is not None
        if job.status == "held":
            resume_held_job(db, job_id=job.id)
        else:
            requeue_dead_job(db, job_id=job.id)
        sa.record_event(
            db, latest, SourceRecoveryAccepted(source_attempt_id=latest.id, recovery="RepairSource")
        )
        return answer

    return retry_serializable(db, "repair_source", admit)


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


def _capture_receipt_id(attempt: MediaSourceAttempt) -> UUID | None:
    if attempt.source_type == st.X_AUTHOR_THREAD:
        source = XAuthorThreadPayload.model_validate_json(json.dumps(attempt.source_payload))
        return source.capture_input.capture_id if source.capture_input is not None else None
    if (
        attempt.source_type == st.X_POST
        and attempt.status == st.SUCCEEDED
        and attempt.job_id is None
        and attempt.finished_at is not None
        and set(attempt.source_payload) == {"capture_id"}
    ):
        capture_id = attempt.source_payload["capture_id"]
        assert isinstance(capture_id, str)
        return UUID(capture_id)
    return None


def accept_x_capture(
    *,
    db: Session,
    viewer_id: UUID,
    id: UUID,
    capture_id: UUID,
    expected_removal_revision: int,
    destinations: list[UUID],
    request_id: str | None,
) -> FromXCaptureOut:
    """Admit thread acquisition with frozen evidence; replay never files or restarts work."""
    from nexus.services.x_ingest import lock_x_capture_revisions
    from nexus.services.x_source import (
        readable_x_capture_ids_sql,
        require_readable_x_capture,
        x_capture_read_manifest,
    )

    def admit() -> FromXCaptureOut:
        users.lock_viewer(db, viewer_id)
        sa.lock_identity(db, f"attempt:{id}")
        sent = db.get(MediaSourceAttempt, id, with_for_update={"read": True})
        if sent is not None:
            if sent.created_by_user_id != viewer_id or _capture_receipt_id(sent) != capture_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "attempt id is taken")
            return FromXCaptureOut(source_attempt_id=sent.id, media_id=sent.media_id)
        if sa.superseding_media_id(db, source_attempt_id=id) is not None:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "attempt id is taken")
        capture = require_readable_x_capture(db, viewer_id=viewer_id, capture_id=capture_id)
        lock_x_capture_revisions(db, revisions={capture.source_revision_id})
        authorized = {capture_id}
        if capture.payload["kind"] == "complete_post":
            authorized = set(
                db.scalars(text(readable_x_capture_ids_sql()), {"viewer_id": viewer_id})
            ) & x_capture_read_manifest(db, capture_ids=[capture_id])
        result = _accept_url(
            db,
            viewer_id,
            id,
            canonical_x_post_url(capture.source_revision_id),
            destinations,
            {},
            request_id,
            expected_removal_revision=expected_removal_revision,
            capture_input=XCaptureInput(
                capture_id=capture_id, authorized_capture_ids=tuple(sorted(authorized))
            ),
        )
        shared_viewers = db.scalars(
            text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
            {"ids": destinations},
        ).all()
        projection.refresh_viewer_contributors(db, [viewer_id, *shared_viewers])
        record_input_change(db, owners=(f"media:{result.media_id}",))
        return FromXCaptureOut(source_attempt_id=result.source_attempt_id, media_id=result.media_id)

    return retry_serializable(db, "accept_x_capture", admit, retries=6)
