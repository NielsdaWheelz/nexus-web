"""PDF source lifecycle boundary.

PDF extraction/materialization is invoked by the durable source-ingest worker.
Public confirm/retry calls route through ``media_source_ingest`` so source
attempts remain the owner.
"""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.pdf_indexing import index_pdf_evidence
from nexus.services.pdf_ingest import (
    PdfExtractionError,
    PdfExtractionResult,
    PdfSourcePackageArtifact,
    extract_pdf_artifacts,
)
from nexus.services.pdf_metadata import persist_pdf_metadata
from nexus.storage.client import get_storage_client

_MAX_ERROR_MSG_LEN = 1000


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


def materialize_pdf_source(
    db: Session,
    *,
    media_id: UUID,
    request_id: str | None = None,
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
) -> dict[str, object]:
    """Persist PDF extraction artifacts without owning source lifecycle state."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "pdf":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be PDF.")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "not_extracting"}

    result = extract_pdf_artifacts(
        db,
        media_id,
        get_storage_client(),
        source_package=source_package,
        source_package_diagnostics=source_package_diagnostics,
    )
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "state_changed"}
    if isinstance(result, PdfExtractionError):
        raise ApiError(
            _source_api_error_code(result.error_code),
            (result.error_message or "PDF extraction failed")[:_MAX_ERROR_MSG_LEN],
        )

    assert isinstance(result, PdfExtractionResult)
    persist_pdf_metadata(db, media, result)
    db.flush()
    index_pdf_evidence(db, media_id, request_id, result)
    response: dict[str, object] = {
        "status": "success",
        "page_count": result.page_count,
        "has_text": result.has_text,
        "metadata_enrichment": True,
    }
    if not result.has_text:
        response["warning_error_code"] = "E_PDF_TEXT_UNAVAILABLE"
    return response


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
