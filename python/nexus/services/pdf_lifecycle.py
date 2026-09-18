"""PDF source lifecycle boundary.

PDF extraction/materialization is invoked by the durable source-ingest worker.
Public confirm/retry calls route through ``media_source_ingest`` so source
attempts remain the owner.
"""

from collections.abc import Callable
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    ResourceLimitError,
)
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
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    replace_reader_publication,
    superseded_reader_source_paths,
    unpublished_reader_source_paths,
)
from nexus.storage.client import get_storage_client

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000
_PDF_AUTHOR_SOURCE = "pdf_metadata"


def _extraction_api_error(plan: PdfExtractionError) -> ApiError:
    message = (plan.error_message or "PDF extraction failed")[:_MAX_ERROR_MSG_LEN]
    code = _source_api_error_code(plan.error_code)
    if plan.resource_limit_dimension is None:
        return ApiError(code, message)
    # justify-service-invariant-check: the parser result pairs a free-form code
    # string with an optional dimension, so only this projection can state that
    # a dimension means the declared resource-limit code.
    assert code is ApiErrorCode.E_RESOURCE_LIMIT, (
        f"PDF extraction reported dimension {plan.resource_limit_dimension} "
        f"with error code {code.value}"
    )
    return ResourceLimitError(message, dimension=plan.resource_limit_dimension)


def prepare_pdf_source(
    *,
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    expected_source_sha256: str,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
) -> PdfExtractionPlan:
    """Acquire and parse one immutable PDF source outside a DB transaction."""
    plan = build_pdf_extraction_plan(
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        expected_source_sha256=expected_source_sha256,
        storage_client=get_storage_client(),
        record_progress=record_progress,
        source_package=source_package,
        source_package_diagnostics=source_package_diagnostics,
    )
    if isinstance(plan, PdfExtractionError):
        raise _extraction_api_error(plan)
    return plan


def publish_pdf_source(
    db: Session,
    *,
    media_id: UUID,
    plan: PdfExtractionPlan,
    source_file: ReaderPublicationSourceFile | None = None,
) -> tuple[dict[str, object], list[str]]:
    """Publish one prepared PDF plan in the caller's fenced transaction.

    ``source_file`` is the newly prepared source object this publication makes
    reader-visible; the publication owner installs that pointer under its lock.
    Returns the response and the storage paths the caller deletes only after its
    transaction commits: either the rejected prepared source, or the source this
    successful publication superseded.
    """
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "pdf":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be PDF.")
    if media.processing_status != ProcessingStatus.extracting:
        # Nothing is published, so the prepared object never becomes reader-visible
        # and the current pointer and generation both stand.
        return {
            "status": "skipped",
            "reason": "not_extracting",
        }, unpublished_reader_source_paths(db, media_id=media_id, source_file=source_file)
    superseded_source_paths = superseded_reader_source_paths(
        db,
        media_id=media_id,
        source_file=source_file,
    )

    def replace_projection(locked_media: Media) -> dict[str, object]:
        result = publish_pdf_extraction_plan(db, media_id=media_id, plan=plan)
        assert isinstance(result, PdfExtractionResult)
        persist_pdf_metadata(locked_media, result)
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

    response = replace_reader_publication(
        db,
        media_id=media_id,
        expected_kind="pdf",
        replace_projection=replace_projection,
        source_file=source_file,
    )
    return response, superseded_source_paths


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
