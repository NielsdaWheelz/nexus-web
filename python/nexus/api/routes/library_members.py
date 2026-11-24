"""Library membership and invitation routes. Transport only. Registered before the
libraries router, whose uuid `{library_id}` would refuse the static
`/libraries/invites…` paths.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.schemas.library_members import (
    CreateInvitationRequest,
    LibraryInvitationOut,
    LibraryMemberOut,
    SetMemberRoleRequest,
    TransferOwnershipRequest,
    ViewerInvitationOut,
)
from nexus.services import library_members

router = APIRouter(tags=["libraries"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/libraries/invites")
def list_viewer_invitations(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionIndex[ViewerInvitationOut]]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(data=library_members.list_viewer_invitations(db, viewer.user_id))


@router.post("/libraries/invites/{invitation_id}/accept", status_code=204)
def accept_invitation(invitation_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    library_members.respond_to_invitation(db, viewer.user_id, invitation_id, accept=True)
    return Response(status_code=204)


@router.post("/libraries/invites/{invitation_id}/decline", status_code=204)
def decline_invitation(invitation_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    library_members.respond_to_invitation(db, viewer.user_id, invitation_id, accept=False)
    return Response(status_code=204)


@router.delete("/libraries/invites/{invitation_id}", status_code=204)
def revoke_invitation(invitation_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    library_members.revoke_invitation(db, viewer.user_id, invitation_id)
    return Response(status_code=204)


@router.post("/libraries/{library_id}/invites", status_code=201)
def create_invitation(
    library_id: UUID, body: CreateInvitationRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryInvitationOut]:
    return Data(data=library_members.create_invitation(db, viewer.user_id, library_id, body))


@router.get("/libraries/{library_id}/invites")
def list_invitations(
    library_id: UUID, request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionIndex[LibraryInvitationOut]]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(data=library_members.list_invitations(db, viewer.user_id, library_id))


@router.get("/libraries/{library_id}/members")
def list_members(
    library_id: UUID, request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionIndex[LibraryMemberOut]]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(data=library_members.list_members(db, viewer.user_id, library_id))


@router.patch("/libraries/{library_id}/members/{user_id}", status_code=204)
def set_member_role(
    library_id: UUID, user_id: UUID, body: SetMemberRoleRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    library_members.set_member_role(db, viewer.user_id, library_id, user_id, body)
    return Response(status_code=204)


@router.delete("/libraries/{library_id}/members/{user_id}", status_code=204)
def remove_member(library_id: UUID, user_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    library_members.remove_member(db, viewer.user_id, library_id, user_id)
    return Response(status_code=204)


@router.delete("/libraries/{library_id}/membership", status_code=204)
def leave_library(library_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    library_members.remove_member(db, viewer.user_id, library_id, viewer.user_id)
    return Response(status_code=204)


@router.post("/libraries/{library_id}/transfer-ownership", status_code=204)
def transfer_ownership(
    library_id: UUID, body: TransferOwnershipRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    library_members.transfer_ownership(db, viewer.user_id, library_id, body.user_id)
    return Response(status_code=204)
