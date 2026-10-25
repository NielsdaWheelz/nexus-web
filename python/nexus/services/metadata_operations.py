"""Metadata operations: admission, the projection of kept jobs, and per-viewer reviews.

An operation is one ``enrich_metadata`` job, kept forever (I10); its typed outcome is the
job's result, and a view projects the jobs: the latest and the oldest unfinished by
``(created_at, id)``. Admission is the creator's, for an eligible media with nothing
unfinished, from the latest job the viewer saw (I8). A request from an older view answers
the latest job: the work it asked for, research after what the viewer saw, exists (a
resend after a lost answer lands here). The media row lock serializes admission with
automatic enqueues; job rows are never locked.

Every job freezes its purpose: an X post/thread's title, from the source attempt whose capture
it names, or other eligible media's bibliography. Native article metadata stays authored;
admission and queued publication reject generation for those resources.
A request answers only a run of the media's own
purpose, so a bibliography run from before x articles took titles never answers a title
request (a conflict: the refreshed view expects it, and admits).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import LLMCall
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobRow, enqueue_job
from nexus.schemas.metadata_enrichment import (
    BibliographyMetadataJobPayload,
    MetadataBibliographyCompletedOutcome,
    MetadataCompletedOperation,
    MetadataEnrichmentAccepted,
    MetadataEnrichmentView,
    MetadataFailedOperation,
    MetadataNoFindingsOperation,
    MetadataOperationOut,
    MetadataPurpose,
    MetadataQueuedOperation,
    MetadataRecoveringOperation,
    MetadataRetry,
    MetadataRetryAllowed,
    MetadataRetryBlocked,
    MetadataRunningOperation,
    MetadataSelection,
    MetadataTitleCompletedOutcome,
    MetadataWaitingOperation,
    TitleMetadataJobPayload,
)
from nexus.services.generation.ledger import latest_job_generations
from nexus.services.x_identity import native_x_article_id
from nexus.services.x_source import x_source_attempt_ids

_BLOCKED_COPY = {
    "not_creator": "only the creator can research metadata",
    "not_eligible": "metadata research is unavailable for this media state",
    "active": "metadata research is already in progress",
    "source_context_missing": "refresh source to generate a title",
}


def metadata_purpose(
    *, provider: str | None, provider_id: str | None, kind: str
) -> MetadataPurpose:
    """X posts/threads take a title; native articles are ineligible for generation."""
    return (
        "title"
        if provider == "x"
        and kind == "web_article"
        and native_x_article_id(kind=kind, provider=provider, provider_id=provider_id) is None
        else "bibliography"
    )


def is_metadata_enrichment_eligible(
    *, kind: str, provider: str | None, provider_id: str | None, processing_status: str
) -> bool:
    """Readable, or an episode or video waiting on a transcript research does not need."""
    return native_x_article_id(kind=kind, provider=provider, provider_id=provider_id) is None and (
        processing_status == "ready_for_reading"
        or (processing_status == "pending" and kind in ("video", "podcast_episode"))
    )


def metadata_operations_sql() -> str:
    """Per-job facts for authorized composition (views, Imports, history); binds ``viewer_id``.

    A job its run settled carries its outcome; a dead job without one (its worker died, or
    its handler raised) reads ``worker_interrupted``, ``model_unavailable`` or
    ``execution_failed`` from the queue's code.
    """
    return """
        SELECT projected.*,
            status IN ('pending', 'running', 'failed') AS is_unfinished,
            effective_status = 'failed'
                OR (effective_status = 'no_findings' AND reviewed_at IS NULL) AS needs_attention,
            CASE WHEN effective_status = 'failed' THEN
                CASE WHEN result ? 'completed_at' THEN result->>'reason'
                     WHEN error_code = 'E_WORKER_INTERRUPTED' THEN 'worker_interrupted'
                     WHEN error_code = 'E_GENERATION_RUNTIME_UNAVAILABLE' THEN 'model_unavailable'
                     ELSE 'execution_failed' END
            END AS failure_code,
            COALESCE(completed_at, created_at) AS occurred_at,
            GREATEST(updated_at, reviewed_at) AS lifecycle_updated_at
        FROM (
            SELECT job.*, job.id AS job_id, (job.payload->>'media_id')::uuid AS media_id,
                review.reviewed_at,
                CASE
                    WHEN job.status IN ('succeeded', 'dead') AND job.result ? 'completed_at'
                        THEN job.result->>'status'
                    WHEN job.status = 'running' AND job.lease_expires_at > now() THEN 'running'
                    WHEN job.status = 'dead' THEN 'failed'
                    WHEN job.status = 'failed'
                      OR (job.status = 'pending' AND job.available_at > now()) THEN 'waiting'
                    WHEN job.status = 'running' THEN 'recovering'
                    ELSE 'queued'
                END AS effective_status,
                CASE WHEN job.status IN ('succeeded', 'dead') THEN
                    COALESCE((job.result->>'completed_at')::timestamptz, job.finished_at)
                END AS completed_at
            FROM background_jobs job
            LEFT JOIN metadata_result_reviews review
              ON review.job_id = job.id AND review.viewer_id = :viewer_id
            WHERE job.kind = 'enrich_metadata'
        ) projected
    """


def _operations(db: Session, rows: Sequence[RowMapping]) -> dict[UUID, MetadataOperationOut]:
    calls = latest_job_generations(
        db, kind="media_enrichment", job_ids=[row["job_id"] for row in rows]
    )
    return {row["job_id"]: _operation(row, calls.get(row["job_id"])) for row in rows}


def _operation(row: RowMapping, call: LLMCall | None) -> MetadataOperationOut:
    selected: Any = None if call is None else call.generation_spec["selection"]
    common: dict[str, Any] = {
        "job_id": row["job_id"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "generation_id": None if call is None else call.id,
        "purpose": row["payload"]["purpose"],
        "selection": None
        if selected is None
        else MetadataSelection(
            route=selected["route"],
            model=selected.get("model") or selected["model_ref"],
            reasoning=selected["reasoning"],
        ),
    }
    result = row["result"]
    match row["effective_status"]:
        case "completed" if common["purpose"] == "title":
            outcome = MetadataTitleCompletedOutcome(
                purpose="title",
                completed_at=row["completed_at"],
                changed_fields=result["changed_fields"],
                disposition=result["disposition"],
            )
            return MetadataCompletedOperation(**common, outcome=outcome)
        case "completed":
            outcome = MetadataBibliographyCompletedOutcome(
                purpose="bibliography",
                completed_at=row["completed_at"],
                changed_fields=result["changed_fields"],
                unresolved_fields=result["unresolved_fields"],
            )
            return MetadataCompletedOperation(**common, outcome=outcome)
        case "no_findings":
            return MetadataNoFindingsOperation(
                **common, completed_at=row["completed_at"], reviewed_at=row["reviewed_at"]
            )
        case "failed":
            return MetadataFailedOperation(
                **common, completed_at=row["completed_at"], code=row["failure_code"]
            )
        case "running":
            return MetadataRunningOperation(**common)
        case "waiting":
            return MetadataWaitingOperation(**common, reason="retry", until=row["available_at"])
        case "recovering":
            return MetadataRecoveringOperation(**common)
        case _:
            return MetadataQueuedOperation(**common)


def _retry(
    media: Any, *, viewer_id: UUID, unfinished: int, latest: UUID | None, has_source: bool
) -> MetadataRetry:
    purpose = metadata_purpose(
        provider=media.provider, provider_id=media.provider_id, kind=media.kind
    )
    if media.created_by_user_id != viewer_id:
        return MetadataRetryBlocked(purpose=purpose, reason="not_creator")
    if not is_metadata_enrichment_eligible(
        kind=media.kind,
        provider=media.provider,
        provider_id=media.provider_id,
        processing_status=media.status,
    ):
        return MetadataRetryBlocked(purpose=purpose, reason="not_eligible")
    if unfinished:
        return MetadataRetryBlocked(purpose=purpose, reason="active")
    if purpose == "title" and not has_source:
        return MetadataRetryBlocked(purpose=purpose, reason="source_context_missing")
    return MetadataRetryAllowed(purpose=purpose, expected_job_id=latest)


def metadata_enrichment_views(
    db: Session, *, viewer_id: UUID, media_ids: Sequence[UUID]
) -> dict[UUID, MetadataEnrichmentView]:
    """Each existing media's view in the caller's snapshot; history is counted, not loaded."""
    if not media_ids:
        return {}
    media = db.execute(
        text("""
            SELECT id, kind::text AS kind, provider, provider_id, processing_status::text AS status,
                created_by_user_id, metadata_enriched_at
            FROM media WHERE id = ANY(:ids)
        """),
        {"ids": list(media_ids)},
    ).all()
    sources = x_source_attempt_ids(
        db,
        media_ids=[
            item.id
            for item in media
            if metadata_purpose(
                provider=item.provider, provider_id=item.provider_id, kind=item.kind
            )
            == "title"
        ],
    )
    rows = (
        db.execute(
            text(f"""
                WITH ranked AS (
                    SELECT ops.*,
                        row_number() OVER (PARTITION BY media_id ORDER BY created_at DESC, id DESC)
                            AS latest_position,
                        count(*) FILTER (WHERE is_unfinished) OVER (PARTITION BY media_id)
                            AS unfinished_count,
                        row_number() OVER (
                            PARTITION BY media_id, is_unfinished ORDER BY created_at, id
                        ) AS unfinished_position
                    FROM ({metadata_operations_sql()}) ops WHERE media_id = ANY(:ids)
                )
                SELECT * FROM ranked
                WHERE latest_position = 1 OR (is_unfinished AND unfinished_position = 1)
            """),
            {"viewer_id": viewer_id, "ids": list(media_ids)},
        )
        .mappings()
        .all()
    )
    operations = _operations(db, rows)
    latest: dict[UUID, RowMapping] = {}
    # An unfinished job (pending, running, failed) projects to an unfinished operation.
    unfinished: dict[UUID, Any] = {}
    for row in rows:
        if row["latest_position"] == 1:
            latest[row["media_id"]] = row
        if row["is_unfinished"] and row["unfinished_position"] == 1:
            unfinished[row["media_id"]] = operations[row["job_id"]]
    views: dict[UUID, MetadataEnrichmentView] = {}
    for item in media:
        head = latest.get(item.id)
        count = 0 if head is None else head["unfinished_count"]
        views[item.id] = MetadataEnrichmentView(
            operation=None if head is None else operations[head["job_id"]],
            unfinished_count=count,
            unfinished_operation=unfinished.get(item.id),
            retry=_retry(
                item,
                viewer_id=viewer_id,
                unfinished=count,
                latest=None if head is None else head["job_id"],
                has_source=item.id in sources,
            ),
            last_enriched_at=item.metadata_enriched_at,
        )
    return views


def metadata_operations_for_jobs(
    db: Session, *, viewer_id: UUID, job_ids: Sequence[UUID]
) -> dict[UUID, MetadataOperationOut]:
    """Exact operations for an already-authorized history page."""
    if not job_ids:
        return {}
    rows = (
        db.execute(
            text(f"SELECT * FROM ({metadata_operations_sql()}) ops WHERE job_id = ANY(:ids)"),
            {"viewer_id": viewer_id, "ids": list(job_ids)},
        )
        .mappings()
        .all()
    )
    return _operations(db, rows)


def metadata_enrichment_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> MetadataEnrichmentView:
    """The metadata stream's frame; an unreadable media is ``E_MEDIA_NOT_FOUND``."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return metadata_enrichment_views(db, viewer_id=viewer_id, media_ids=[media_id])[media_id]


def enqueue_metadata_enrichment(
    db: Session, *, media_id: UUID, requester_user_id: UUID, request_id: str | None
) -> JobRow:
    """In the caller's transaction, under the media lock, strictly after the latest job; an
    X post/thread without its captured source cannot take a title job; native articles
    never take generated metadata."""
    from nexus.services import library_entries
    from nexus.services.media_parts import part_definition_version

    library_entries.lock_media_rows_in_order(db, [media_id])
    media = db.execute(
        text(
            "SELECT kind::text AS kind, provider, provider_id FROM media WHERE id = :m FOR UPDATE"
        ),
        {"m": media_id},
    ).one()
    if (
        native_x_article_id(kind=media.kind, provider=media.provider, provider_id=media.provider_id)
        is not None
    ):
        raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, _BLOCKED_COPY["not_eligible"])
    payload: BibliographyMetadataJobPayload | TitleMetadataJobPayload
    if (
        metadata_purpose(provider=media.provider, provider_id=media.provider_id, kind=media.kind)
        == "title"
    ):
        source_attempt_id = x_source_attempt_ids(db, media_ids=[media_id]).get(media_id)
        if source_attempt_id is None:
            raise ConflictError(
                ApiErrorCode.E_RETRY_NOT_ALLOWED, _BLOCKED_COPY["source_context_missing"]
            )
        payload = TitleMetadataJobPayload(
            purpose="title",
            media_id=media_id,
            requester_user_id=requester_user_id,
            request_id=request_id,
            source_attempt_id=source_attempt_id,
        )
    else:
        payload = BibliographyMetadataJobPayload(
            part_definition_version=part_definition_version(db, media_id=media_id),
            purpose="bibliography",
            media_id=media_id,
            requester_user_id=requester_user_id,
            request_id=request_id,
        )
    created_at = db.scalar(
        text("""
            SELECT greatest(clock_timestamp(), max(created_at) + interval '1 microsecond')
            FROM background_jobs WHERE kind = 'enrich_metadata' AND payload->>'media_id' = :m
        """),
        {"m": str(media_id)},
    )
    return enqueue_job(
        db, kind="enrich_metadata", payload=payload.model_dump(mode="json"), created_at=created_at
    )


def admit_metadata_enrichment(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_job_id: UUID | None,
    request_id: str | None,
) -> MetadataEnrichmentAccepted:
    """The creator's research request (I8, Q1).

    Retry rule: once the run a request admitted exists, a resend names a job older than
    the latest and answers the latest. An ``expected_job_id`` that is no job of this media,
    or a latest job of another purpose than the media's, is a conflict.
    """

    def admit() -> MetadataEnrichmentAccepted:
        from nexus.services.library_entries import lock_media_rows_in_order

        lock_media_rows_in_order(db, [media_id])
        media = db.execute(
            text("""
                SELECT kind::text AS kind, provider, provider_id, processing_status::text AS status,
                    created_by_user_id, metadata_enriched_at
                FROM media WHERE id = :m FOR UPDATE
            """),
            {"m": media_id},
        ).one_or_none()
        if media is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.created_by_user_id != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "only the creator can research metadata")
        if (
            native_x_article_id(
                kind=media.kind, provider=media.provider, provider_id=media.provider_id
            )
            is not None
        ):
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, _BLOCKED_COPY["not_eligible"])
        jobs = db.execute(
            text("""
                SELECT id, status, payload->>'purpose' AS purpose FROM background_jobs
                WHERE kind = 'enrich_metadata' AND payload->>'media_id' = :m
                ORDER BY created_at DESC, id DESC
            """),
            {"m": str(media_id)},
        ).all()
        latest = jobs[0].id if jobs else None
        purpose = metadata_purpose(
            provider=media.provider, provider_id=media.provider_id, kind=media.kind
        )
        if latest != expected_job_id:
            if (
                latest is None
                or jobs[0].purpose != purpose
                or (expected_job_id is not None and all(job.id != expected_job_id for job in jobs))
            ):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "metadata activity changed; refresh and try again",
                )
            return MetadataEnrichmentAccepted(
                media_id=media_id, job_id=latest, last_enriched_at=media.metadata_enriched_at
            )
        unfinished = sum(job.status in ("pending", "running", "failed") for job in jobs)
        has_source = purpose == "title" and media_id in x_source_attempt_ids(
            db, media_ids=[media_id]
        )
        retry = _retry(
            media, viewer_id=viewer_id, unfinished=unfinished, latest=latest, has_source=has_source
        )
        if isinstance(retry, MetadataRetryBlocked):
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, _BLOCKED_COPY[retry.reason])
        job = enqueue_metadata_enrichment(
            db, media_id=media_id, requester_user_id=viewer_id, request_id=request_id
        )
        return MetadataEnrichmentAccepted(
            media_id=media_id, job_id=job.id, last_enriched_at=media.metadata_enriched_at
        )

    return retry_read_committed(db, "metadata_enrichment.admit", admit)


def review_metadata_result(db: Session, *, viewer_id: UUID, media_id: UUID, job_id: UUID) -> None:
    """Mark one no-findings result reviewed for this viewer (I11); an existing review stands."""

    def review() -> None:
        db.execute(text("SELECT 1 FROM media WHERE id = :m FOR UPDATE"), {"m": media_id})
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        row = (
            db.execute(
                text(f"""
                    SELECT effective_status, reviewed_at FROM ({metadata_operations_sql()}) ops
                    WHERE job_id = :job AND media_id = :m
                """),
                {"viewer_id": viewer_id, "job": job_id, "m": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Metadata result not found")
        if row["effective_status"] != "no_findings":
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "only a no-findings metadata result can be marked reviewed",
            )
        if row["reviewed_at"] is None:
            db.execute(
                text("""
                    INSERT INTO metadata_result_reviews (id, viewer_id, job_id, reviewed_at)
                    VALUES (:id, :viewer, :job, clock_timestamp())
                    ON CONFLICT (viewer_id, job_id) DO NOTHING
                """),
                {"id": new_uuid7(), "viewer": viewer_id, "job": job_id},
            )
            db.execute(text("SELECT pg_notify('media_events', :m)"), {"m": str(media_id)})

    retry_read_committed(db, "metadata_result.review", review)


_MEDIA_REVIEWS = """
    DELETE FROM metadata_result_reviews review USING background_jobs job
    WHERE review.job_id = job.id AND job.kind = 'enrich_metadata'
      AND job.payload->>'media_id' = :m
"""


def delete_viewer_media_reviews(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Removal clears this viewer's reviews; the jobs stay (I10, I11)."""
    db.execute(
        text(_MEDIA_REVIEWS + " AND review.viewer_id = :viewer"),
        {"m": str(media_id), "viewer": viewer_id},
    )


def delete_media_reviews(db: Session, *, media_id: UUID) -> None:
    """Teardown clears every review of the media; the jobs stay (I10)."""
    db.execute(text(_MEDIA_REVIEWS), {"m": str(media_id)})
