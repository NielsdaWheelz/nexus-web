"""The ``ingest_media_source`` job: run one accepted attempt to its terminal state.

Runs in the bounded background child. Marks the attempt running and keeps a detached
snapshot of it, acquires the source through ``source_adapters`` with no transaction
open, then settles: success mirrors the media's outcome onto the attempt and requests
the reindex and metadata enrichment; a typed refusal is a terminal failure, published at
once (I3); any other error re-raises to the queue (3 tries, then dead and the repair
offer). A run that finds its source is another media's moves the accept's destinations
to the winner and claims the loser for teardown.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import func, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.queue import JobExecutionContext, JobResult
from nexus.logging import get_logger
from nexus.schemas.import_history import (
    SourceExecutionStarted,
    SourceFailed,
    SourceSucceeded,
    assume_safe_failure_code,
)
from nexus.services import libraries, library_entries
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.media_deletion import (
    delete_document_storage_objects,
    delete_duplicate_document_media,
)
from nexus.services.media_processing_state import mark_ready_for_reading, mark_stage_warning
from nexus.services.metadata_operations import enqueue_metadata_enrichment
from nexus.services.search import projection
from nexus.services.source_adapters import (
    PreparedFileSource,
    PreparedNativeArticle,
    acquire,
    publish_prepared_file,
    publish_prepared_native_article,
)
from nexus.services.source_outcome import SourceRunOutcome, source_outcome_to_job_result
from nexus.services.source_publication import (
    SourceAttemptFailure,
    SourcePublicationFence,
    SourcePublicationSuperseded,
    publish_source_attempt_failure,
    reset_source_progress,
    run_source_publication_phase,
)
from nexus.services.suggestion_changes import record_input_change
from nexus.services.web_article import article_publication_media_ids
from nexus.services.x_ingest import (
    PreparedXSource,
    lock_x_publication_identities,
    publish_prepared_x_source,
    x_publication_media_ids,
)
from nexus.storage.client import StorageError

logger = get_logger(__name__)

# Only these settle the attempt; any other error is the queue's to retry. Each is a typed
# refusal that no retry changes: a missing stored source never brings its bytes back, and a
# publication refused by its store (E_RESOURCE_CONFLICT: a referenced note would vanish, or
# notes lost their identities) refuses again on the same source.
_TERMINAL_CODES = frozenset(
    """E_SOURCE_ACCESS_DENIED E_SOURCE_GONE E_SOURCE_INTEGRITY E_SOURCE_TOO_LARGE
    E_SOURCE_NOT_READABLE E_SANITIZATION_FAILED E_SSRF_BLOCKED E_INVALID_FILE_TYPE
    E_INVALID_CONTENT_TYPE E_FILE_TOO_LARGE E_CAPTURE_TOO_LARGE E_ARCHIVE_UNSAFE
    E_INVALID_REQUEST E_INVALID_KIND E_PDF_PASSWORD_REQUIRED E_TRANSCRIPT_UNAVAILABLE
    E_X_POST_UNAVAILABLE E_X_PROVIDER_CREDITS_DEPLETED E_X_PROVIDER_AUTH_REJECTED
    E_REPAIR_NOT_ALLOWED E_RESOURCE_CONFLICT E_STORAGE_MISSING E_SOURCE_POSITION_UNMAPPABLE
    E_X_IDENTITY_CONFLICT E_X_ARTICLE_BODY_UNAVAILABLE E_X_ARTICLE_IDENTITY_CHANGED""".split()
)
_INDEXED_KINDS = frozenset({MediaKind.web_article.value, MediaKind.epub.value, MediaKind.pdf.value})


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    attempt_id = UUID(payload["attempt_id"])
    try:
        result = _run(
            get_session_factory(),
            media_id=UUID(payload["media_id"]),
            actor_id=UUID(payload["actor_user_id"]),
            request_id=payload.get("request_id"),
            fence=SourcePublicationFence.from_context(attempt_id=attempt_id, context=context),
        )
    except SourcePublicationSuperseded:
        result = {"status": "superseded"}
    logger.info(
        "ingest_media_source_completed",
        media_id=payload["media_id"],
        attempt_id=str(attempt_id),
        result=result,
        request_id=payload.get("request_id"),
    )
    return result


def _run(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    actor_id: UUID,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> dict[str, object]:
    def mark_running(db: Session, attempt: MediaSourceAttempt) -> MediaSourceAttempt:
        attempt.status = st.RUNNING
        attempt.updated_at = func.now()
        reset_source_progress(attempt)
        sa.record_event(db, attempt, SourceExecutionStarted(source_attempt_id=attempt.id))
        db.flush()
        db.expunge(attempt)  # the adapters get a detached snapshot: no transaction spans I/O
        return attempt

    attempt = run_source_publication_phase(
        session_factory=session_factory,
        label="mark_source_attempt_running",
        fence=fence,
        media_ids=(media_id,),
        mutate=mark_running,
    )
    try:
        acquired = acquire(
            session_factory,
            media_id=media_id,
            attempt=attempt,
            request_id=request_id,
            fence=fence,
        )
        if isinstance(acquired, PreparedFileSource):
            outcome, cleanup = _publish_file(session_factory, media_id, acquired, fence, request_id)
            delete_document_storage_objects(cleanup)
            return source_outcome_to_job_result(outcome)
        if isinstance(acquired, PreparedXSource):
            outcome = _publish_x(session_factory, media_id, acquired, fence, actor_id, request_id)
            return source_outcome_to_job_result(outcome)
        if isinstance(acquired, PreparedNativeArticle):
            outcome = _publish_native_article(
                session_factory, media_id, acquired, fence, request_id
            )
            return source_outcome_to_job_result(outcome)
        _publish_outcome(session_factory, media_id, acquired, fence, request_id)
        return source_outcome_to_job_result(acquired)
    except SourcePublicationSuperseded:
        raise
    except Exception as exc:
        code, message = _error_fields(exc)
        if code not in _TERMINAL_CODES:
            raise
        logger.warning("source_attempt_failed", attempt_id=str(fence.attempt_id), error_code=code)
        run_source_publication_phase(
            session_factory=session_factory,
            label="publish_source_attempt_failure",
            fence=fence,
            media_ids=(media_id,),
            mutate=lambda db, locked: _fail(db, locked, code, message),
            discover=_embed_owners({media_id}),
        )
        return {"status": "failed", "error_code": code, "error_message": message}


def _publish_file(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    prepared: PreparedFileSource,
    fence: SourcePublicationFence,
    request_id: str | None,
) -> tuple[SourceRunOutcome, list[str]]:
    def publish(db: Session, attempt: MediaSourceAttempt) -> tuple[SourceRunOutcome, list[str]]:
        outcome, cleanup = publish_prepared_file(db, media_id=media_id, prepared=prepared)
        _settle(db, attempt, media_id, outcome, request_id)
        record_input_change(db, owners=(f"media:{media_id}",))
        return outcome, cleanup

    return run_source_publication_phase(
        session_factory=session_factory,
        label="publish_file_source_attempt",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=_embed_owners({media_id}),
    )


def _publish_native_article(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    prepared: PreparedNativeArticle,
    fence: SourcePublicationFence,
    request_id: str | None,
) -> SourceRunOutcome:
    children: set[UUID] = set()

    def discover(db: Session) -> set[UUID]:
        children.clear()
        children.update(
            article_publication_media_ids(db, media_id=media_id, prepared=prepared.fragment)
        )
        return children | set(_embed_owners({media_id})(db))

    def publish(db: Session, attempt: MediaSourceAttempt) -> SourceRunOutcome:
        outcome = publish_prepared_native_article(
            db,
            media_id=media_id,
            attempt=attempt,
            prepared=prepared,
            locked_target_ids=frozenset(children),
            request_id=request_id,
        )
        _settle(db, attempt, media_id, outcome, request_id)
        record_input_change(db, owners=(f"media:{ident}" for ident in {media_id, *children}))
        return outcome

    return run_source_publication_phase(
        session_factory=session_factory,
        label="publish_native_article",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=discover,
    )


def _publish_x(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    prepared: PreparedXSource,
    fence: SourcePublicationFence,
    actor_id: UUID,
    request_id: str | None,
) -> SourceRunOutcome:
    """Publish a prepared X source and settle its attempt in one fenced transaction; a
    source another media already holds supersedes this one onto it."""

    def publish(db: Session, attempt: MediaSourceAttempt) -> SourceRunOutcome:
        outcome = publish_prepared_x_source(
            db,
            media_id=media_id,
            source_attempt_id=attempt.id,
            viewer_id=actor_id,
            request_id=request_id,
            prepared=prepared,
        )
        winner_id = outcome.superseded_by_media_id or media_id
        if winner_id != media_id:
            _supersede(db, attempt, loser_id=media_id, winner_id=winner_id)
        _settle(db, attempt, winner_id, outcome, request_id)
        record_input_change(
            db,
            owners=(
                f"media:{ident}"
                for ident in {media_id, winner_id, *outcome.additional_reindex_media_ids}
            ),
        )
        return outcome

    return run_source_publication_phase(
        session_factory=session_factory,
        label="publish_x_source_attempt",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=lambda db: x_publication_media_ids(db, media_id=media_id, prepared=prepared),
        lock_identities=lambda db: lock_x_publication_identities(db, prepared=prepared),
    )


def _publish_outcome(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    outcome: SourceRunOutcome,
    fence: SourcePublicationFence,
    request_id: str | None,
) -> None:
    """Settle an outcome the url family already published; the queue payload and the
    attempt stay anchored to the accepted media, and every winner effect commits with
    the loser's teardown claim."""
    winner_id = outcome.superseded_by_media_id or media_id
    media_ids = {
        media_id,
        winner_id,
        *outcome.additional_reindex_media_ids,
        *(observed for observed, _observation, _source in outcome.observations),
    }

    def publish(db: Session, attempt: MediaSourceAttempt) -> None:
        if winner_id != media_id:
            _supersede(db, attempt, loser_id=media_id, winner_id=winner_id)
        _settle(db, attempt, winner_id, outcome, request_id)
        record_input_change(db, owners=(f"media:{ident}" for ident in media_ids))

    run_source_publication_phase(
        session_factory=session_factory,
        label="publish_source_attempt",
        fence=fence,
        media_ids=tuple(sorted(media_ids)),
        mutate=publish,
        discover=_embed_owners(media_ids),
    )


def _settle(
    db: Session,
    attempt: MediaSourceAttempt,
    media_id: UUID,
    outcome: SourceRunOutcome,
    request_id: str | None,
) -> None:
    """Mirror the terminal media's published outcome onto the attempt."""
    media = db.get(Media, media_id)
    if media is None:
        raise SourcePublicationSuperseded("terminal_media_disappeared")
    attempt.finished_at = attempt.updated_at = func.now()
    if media.processing_status == ProcessingStatus.failed:
        # the family published the media's failure itself; the attempt mirrors it (I3)
        attempt.status = st.FAILED
        attempt.error_code = media.last_error_code
        attempt.error_message = media.last_error_message
        sa.record_event(
            db,
            attempt,
            SourceFailed(
                source_attempt_id=attempt.id,
                origin="Domain",
                terminal=True,
                progress=st.source_failure_progress(
                    processing_stage=attempt.processing_stage,
                    progress_completed=attempt.progress_completed,
                    progress_total=attempt.progress_total,
                    progress_unit=attempt.progress_unit,
                ),
            ),
            failure_code=assume_safe_failure_code(
                media.last_error_code or ApiErrorCode.E_INGEST_FAILED.value
            ),
        )
    else:
        for observed_id, observation, source in outcome.observations:
            apply_observed_role_slices_in_current_transaction(
                db, target=MediaTarget(observed_id), observation=observation, source=source
            )
        # a success leaves the media ready; a refresh kept a retained copy ready, and its new
        # publication clears the warning that copy carried
        if media.processing_status in (
            ProcessingStatus.extracting,
            ProcessingStatus.ready_for_reading,
        ):
            mark_ready_for_reading(db, media)
        attempt.status = st.SUCCEEDED
        attempt.error_code = attempt.error_message = None
        sa.record_event(db, attempt, SourceSucceeded(source_attempt_id=attempt.id))
        if outcome.pdf_has_text is False:
            mark_stage_warning(
                db,
                media,
                error_code="E_PDF_TEXT_UNAVAILABLE",
                error_message="PDF text is unavailable; OCR is required.",
            )
        indexed_ids = list(outcome.additional_reindex_media_ids)
        if outcome.reindex_media and (
            media.kind in _INDEXED_KINDS or outcome.transcript_request_reason is not None
        ):
            indexed_ids.insert(0, media_id)
        if indexed_ids:
            from nexus.services.content_indexing import request_media_content_reindex

            for indexed_id in indexed_ids:
                request_media_content_reindex(db, media_id=indexed_id, reason="source_success")
        if attempt.created_by_user_id is not None and outcome.metadata_enrichment:
            enqueue_metadata_enrichment(
                db,
                media_id=media_id,
                requester_user_id=attempt.created_by_user_id,
                request_id=request_id,
            )
        for thread_id, creator_id in db.execute(
            text("""
                SELECT m.id, m.created_by_user_id FROM x_thread_sources thread
                JOIN media m ON m.id = thread.media_id
                WHERE m.id != :winner AND m.created_by_user_id IS NOT NULL
                  AND m.id IN (SELECT thread_media_id FROM x_thread_posts
                               WHERE post_media_id = ANY(:changed))
                ORDER BY m.id
            """),
            {"winner": media_id, "changed": indexed_ids},
        ):
            enqueue_metadata_enrichment(
                db, media_id=thread_id, requester_user_id=creator_id, request_id=request_id
            )
    for synced_id in (media_id, *outcome.additional_reindex_media_ids):
        _sync_embed_targets(db, synced_id)
    from nexus.services.media_intelligence_lifecycle import ensure_media_unit_in_tx

    for thread_id in db.scalars(
        text("""
            SELECT media_id FROM x_thread_sources
            WHERE media_id = ANY(:ids) OR media_id IN (
                SELECT thread_media_id FROM x_thread_posts WHERE post_media_id = ANY(:ids))
            ORDER BY media_id
        """),
        {"ids": [media_id, *outcome.additional_reindex_media_ids]},
    ):
        # Index requests above have already marked changed children pending. A
        # thread build is admitted only once every current primary index is ready.
        ensure_media_unit_in_tx(db, media_id=thread_id)
    db.flush()
    projection.refresh_viewer_contributors(db, list(db.scalars(text("SELECT id FROM users"))))


def _fail(db: Session, attempt: MediaSourceAttempt, code: str, message: str) -> None:
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=attempt.media_id,
            attempt_id=attempt.id,
            error_code=code,
            error_message=message,
            now=datetime.now(UTC),
        ),
    )
    _sync_embed_targets(db, attempt.media_id)
    db.flush()
    projection.refresh_viewer_contributors(db, list(db.scalars(text("SELECT id FROM users"))))
    record_input_change(db, owners=(f"media:{attempt.media_id}",))


def _supersede(
    db: Session, attempt: MediaSourceAttempt, *, loser_id: UUID, winner_id: UUID
) -> None:
    """The accept's destinations the importer still admins move to the winner (one whose
    right lapsed is skipped, not refused: no retry restores it), and the loser is claimed for
    teardown. Media rows lock ascending, then libraries: two thread ingests that find
    each other depend on that order."""
    library_entries.lock_media_rows_in_order(db, [loser_id, winner_id])
    if (owner := attempt.created_by_user_id) is not None:
        chosen = cast(list[str], (attempt.source_payload or {}).get("library_ids", []))
        destinations = libraries.writable_destinations(db, owner, [UUID(i) for i in chosen])
        libraries.lock_library_rows_in_order(
            db,
            [
                *library_entries.library_ids_for_media(db, loser_id),
                libraries.default_library_id(db, owner),
                *destinations,
            ],
        )
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, owner, winner_id, destinations
        )
    delete_duplicate_document_media(db, loser_media_id=loser_id, winner_media_id=winner_id)


def _embed_owners(media_ids: set[UUID]) -> Callable[[Session], list[UUID]]:
    """Every media that embeds one of these as a target is locked with them."""

    def discover(db: Session) -> list[UUID]:
        return list(
            db.scalars(
                text(
                    "SELECT DISTINCT media_id FROM document_embeds"
                    " WHERE target_media_id = ANY(:ids)"
                ),
                {"ids": sorted(media_ids)},
            )
        )

    return discover


def _sync_embed_targets(db: Session, media_id: UUID) -> None:
    from nexus.services.document_embeds import sync_document_embed_targets_for_media

    sync_document_embed_targets_for_media(db, target_media_id=media_id)


def _error_fields(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, ApiError):
        return exc.code.value, exc.message
    if isinstance(exc, StorageError):
        return exc.code, exc.message
    return ApiErrorCode.E_INGEST_FAILED.value, str(exc)
