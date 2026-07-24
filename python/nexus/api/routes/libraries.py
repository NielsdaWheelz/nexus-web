"""Library routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.

IMPORTANT: Static routes (/libraries/invites) must be registered BEFORE
dynamic routes (/libraries/{library_id}) to prevent UUID path capture.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.responses import ok, ok_page
from nexus.schemas.library import (
    AddPodcastRequest,
    CreateLibraryInviteRequest,
    CreateLibraryRequest,
    LibraryEntryOrderRequest,
    LibraryInvitationStatusValue,
    LibraryPageInfo,
    TransferLibraryOwnershipRequest,
    UpdateLibraryMemberRequest,
    UpdateLibraryRequest,
)
from nexus.services import library_entries, library_governance, library_invitations
from nexus.services.resonance import service as resonance_service
from nexus.services.sealed_handles import InvalidSealedHandle, unseal_user

router = APIRouter(tags=["libraries"])


# =============================================================================
# Static invite routes (MUST be before /libraries/{library_id} routes)
# =============================================================================


@router.get("/libraries/invites")
def list_viewer_invites(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    status: Annotated[
        LibraryInvitationStatusValue, Query(description="Filter by invite status")
    ] = "pending",
    limit: Annotated[int, Query(ge=1, description="Maximum results (clamped to 200)")] = 100,
) -> dict:
    """List invitations addressed to the current viewer.

    Returns invites where invitee_user_id = viewer, ordered by created_at DESC.
    """
    result = library_invitations.list_viewer_invites(db, viewer.user_id, status=status, limit=limit)
    return ok(result, by_alias=True)


@router.post("/libraries/invites/{invitation_handle}/accept")
def accept_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Accept a library invitation.

    Invitee-only. Transactionally creates membership and upserts backfill job.
    Idempotent when already accepted.
    """
    result = library_invitations.accept_library_invite(db, viewer.user_id, invitation_handle)
    return ok(result, by_alias=True)


@router.post("/libraries/invites/{invitation_handle}/decline")
def decline_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Decline a library invitation.

    Invitee-only. Idempotent when already declined.
    """
    result = library_invitations.decline_library_invite(db, viewer.user_id, invitation_handle)
    return ok(result, by_alias=True)


@router.delete("/libraries/invites/{invitation_handle}", status_code=204)
def revoke_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Revoke a pending library invitation.

    Admin/owner of the invite's library only. Idempotent when already revoked.
    """
    library_invitations.revoke_library_invite(db, viewer.user_id, invitation_handle)
    return Response(status_code=204)


# =============================================================================
# Standard library routes
# =============================================================================


@router.get("/libraries")
def list_libraries(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
) -> dict:
    """List all libraries the viewer is a member of.

    Returns libraries ordered by created_at ASC, id ASC.
    """
    result, page = library_governance.list_libraries(db, viewer.user_id, cursor=cursor, limit=limit)
    return ok_page(result, page, by_alias=True)


@router.get("/libraries/writable-destinations")
def list_writable_library_destinations(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str | None = Query(default=None, max_length=100, description="Name search query"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=25, ge=1, le=50, description="Maximum results"),
) -> dict:
    result, next_cursor = library_governance.list_writable_library_destinations(
        db,
        viewer.user_id,
        q=(q or "").strip().lower(),
        cursor=cursor,
        limit=limit,
    )
    return ok_page(
        result,
        LibraryPageInfo(has_more=next_cursor is not None, next_cursor=next_cursor),
    )


@router.post("/libraries", status_code=201)
def create_library(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a new non-default library.

    The viewer becomes the owner and admin of the new library.
    """
    result = library_governance.create_library(db, viewer.user_id, body.name)
    return ok(result, by_alias=True)


@router.get("/libraries/{library_id}")
def get_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a single library by ID.

    Viewer must be a member. Non-members get masked 404.
    """
    result = library_governance.get_library(db, viewer.user_id, library_id)
    return ok(result, by_alias=True)


@router.patch("/libraries/{library_id}")
def rename_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Rename a library.

    Only admins can rename libraries. Cannot rename default library.
    """
    result = library_governance.rename_library(db, viewer.user_id, library_id, body.name)
    return ok(result, by_alias=True)


@router.delete("/libraries/{library_id}", status_code=204)
def delete_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a library.

    Owner-only for non-default libraries. Non-owner admins get 403 E_OWNER_REQUIRED.
    """
    library_governance.delete_library(db, viewer.user_id, library_id)
    return Response(status_code=204)


# ---- Library-scoped Invites ----


@router.post("/libraries/{library_id}/invites", status_code=201)
def create_library_invite(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryInviteRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create an invitation to a library.

    Admin/owner only. Invitee must exist. Default library targets forbidden.
    """
    result = library_invitations.create_library_invite(
        db,
        viewer.user_id,
        library_id,
        body.invitee,
        body.role,
    )
    return ok(result, by_alias=True)


@router.get("/libraries/{library_id}/invites")
def list_library_invites(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    status: Annotated[
        LibraryInvitationStatusValue, Query(description="Filter by invite status")
    ] = "pending",
    limit: Annotated[int, Query(ge=1, description="Maximum results (clamped to 200)")] = 100,
) -> dict:
    """List invitations for a library.

    Admin/owner only. Ordered by created_at DESC, id DESC.
    """
    result = library_invitations.list_library_invites(
        db, viewer.user_id, library_id, status=status, limit=limit
    )
    return ok(result, by_alias=True)


# ---- Members ----


@router.get("/libraries/{library_id}/members")
def list_library_members(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
) -> dict:
    """List members of a library.

    Admin-only. Owner first, then admins, then members, then created_at ASC.
    """
    result = library_governance.list_library_members(db, viewer.user_id, library_id, limit=limit)
    return ok(result, by_alias=True)


@router.patch("/libraries/{library_id}/members/{user_handle}")
def update_library_member_role(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryMemberRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update a library member's role.

    Admin-only. Cannot change owner role.
    Default library forbidden.
    """
    try:
        user_id = unseal_user(user_handle)
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
    result = library_governance.update_library_member_role(
        db, viewer.user_id, library_id, user_id, body.role
    )
    return ok(result, by_alias=True)


@router.delete("/libraries/{library_id}/members/{user_handle}", status_code=204)
def remove_library_member(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a member from a library.

    Admin-only. Cannot remove owner.
    Default library forbidden. Idempotent for absent targets.
    """
    try:
        user_id = unseal_user(user_handle)
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
    library_governance.remove_library_member(db, viewer.user_id, library_id, user_id)
    return Response(status_code=204)


# ---- Ownership Transfer ----


@router.post("/libraries/{library_id}/transfer-ownership")
def transfer_library_ownership(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: TransferLibraryOwnershipRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Transfer library ownership to another member.

    Owner-only. Target must be existing member. Previous owner stays admin.
    Default library forbidden.
    """
    try:
        new_owner_user_id = unseal_user(body.new_owner_user_handle)
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
    result = library_governance.transfer_library_ownership(
        db,
        viewer.user_id,
        library_id,
        new_owner_user_id,
    )
    return ok(result, by_alias=True)


# ---- Library Entries ----


@router.get("/libraries/{library_id}/entries")
def list_library_entries(
    request: Request,
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List a library's entries under a view lens.

    Returns one mixed list of podcasts and media. Canonical order (sort omitted)
    is Default's `media.created_at DESC` or the physical position order;
    ``sort=title|creator|published|added`` with a ``direction`` and an optional
    ``completion=unfinished`` select a factual view. The whole query is parsed
    strictly (see ``library_entries.parse_entries_query``).
    """
    view, limit, cursor = library_entries.parse_entries_query(request.query_params.multi_items())
    result, page = library_entries.list_library_entries(
        db,
        viewer.user_id,
        library_id,
        view=view,
        limit=limit,
        cursor=cursor,
    )
    return ok_page(result, page, by_alias=True)


@router.get("/libraries/{library_id}/slate")
def get_library_slate(
    request: Request,
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Reading Slate does not accept query parameters",
        )
    slate = resonance_service.build_library_slate(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    return ok(slate, by_alias=True)


@router.patch("/libraries/{library_id}/entries/reorder", status_code=204)
def patch_library_entry_order(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: LibraryEntryOrderRequest,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Replace full entry ordering for a library."""
    library_entries.reorder_entries(db, viewer.user_id, library_id, body)
    return Response(status_code=204)


@router.post("/libraries/{library_id}/podcasts", status_code=204)
def add_podcast_to_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: AddPodcastRequest,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Add a subscribed podcast reference to a non-default library."""
    library_entries.add_podcast_to_library(db, viewer.user_id, library_id, body.podcast_id)
    return Response(status_code=204)


@router.delete("/libraries/{library_id}/podcasts/{podcast_id}", status_code=204)
def remove_podcast_from_library(
    library_id: UUID,
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a podcast reference from one non-default library."""
    library_entries.remove_podcast_from_library(db, viewer.user_id, library_id, podcast_id)
    return Response(status_code=204)
