"""Acquire exact provider evidence outside transactions; fence the published slot."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import DocumentEmbed, Media, XPostCapture
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    RescheduleRequested,
    enqueue_job,
    get_job,
    lock_running_job_claim,
)
from nexus.schemas.x_captures import QuoteRetrieval
from nexus.schemas.x_source import XPriorSource
from nexus.services import library_entries, x_client
from nexus.services import source_attempts as sa
from nexus.services.reader_publication import advance_reader_publications
from nexus.services.x_capture_job_hooks import retrieval
from nexus.services.x_ingest import (
    capture_manifest,
    lock_x_capture_revisions,
    lock_x_publication_identities,
    prepare_x_source,
    publish_acquired_captures,
    x_publication_media_ids,
)
from nexus.services.x_source import admit_x_captures_for_accounts, readable_x_capture_ids_sql


def run_job(*, payload: dict[str, object], context: JobExecutionContext) -> JobResult:
    media_id, occurrence_id, parent_attempt_id = (
        UUID(str(payload[key])) for key in ("media_id", "occurrence_id", "parent_source_attempt_id")
    )
    revision = str(payload["requested_revision_id"])
    factory = get_session_factory()
    with factory() as db:
        row = db.get(DocumentEmbed, occurrence_id)
        if row is None or row.capture_job_id != context.job_id:
            return {"status": "superseded"}
        # Reuse is bounded by this parent's existing audience, never a global url lookup.
        parent = db.get(Media, media_id)
        actor_id = parent.created_by_user_id if parent is not None else None
        existing = None
        if actor_id is not None:
            readable = set(db.scalars(text(readable_x_capture_ids_sql()), {"viewer_id": actor_id}))
            existing = db.scalar(
                select(XPostCapture)
                .where(
                    XPostCapture.id.in_(readable),
                    XPostCapture.source_revision_id == revision,
                    XPostCapture.payload["kind"].astext == "complete_post",
                )
                .order_by(XPostCapture.id)
                .limit(1)
            )
        existing_id = existing.id if existing is not None else None
    prepared = (
        None
        if existing_id is not None
        else prepare_x_source(
            acquired=x_client.fetch_x_post_capture(requested_revision_id=revision),
            prior=XPriorSource(),
        )
    )
    with factory() as db:

        def publish() -> JobResult:
            if prepared is not None:
                lock_x_publication_identities(db, prepared=prepared)
            else:
                lock_x_capture_revisions(db, revisions={revision})
            affected_media = (
                x_publication_media_ids(db, media_id=media_id, prepared=prepared)
                if prepared is not None
                else [media_id]
            )
            library_entries.lock_media_rows_in_order(db, affected_media)
            row = db.scalar(
                select(DocumentEmbed).where(DocumentEmbed.id == occurrence_id).with_for_update()
            )
            if (
                row is None
                or row.media_id != media_id
                or row.source_attempt_id != parent_attempt_id
                or row.capture_job_id != context.job_id
                or row.provider_target_ref != revision
            ):
                return {"status": "superseded"}
            if lock_running_job_claim(db, context=context) is None:
                return {"status": "superseded"}
            if row.target_x_post_capture_id is not None:
                current = db.get(XPostCapture, row.target_x_post_capture_id)
                if current is not None and current.payload["kind"] == "complete_post":
                    return {"capture_id": str(current.id)}
            reuse_manifest: list[UUID] = []
            if prepared is None:
                readable_now = (
                    set(db.scalars(text(readable_x_capture_ids_sql()), {"viewer_id": actor_id}))
                    if actor_id is not None
                    else set()
                )
                if existing_id not in readable_now:
                    return RescheduleRequested(at=datetime.now(UTC))
                assert existing_id is not None
                reuse_manifest = sorted(
                    readable_now & capture_manifest(db, capture_ids=[existing_id])
                )
            from nexus.services.consumption.reader_cursor import (
                capture_x_cursor_remap,
                remap_x_cursors,
            )

            cursor_plan = capture_x_cursor_remap(db, media_ids=[media_id])
            capture = (
                publish_acquired_captures(db, prepared=prepared)[revision]
                if prepared is not None
                else db.get(XPostCapture, existing_id)
            )
            assert capture is not None and capture.source_revision_id == revision
            row.target_x_post_capture_id, row.target_media_id = capture.id, None
            row.resolution_status, row.error_code, row.error_message = "resolved", None, None
            db.flush()
            from nexus.services.resource_grants import (
                extend_public_media_capture_manifests,
                media_audience_account_ids,
            )

            accounts = media_audience_account_ids(db, media_ids=[media_id])
            authorized_manifest = (
                sorted(capture_manifest(db, capture_ids=[capture.id]))
                if prepared is not None
                else reuse_manifest
            )
            admit_x_captures_for_accounts(db, account_ids=accounts, capture_ids=authorized_manifest)
            extend_public_media_capture_manifests(
                db, media_id=media_id, capture_ids=authorized_manifest
            )
            remap_x_cursors(db, snapshots=cursor_plan)
            advance_reader_publications(db, media_ids=[media_id])
            return {"capture_id": str(capture.id)}

        return retry_serializable(db, "publish_x_quote", publish)


def retry_quote(
    db: Session, *, viewer_id: UUID, media_id: UUID, occurrence_id: UUID, expected_job_id: UUID
) -> QuoteRetrieval:
    def retry() -> QuoteRetrieval:
        library_entries.lock_media_rows_in_order(db, [media_id])
        parent = db.get(Media, media_id)
        if (
            parent is None
            or parent.created_by_user_id != viewer_id
            or not can_read_media(db, viewer_id, media_id)
        ):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
        row = db.scalar(
            select(DocumentEmbed)
            .where(
                DocumentEmbed.id == occurrence_id,
                DocumentEmbed.media_id == media_id,
                DocumentEmbed.provider == "x",
                DocumentEmbed.embed_kind == "post",
            )
            .with_for_update()
        )
        successor_id = sa.successor_id(expected_job_id)
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "quoted post not found")
        if row.capture_job_id == successor_id:
            answer = retrieval(db, row.capture_job_id)
            assert answer is not None
            return answer
        if row.capture_job_id != expected_job_id:
            raise ConflictError(ApiErrorCode.E_RETRY_INVALID_STATE, "quoted post changed")
        job = get_job(db, expected_job_id, lock=True)
        if job is None or job.status != "dead":
            raise ConflictError(
                ApiErrorCode.E_RETRY_INVALID_STATE, "quoted post is not awaiting retry"
            )
        if row.target_x_post_capture_id is not None:
            capture = db.get(XPostCapture, row.target_x_post_capture_id)
            if capture is not None and capture.payload["kind"] == "complete_post":
                raise ConflictError(
                    ApiErrorCode.E_RETRY_INVALID_STATE, "full post is already captured"
                )
        row.capture_job_id = enqueue_job(
            db, id=successor_id, kind="capture_x_quote", payload=job.payload
        ).id
        db.execute(text("SELECT pg_notify('media_events', :id)"), {"id": str(media_id)})
        answer = retrieval(db, row.capture_job_id)
        assert answer is not None
        return answer

    return retry_serializable(db, "retry_x_quote", retry)
