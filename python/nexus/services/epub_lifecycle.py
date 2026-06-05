"""EPUB source lifecycle boundary and extraction artifact cleanup."""

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
    FragmentBlock,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.content_indexing import delete_media_content_index
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    extract_epub_artifacts,
)
from nexus.services.epub_metadata import persist_epub_metadata
from nexus.storage.client import get_storage_client

_MAX_ERROR_MSG_LEN = 1000


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


def materialize_epub_source(
    db: Session,
    *,
    media_id: UUID,
) -> dict[str, object]:
    """Persist EPUB extraction artifacts without owning source lifecycle state."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "epub":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be EPUB.")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "not_extracting"}

    result = extract_epub_artifacts(db, media_id, get_storage_client())
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.processing_status != ProcessingStatus.extracting:
        return {"status": "skipped", "reason": "state_changed"}
    if isinstance(result, EpubExtractionError):
        raise ApiError(
            _source_api_error_code(result.error_code),
            (result.error_message or "EPUB extraction failed")[:_MAX_ERROR_MSG_LEN],
        )

    assert isinstance(result, EpubExtractionResult)
    persist_epub_metadata(db, media, result)
    db.flush()
    return {
        "status": "success",
        "chapter_count": result.chapter_count,
        "toc_node_count": result.toc_node_count,
        "asset_count": result.asset_count,
        "title": result.title,
        "metadata_enrichment": True,
    }


def delete_extraction_artifacts(db: Session, media_id: UUID) -> list[str]:
    """Delete all EPUB extraction and chunk/embedding artifacts for a media row."""
    delete_media_content_index(db, media_id=media_id)
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
        db.execute(
            delete(Highlight).where(
                Highlight.id.in_(
                    select(HighlightFragmentAnchor.highlight_id).where(
                        HighlightFragmentAnchor.fragment_id.in_(fragment_ids)
                    )
                )
            )
        )
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))

    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    db.flush()
    return list(storage_paths)


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_INGEST_FAILED
