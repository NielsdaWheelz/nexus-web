"""The Share overlay's routes: a resource's sharing snapshot, granting it, and revoking a grant."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.resource_sharing import (
    CreateResourceShareOut,
    CreateResourceShareRequest,
    ResourceShareSnapshotOut,
)
from nexus.services import resource_grants, resource_sharing
from nexus.services.resource_graph import refs

router = APIRouter(tags=["resource-shares"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
DbDep = Annotated[Session, Depends(get_db)]


def _ref(raw: str) -> refs.ResourceRef:
    ref = refs.parse_resource_ref(raw)
    if isinstance(ref, refs.ResourceRefParseFailure):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid resource ref")
    return ref


@router.get("/resource-items/{resource_ref}/shares")
def get_resource_shares(
    resource_ref: str, viewer: ViewerDep, db: DbDep
) -> Data[ResourceShareSnapshotOut]:
    snapshot = resource_sharing.get_share_snapshot(
        db, viewer_user_id=viewer.user_id, subject=_ref(resource_ref)
    )
    return Data(data=snapshot)


@router.post("/resource-items/{resource_ref}/shares")
def create_resource_share(
    resource_ref: str, body: CreateResourceShareRequest, viewer: ViewerDep, db: DbDep
) -> Data[CreateResourceShareOut]:
    created = resource_sharing.create_share(
        db, viewer_user_id=viewer.user_id, subject=_ref(resource_ref), audience=body.audience
    )
    return Data(data=created)


@router.delete("/resource-shares/{resource_grant_handle}", status_code=204)
def delete_resource_share(resource_grant_handle: str, viewer: ViewerDep, db: DbDep) -> Response:
    resource_grants.delete_grant(db, viewer_user_id=viewer.user_id, handle=resource_grant_handle)
    return Response(status_code=204)
