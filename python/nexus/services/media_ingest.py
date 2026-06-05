"""URL ingest dispatch."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.media import FromUrlResponse
from nexus.services.media_source_ingest import accept_url_source


def enqueue_media_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> FromUrlResponse:
    """Create media from URL with source-owner dispatch."""
    return accept_url_source(
        db=db,
        viewer_id=viewer_id,
        url=url,
        library_ids=library_ids,
        request_id=request_id,
        idempotency_key=idempotency_key,
    )
