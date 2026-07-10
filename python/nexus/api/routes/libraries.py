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
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, ok_page
from nexus.schemas.library import (
    AddMediaRequest,
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
    return ok(result)


@router.post("/libraries/invites/{invite_id}/accept")
def accept_library_invite(
    invite_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Accept a library invitation.

    Invitee-only. Transactionally creates membership and upserts backfill job.
    Idempotent when already accepted.
    """
    result = library_invitations.accept_library_invite(db, viewer.user_id, invite_id)
    return ok(result)


@router.post("/libraries/invites/{invite_id}/decline")
def decline_library_invite(
    invite_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Decline a library invitation.

    Invitee-only. Idempotent when already declined.
    """
    result = library_invitations.decline_library_invite(db, viewer.user_id, invite_id)
    return ok(result)


@router.delete("/libraries/invites/{invite_id}", status_code=204)
def revoke_library_invite(
    invite_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Revoke a pending library invitation.

    Admin/owner of the invite's library only. Idempotent when already revoked.
    """
    library_invitations.revoke_library_invite(db, viewer.user_id, invite_id)
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
    return ok_page(result, page)


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
    return ok(result)


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
    return ok(result)


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
    return ok(result)


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
        body.invitee_user_id,
        body.role,
        invitee_email=body.invitee_email,
    )
    return ok(result)


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
    return ok(result)


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
    return ok(result)


@router.patch("/libraries/{library_id}/members/{user_id}")
def update_library_member_role(
    library_id: UUID,
    user_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryMemberRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update a library member's role.

    Admin-only. Cannot change owner role.
    Default library forbidden.
    """
    result = library_governance.update_library_member_role(
        db, viewer.user_id, library_id, user_id, body.role
    )
    return ok(result)


@router.delete("/libraries/{library_id}/members/{user_id}", status_code=204)
def remove_library_member(
    library_id: UUID,
    user_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a member from a library.

    Admin-only. Cannot remove owner.
    Default library forbidden. Idempotent for absent targets.
    """
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
    result = library_governance.transfer_library_ownership(
        db, viewer.user_id, library_id, body.new_owner_user_id
    )
    return ok(result)


# ---- Library Entries ----


@router.get("/libraries/{library_id}/entries")
def list_library_entries(
    request: Request,
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    sort: Annotated[
        library_entries.LibraryEntrySort,
        Query(description="Entry ordering: 'position' (default) or 'resonance'"),
    ] = "position",
    viewer_tz: Annotated[
        str,
        Query(
            max_length=128,
            description="IANA timezone used for the surfaced-today boundary",
        ),
    ] = "UTC",
) -> dict:
    """List ordered entries in a library.

    Returns one mixed list of podcasts and media. ``sort='position'`` (default)
    orders by entry position ASC; ``sort='resonance'`` applies the deterministic
    recency + connection-count score (no request-time LLM).
    """
    if "offset" in request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "offset pagination is not supported for library entries",
        )
    result, page = library_entries.list_library_entries(
        db,
        viewer.user_id,
        library_id,
        limit=limit,
        cursor=cursor,
        sort=sort,
        viewer_timezone=viewer_tz,
    )
    return ok_page(result, page)


@router.patch("/libraries/{library_id}/entries/reorder")
def patch_library_entry_order(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: LibraryEntryOrderRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Replace full entry ordering for a library."""
    result = library_entries.reorder_entries(db, viewer.user_id, library_id, body)
    return ok(result)


@router.post("/libraries/{library_id}/media", status_code=201)
def add_media_to_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: AddMediaRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Add media to a library.

    Only admins can add media. Enforces default library closure.
    """
    result = library_entries.add_media_to_library(db, viewer.user_id, library_id, body.media_id)
    return ok(result)


@router.post("/libraries/{library_id}/podcasts", status_code=201)
def add_podcast_to_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: AddPodcastRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Add a subscribed podcast reference to a non-default library."""
    result = library_entries.add_podcast_to_library(db, viewer.user_id, library_id, body.podcast_id)
    return ok(result)


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
