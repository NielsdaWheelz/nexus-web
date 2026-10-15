"""Library membership and invitation routes (moved unchanged; rewritten in the
membership slice). Transport only. Registered before the libraries router so the
static `/libraries/invites…` paths are not taken for a library id.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data, DataPage
from nexus.schemas.library import LibraryOut
from nexus.schemas.library_members import (
    AcceptLibraryInviteResponse,
    CreateLibraryInviteRequest,
    DeclineLibraryInviteResponse,
    LibraryGovernancePageInfo,
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryMemberOut,
    TransferLibraryOwnershipRequest,
    UpdateLibraryMemberRequest,
    ViewerLibraryInvitationOut,
)
from nexus.services import library_sharing
from nexus.services.sealed_handles import InvalidSealedHandle, unseal_user

router = APIRouter(tags=["libraries"])

_STATUS_QUERY = Query(description="Filter by invite status")
_CURSOR_QUERY = Query(description="Pagination cursor")
_LIMIT_QUERY = Query(ge=1, description="Maximum results (clamped to 200)")


def _user_id(user_handle: str) -> UUID:
    try:
        return unseal_user(user_handle)
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc


@router.get("/libraries/invites")
def list_viewer_invites(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    status: Annotated[LibraryInvitationStatusValue, _STATUS_QUERY] = "pending",
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> Data[list[ViewerLibraryInvitationOut]]:
    """List invitations addressed to the current viewer."""
    result = library_sharing.list_viewer_invites(db, viewer.user_id, status=status, limit=limit)
    return Data(data=result)


@router.post("/libraries/invites/{invitation_handle}/accept")
def accept_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[AcceptLibraryInviteResponse]:
    """Accept a library invitation. Invitee-only; idempotent when already accepted."""
    result = library_sharing.accept_library_invite(db, viewer.user_id, invitation_handle)
    return Data(data=result)


@router.post("/libraries/invites/{invitation_handle}/decline")
def decline_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[DeclineLibraryInviteResponse]:
    """Decline a library invitation. Invitee-only; idempotent when already declined."""
    result = library_sharing.decline_library_invite(db, viewer.user_id, invitation_handle)
    return Data(data=result)


@router.delete("/libraries/invites/{invitation_handle}", status_code=204)
def revoke_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Response:
    """Revoke a pending invitation. Admin-only; idempotent when already revoked."""
    library_sharing.revoke_library_invite(db, viewer.user_id, invitation_handle)
    return Response(status_code=204)


@router.post("/libraries/{library_id}/invites", status_code=201)
def create_library_invite(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryInviteRequest,
    db: DbSession,
) -> Data[LibraryInvitationOut]:
    """Invite an existing user to a library. Admin-only."""
    result = library_sharing.create_library_invite(
        db, viewer.user_id, library_id, body.invitee, body.role
    )
    return Data(data=result)


@router.get("/libraries/{library_id}/invites")
def list_library_invites(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    status: Annotated[LibraryInvitationStatusValue, _STATUS_QUERY] = "pending",
    cursor: Annotated[str | None, _CURSOR_QUERY] = None,
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> DataPage[LibraryInvitationOut, LibraryGovernancePageInfo]:
    """List a library's invitations, newest first. Admin-only."""
    result, page = library_sharing.list_library_invites(
        db, viewer.user_id, library_id, status=status, cursor=cursor, limit=limit
    )
    return DataPage(data=result, page=page)


@router.get("/libraries/{library_id}/members")
def list_library_members(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    cursor: Annotated[str | None, _CURSOR_QUERY] = None,
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> DataPage[LibraryMemberOut, LibraryGovernancePageInfo]:
    """List a library's members by immutable member identity. Admin-only."""
    result, page = library_sharing.list_library_members(
        db, viewer.user_id, library_id, cursor=cursor, limit=limit
    )
    return DataPage(data=result, page=page)


@router.patch("/libraries/{library_id}/members/{user_handle}")
def update_library_member_role(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryMemberRequest,
    db: DbSession,
) -> Data[LibraryMemberOut]:
    """Set a member's role. Admin-only; the owner's role is fixed."""
    result = library_sharing.update_library_member_role(
        db, viewer.user_id, library_id, _user_id(user_handle), body.role
    )
    return Data(data=result)


@router.delete("/libraries/{library_id}/members/{user_handle}", status_code=204)
def remove_library_member(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Response:
    """Remove a member. Admin-only; idempotent for an absent target."""
    library_sharing.remove_library_member(db, viewer.user_id, library_id, _user_id(user_handle))
    return Response(status_code=204)


@router.post("/libraries/{library_id}/transfer-ownership")
def transfer_library_ownership(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: TransferLibraryOwnershipRequest,
    db: DbSession,
) -> Data[LibraryOut]:
    """Transfer ownership to another member. Owner-only."""
    result = library_sharing.transfer_library_ownership(
        db, viewer.user_id, library_id, _user_id(body.new_owner_user_handle)
    )
    return Data(data=result)
