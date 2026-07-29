"""PDF source lifecycle boundary.

PDF extraction/materialization is invoked by the durable source-ingest worker.
Public confirm/retry calls route through ``media_source_ingest`` so source
attempts remain the owner.
"""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.pdf_ingest import (
    PdfExtractionError,
    PdfExtractionPlan,
    PdfExtractionResult,
    PdfSourcePackageArtifact,
    build_pdf_extraction_plan,
    publish_pdf_extraction_plan,
)
from nexus.services.pdf_metadata import build_pdf_author_observation, persist_pdf_metadata
from nexus.storage.client import get_storage_client

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000
_PDF_AUTHOR_SOURCE = "pdf_metadata"


def confirm_pdf_ingest(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    library_ids: list[UUID],
    request_id: str | None = None,
) -> dict:
    from nexus.services.media_source_ingest import confirm_uploaded_source

    return confirm_uploaded_source(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        library_ids=library_ids,
        request_id=request_id,
    )


def retry_pdf_ingest_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    from nexus.services.media_source_ingest import retry_source_for_viewer

    return retry_source_for_viewer(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        request_id=request_id,
    )


def prepare_pdf_source(
    *,
    media_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
) -> PdfExtractionPlan:
    """Acquire and parse one immutable PDF source outside a DB transaction."""
    plan = build_pdf_extraction_plan(
        media_id=media_id,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        storage_client=get_storage_client(),
        source_package=source_package,
        source_package_diagnostics=source_package_diagnostics,
    )
    if isinstance(plan, PdfExtractionError):
        raise ApiError(
            _source_api_error_code(plan.error_code),
            (plan.error_message or "PDF extraction failed")[:_MAX_ERROR_MSG_LEN],
        )
    return plan


def publish_pdf_source(
    db: Session,
    *,
    media_id: UUID,
    plan: PdfExtractionPlan,
) -> dict[str, object]:
    """Publish one prepared PDF plan in the caller's fenced transaction."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "pdf":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be PDF.")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "not_extracting"}

    result = publish_pdf_extraction_plan(db, media_id=media_id, plan=plan)
    assert isinstance(result, PdfExtractionResult)
    persist_pdf_metadata(db, media, result)
    bump_all_collection_families(
        db,
        families=(
            CollectionFamily.AuthorWorks,
            CollectionFamily.LibraryEntries,
        ),
    )
    db.flush()
    response: dict[str, object] = {
        "status": "success",
        "page_count": result.page_count,
        "has_text": result.has_text,
        "metadata_enrichment": True,
    }
    if not result.has_text:
        response["warning_error_code"] = "E_PDF_TEXT_UNAVAILABLE"
    observation, truncated = build_pdf_author_observation(result)
    if truncated:
        logger.info("pdf_author_truncation", media_id=str(media_id), truncated=truncated)
    attach_author_observation(response, observation=observation, source=_PDF_AUTHOR_SOURCE)
    return response


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
