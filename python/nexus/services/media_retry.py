"""Retry-stage dispatch for media reprocessing."""

from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.metadata_lifecycle import retry_metadata_for_viewer
from nexus.services.pdf_lifecycle import retry_for_viewer_unified


def retry_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    from_stage: Literal["source", "metadata"],
    request_id: str | None,
) -> dict:
    """Retry a viewer's media from the given stage. ``source`` re-runs full
    source acquisition + reprocessing; ``metadata`` re-enriches LLM metadata only."""
    if from_stage == "source":
        return retry_for_viewer_unified(
            db=db, viewer_id=viewer_id, media_id=media_id, request_id=request_id
        )
    return retry_metadata_for_viewer(
        db=db, viewer_id=viewer_id, media_id=media_id, request_id=request_id
    )
