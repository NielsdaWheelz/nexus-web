"""Internal-only podcast billing/operator routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.principals import can_manage_podcast_plan_entitlements
from nexus.errors import ApiErrorCode, ForbiddenError
from nexus.responses import success_response
from nexus.schemas.podcast import PodcastPlanUpdateRequest
from nexus.services import podcasts as podcast_service

router = APIRouter()


@router.put("/internal/podcasts/users/{user_id}/plan")
def update_podcast_plan(
    user_id: UUID,
    body: PodcastPlanUpdateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Assign podcast entitlements via billing/admin principal policy."""
    if not can_manage_podcast_plan_entitlements(viewer):
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Podcast plan changes require billing/admin authorization.",
        )

    out = podcast_service.update_user_plan(db, user_id, body)
    return success_response(out.model_dump(mode="json"))
