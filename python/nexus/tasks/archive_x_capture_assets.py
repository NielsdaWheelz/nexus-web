"""Archive declared images before claim-checked insert; accepted bytes never change."""

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import XPostCapture, XPostCaptureAsset
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    TerminalJobFailure,
    enqueue_job,
    get_job,
    lock_running_job_claim,
)
from nexus.schemas.x_captures import XCaptureArchiveOut, XCaptureAssetOut
from nexus.services.image_validation import ValidatedImage, fetch_validated_image
from nexus.services.source_attempts import successor_id
from nexus.services.x_capture_job_hooks import retrieval
from nexus.services.x_rendering import capture_image_urls
from nexus.services.x_source import require_readable_x_capture
from nexus.storage.client import get_storage_client


def archive_status(db: Session, *, viewer_id: UUID, capture_id: UUID) -> XCaptureArchiveOut:
    capture = require_readable_x_capture(db, viewer_id=viewer_id, capture_id=capture_id)
    present = set(
        db.scalars(
            select(XPostCaptureAsset.asset_key).where(XPostCaptureAsset.capture_id == capture_id)
        )
    )
    current = retrieval(db, capture.asset_job_id)
    missing = set(capture_image_urls(capture.payload)) - present
    if current is not None:
        current = current.model_copy(
            update={"can_retry": bool(missing) and current.status in {"failed", "succeeded"}}
        )
    return XCaptureArchiveOut(
        capture_id=capture_id,
        retrieval=current,
        assets=[
            XCaptureAssetOut(
                asset_key=key,
                url=f"/api/x/captures/{capture_id}/assets/{key}" if key in present else None,
            )
            for key in capture_image_urls(capture.payload)
        ],
    )


def run_job(*, payload: Mapping[str, object], context: JobExecutionContext) -> JobResult:
    capture_id = UUID(str(payload["capture_id"]))
    factory = get_session_factory()
    with factory() as db:
        capture = db.get(XPostCapture, capture_id)
        if capture is None or capture.asset_job_id != context.job_id:
            return {"status": "superseded"}
        images = capture_image_urls(capture.payload)
        present = set(
            db.scalars(
                select(XPostCaptureAsset.asset_key).where(
                    XPostCaptureAsset.capture_id == capture_id
                )
            )
        )
    failures: list[ApiError] = []
    for key, url in images.items():
        if key in present:
            continue
        try:
            image = fetch_validated_image(url)
        except ApiError as exc:
            failures.append(exc)
            continue
        path = f"media/x-captures/{capture_id}/{new_uuid7()}"
        get_storage_client().put_object(path, image.data, image.content_type)
        with factory() as db:

            def publish(key: str = key, path: str = path, image: ValidatedImage = image) -> bool:
                capture = db.scalar(
                    select(XPostCapture).where(XPostCapture.id == capture_id).with_for_update()
                )
                if (
                    capture is None
                    or capture.asset_job_id != context.job_id
                    or lock_running_job_claim(db, context=context) is None
                ):
                    return False
                if (
                    db.scalar(
                        select(XPostCaptureAsset.id).where(
                            XPostCaptureAsset.capture_id == capture_id,
                            XPostCaptureAsset.asset_key == key,
                        )
                    )
                    is None
                ):
                    db.add(
                        XPostCaptureAsset(
                            id=new_uuid7(),
                            capture_id=capture_id,
                            asset_key=key,
                            storage_path=path,
                            mime=image.content_type,
                            sha256=hashlib.sha256(image.data).hexdigest(),
                            size_bytes=len(image.data),
                            captured_at=datetime.now(UTC),
                        )
                    )
                return True

            if not retry_serializable(db, "archive_x_capture_asset", publish):
                return {"status": "superseded"}
    if failures:
        failure = failures[0]
        return TerminalJobFailure(
            result_payload={"capture_id": str(capture_id)},
            error_code=failure.code.value,
            error_message="image unavailable in saved capture",
        )
    return {"capture_id": str(capture_id)}


def retry_images(
    db: Session, *, viewer_id: UUID, capture_id: UUID, expected_job_id: UUID
) -> XCaptureArchiveOut:
    def retry() -> XCaptureArchiveOut:
        capture = require_readable_x_capture(db, viewer_id=viewer_id, capture_id=capture_id)
        db.refresh(capture, with_for_update=True)
        successor = successor_id(expected_job_id)
        if capture.asset_job_id == successor:
            return archive_status(db, viewer_id=viewer_id, capture_id=capture_id)
        if capture.asset_job_id != expected_job_id:
            raise ConflictError(ApiErrorCode.E_RETRY_INVALID_STATE, "image retrieval changed")
        job = get_job(db, expected_job_id, lock=True)
        if job is None or job.status not in {"dead", "succeeded"}:
            raise ConflictError(
                ApiErrorCode.E_RETRY_INVALID_STATE, "image retrieval is still running"
            )
        present = set(
            db.scalars(
                select(XPostCaptureAsset.asset_key).where(
                    XPostCaptureAsset.capture_id == capture_id
                )
            )
        )
        if set(capture_image_urls(capture.payload)) <= present:
            return archive_status(db, viewer_id=viewer_id, capture_id=capture_id)
        capture.asset_job_id = enqueue_job(
            db,
            id=successor,
            kind="archive_x_capture_assets",
            payload={"capture_id": str(capture_id)},
        ).id
        db.flush()
        return archive_status(db, viewer_id=viewer_id, capture_id=capture_id)

    return retry_serializable(db, "retry_x_capture_images", retry)
