"""EPUB source lifecycle boundary and extraction artifact cleanup."""

from collections.abc import Callable
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    Media,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionPlan,
    EpubExtractionResult,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.epub_metadata import build_epub_author_observation, persist_epub_metadata
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    replace_reader_publication,
    superseded_reader_source_paths,
    unpublished_reader_source_paths,
)
from nexus.storage.client import get_storage_client

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000
_EPUB_AUTHOR_SOURCE = "epub_opf"


def confirm_ingest_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_ids: list[UUID],
    *,
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


def retry_epub_ingest_for_viewer(
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


def prepare_epub_source(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> EpubExtractionPlan:
    """Acquire and parse one EPUB into an immutable publication plan."""
    plan = build_epub_extraction_plan(
        session_factory=session_factory,
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        storage_client=get_storage_client(),
        record_progress=record_progress,
    )
    if isinstance(plan, EpubExtractionError):
        raise ApiError(
            _source_api_error_code(plan.error_code),
            (plan.error_message or "EPUB extraction failed")[:_MAX_ERROR_MSG_LEN],
        )
    return plan


def publish_epub_source(
    db: Session,
    *,
    media_id: UUID,
    plan: EpubExtractionPlan,
    source_file: ReaderPublicationSourceFile | None = None,
) -> tuple[dict[str, object], list[str]]:
    """Publish a prepared EPUB plan in the caller's fenced transaction.

    ``source_file`` is the newly prepared source object this publication makes
    reader-visible; the publication owner installs that pointer under its lock.
    Returns the response and the storage paths the caller deletes only after its
    transaction commits: either the rejected prepared source, or the source and
    assets this successful publication superseded.
    """
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "epub":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be EPUB.")
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

    def replace_projection(locked_media: Media) -> tuple[dict[str, object], list[str]]:
        result, old_storage_paths = publish_epub_extraction_plan(
            db,
            media_id=media_id,
            plan=plan,
        )
        assert isinstance(result, EpubExtractionResult)
        persist_epub_metadata(db, locked_media, result)
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
            "chapter_count": result.chapter_count,
            "toc_node_count": result.toc_node_count,
            "asset_count": result.asset_count,
            "title": result.title,
            "metadata_enrichment": True,
        }
        observation, truncated = build_epub_author_observation(result)
        if truncated:
            logger.info("epub_author_truncation", media_id=str(media_id), truncated=truncated)
        attach_author_observation(response, observation=observation, source=_EPUB_AUTHOR_SOURCE)
        return response, old_storage_paths

    response, old_storage_paths = replace_reader_publication(
        db,
        media_id=media_id,
        expected_kind="epub",
        replace_projection=replace_projection,
        source_file=source_file,
    )
    return response, superseded_source_paths + old_storage_paths


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
