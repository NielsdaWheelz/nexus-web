"""Retry-stage dispatch for media reprocessing."""

from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.media_source_ingest import retry_source_for_viewer
from nexus.services.metadata_lifecycle import retry_metadata_for_viewer


def retry_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    from_stage: Literal["source", "metadata"],
    request_id: str | None,
    idempotency_key: str | None = None,
) -> dict:
    """Retry a viewer's media from the given stage. ``source`` re-runs full
    source acquisition + reprocessing; ``metadata`` re-enriches LLM metadata only."""
    if from_stage == "source":
        return retry_source_for_viewer(
            db=db,
            viewer_id=viewer_id,
            media_id=media_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
        )
    return retry_metadata_for_viewer(
        db=db, viewer_id=viewer_id, media_id=media_id, request_id=request_id
    )
