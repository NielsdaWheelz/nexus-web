"""EPUB source lifecycle boundary and extraction artifact cleanup."""

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
    FragmentBlock,
    Media,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionPlan,
    EpubExtractionResult,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.epub_metadata import build_epub_author_observation, persist_epub_metadata
from nexus.services.media_author_observation_seam import attach_author_observation
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
) -> EpubExtractionPlan:
    """Acquire and parse one EPUB into an immutable publication plan."""
    plan = build_epub_extraction_plan(
        session_factory=session_factory,
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        storage_client=get_storage_client(),
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
) -> tuple[dict[str, object], list[str]]:
    """Publish a prepared EPUB plan in the caller's fenced transaction."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "epub":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be EPUB.")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "not_extracting"}, []

    result, old_storage_paths = publish_epub_extraction_plan(
        db,
        media_id=media_id,
        plan=plan,
    )
    assert isinstance(result, EpubExtractionResult)
    persist_epub_metadata(db, media, result)
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


def delete_extraction_artifacts(db: Session, media_id: UUID) -> list[str]:
    """Delete rewriteable EPUB extraction artifacts for a media row.

    Apparatus remains until extraction reconciles it by stable key.
    """
    storage_paths = (
        db.execute(select(EpubResource.storage_path).where(EpubResource.media_id == media_id))
        .scalars()
        .all()
    )

    db.execute(delete(EpubResource).where(EpubResource.media_id == media_id))
    db.execute(delete(EpubFragmentSource).where(EpubFragmentSource.media_id == media_id))
    db.execute(delete(EpubNavLocation).where(EpubNavLocation.media_id == media_id))
    db.execute(delete(EpubTocNode).where(EpubTocNode.media_id == media_id))

    fragment_ids = (
        db.execute(select(Fragment.id).where(Fragment.media_id == media_id)).scalars().all()
    )

    if fragment_ids:
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))

    # Highlights are authored user data and are NOT deleted here: refresh
    # publishes new fragments, then authored selectors (Highlights, passage
    # anchors) resolve against the new current content (spec "Highlight
    # Durability", Invariant 9). Fragment deletion only invalidates the
    # highlight_fragment_anchors locator cache (fragment_id FK is non-cascading,
    # non-owning); the Highlight root survives and is resolved via LEFT JOIN
    # + quote re-resolution.
    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    db.flush()
    return list(storage_paths)


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
