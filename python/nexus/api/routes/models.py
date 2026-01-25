"""LLM Models registry routes.

Route handlers for viewing available LLM models.
Routes are transport-only: each calls exactly one service function.

Per PR-03 spec:
- GET /models: List models available to the current user

Model availability rule:
- model.is_available = true AND (
    platform key exists for model.provider
    OR user has API key with status ∈ {'untested', 'valid'}
  )

All routes require authentication.
Response envelope: {"data": [...]}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services import models as models_service

router = APIRouter(tags=["models"])


@router.get("/models")
def list_models(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List LLM models available to the current user.

    A model is included iff:
    - model.is_available = true
    - AND (platform key exists for model.provider OR user has usable BYOK)

    Keys with status='invalid' or status='revoked' do NOT enable models.
    Empty list is valid if no models are available.

    Returns:
        {"data": [ModelOut, ...]}
    """
    models = models_service.list_available_models(db=db, user_id=viewer.user_id)
    return success_response([m.model_dump(mode="json") for m in models])
