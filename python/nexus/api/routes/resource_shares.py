"""Authenticated resource Share transport."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.resource_sharing import CreateResourceShareRequest
from nexus.services import resource_grants, resource_sharing
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph.refs import ResourceRef

router = APIRouter(tags=["resource-shares"])


def _parse_ref(raw: str) -> ResourceRef:
    parsed = refs_service.parse_resource_ref(raw)
    if isinstance(parsed, refs_service.ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid resource ref",
        )
    return parsed


@router.get("/resource-items/{resource_ref}/shares")
def get_resource_shares(
    resource_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        resource_sharing.get_share_snapshot(
            db,
            viewer_user_id=viewer.user_id,
            subject=_parse_ref(resource_ref),
        ),
        by_alias=True,
    )


@router.post("/resource-items/{resource_ref}/shares")
def create_resource_share(
    resource_ref: str,
    body: CreateResourceShareRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        resource_sharing.create_share(
            db,
            viewer_user_id=viewer.user_id,
            subject=_parse_ref(resource_ref),
            audience=body.audience,
        ),
        by_alias=True,
    )


@router.delete("/resource-shares/{resource_grant_handle}", status_code=204)
def delete_resource_share(
    resource_grant_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    resource_grants.delete_grant(
        db,
        viewer_user_id=viewer.user_id,
        handle=resource_grant_handle,
    )
    return Response(status_code=204)
