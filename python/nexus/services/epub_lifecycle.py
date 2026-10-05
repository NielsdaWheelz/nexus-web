"""EPUB source lifecycle boundary: prepare one plan, publish it under the fence."""

from collections.abc import Callable
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media, ProcessingStatus
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    ResourceLimitError,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present, present
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionPlan,
    EpubExtractionResult,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    ReplaceSourceIssues,
    replace_reader_publication,
    superseded_reader_source_paths,
    unpublished_reader_source_paths,
)
from nexus.services.source_outcome import (
    SourceDiagnostics,
    SourceRunOutcome,
    source_contributor_observations,
)
from nexus.storage.client import get_storage_client

logger = get_logger(__name__)


def prepare_epub_source(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    expected_source_sha256: str,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> EpubExtractionPlan:
    """Acquire and parse one EPUB into an immutable publication plan."""
    plan = build_epub_extraction_plan(
        session_factory=session_factory,
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        expected_source_sha256=expected_source_sha256,
        storage_client=get_storage_client(),
        record_progress=record_progress,
    )
    if not isinstance(plan, EpubExtractionError):
        return plan
    message = (plan.error_message or "EPUB extraction failed")[:1000]
    if plan.resource_limit_dimension is not None:
        raise ResourceLimitError(message, dimension=plan.resource_limit_dimension)
    try:
        code = ApiErrorCode(plan.error_code or "")
    except ValueError:
        code = ApiErrorCode.E_INGEST_FAILED
    raise ApiError(code, message)


def publish_epub_source(
    db: Session,
    *,
    media_id: UUID,
    plan: EpubExtractionPlan,
    source_file: ReaderPublicationSourceFile | None = None,
) -> tuple[SourceRunOutcome, list[str]]:
    """Publish a prepared EPUB plan in the caller's fenced transaction.

    ``source_file`` is the newly prepared source object this publication makes
    reader-visible; the publication owner installs that pointer under its lock.
    Returns the native outcome and storage paths the caller deletes only after its
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
        return SourceRunOutcome(
            diagnostics={"status": "skipped", "reason": "not_extracting"}
        ), unpublished_reader_source_paths(db, media_id=media_id, source_file=source_file)
    superseded_source_paths = superseded_reader_source_paths(
        db, media_id=media_id, source_file=source_file
    )

    def replace_projection(locked_media: Media) -> tuple[SourceRunOutcome, list[str]]:
        result, old_storage_paths = publish_epub_extraction_plan(db, media_id=media_id, plan=plan)
        _persist_epub_metadata(locked_media, result)
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        db.flush()
        diagnostics: SourceDiagnostics = {
            "status": "success",
            "fragment_count": result.fragment_count,
            "toc_node_count": result.toc_node_count,
            "asset_count": result.asset_count,
            "title": result.title,
        }
        for issue in result.contributor_issues:
            logger.warning(
                "epub_contributor_observation_unrepresentable",
                media_id=str(media_id),
                code=issue.code,
                detail=issue.detail,
            )
        if result.contributor_issues:
            diagnostics["contributor_issues"] = [
                {"code": issue.code, "detail": issue.detail} for issue in result.contributor_issues
            ]
        return SourceRunOutcome(
            diagnostics=diagnostics,
            observations=source_contributor_observations(
                media_id=media_id, observation=result.contributor_observation, source="epub_opf"
            ),
            metadata_enrichment=present(True),
        ), old_storage_paths

    outcome, old_storage_paths = replace_reader_publication(
        db,
        media_id=media_id,
        expected_kind="epub",
        replace_projection=replace_projection,
        issues=ReplaceSourceIssues(issues=plan.source_issues),
        source_file=source_file,
    )
    return outcome, superseded_source_paths + old_storage_paths


def _persist_epub_metadata(media: Media, result: EpubExtractionResult) -> None:
    """Fill the media row from OPF metadata; credits travel as an observation."""
    if result.title:
        media.title = result.title
    if result.publisher and not media.publisher:
        media.publisher = result.publisher[:255]
    if result.language and not media.language:
        media.language = result.language[:32]
    if result.description and not media.description:
        media.description = result.description[:2000]
    if isinstance(result.edition_published_date, Present):
        media.edition_published_date = result.edition_published_date.value
    if isinstance(result.edition_isbn, Present):
        media.edition_isbn = result.edition_isbn.value
