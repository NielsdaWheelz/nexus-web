"""Library routes: transport only.

Static `/libraries/invites*` routes MUST stay registered before
`/libraries/{library_id}` or FastAPI captures `invites` as a UUID path param.
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
    CreateLibraryInviteRequest,
    CreateLibraryRequest,
    LibraryEntryOrderRequest,
    LibraryInvitationStatusValue,
    LibraryPageInfo,
    TransferLibraryOwnershipRequest,
    UpdateLibraryMemberRequest,
    UpdateLibraryRequest,
)
from nexus.services import (
    library_entries,
    library_entry_listing,
    library_governance,
    library_sharing,
)
from nexus.services.resonance import service as resonance_service
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
    db: Annotated[Session, Depends(get_db)],
    status: Annotated[LibraryInvitationStatusValue, _STATUS_QUERY] = "pending",
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> dict:
    """List invitations addressed to the current viewer."""
    result = library_sharing.list_viewer_invites(db, viewer.user_id, status=status, limit=limit)
    return ok(result, by_alias=True)


@router.post("/libraries/invites/{invitation_handle}/accept")
def accept_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Accept a library invitation. Invitee-only; idempotent when already accepted."""
    result = library_sharing.accept_library_invite(db, viewer.user_id, invitation_handle)
    return ok(result, by_alias=True)


@router.post("/libraries/invites/{invitation_handle}/decline")
def decline_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Decline a library invitation. Invitee-only; idempotent when already declined."""
    result = library_sharing.decline_library_invite(db, viewer.user_id, invitation_handle)
    return ok(result, by_alias=True)


@router.delete("/libraries/invites/{invitation_handle}", status_code=204)
def revoke_library_invite(
    invitation_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Revoke a pending invitation. Admin-only; idempotent when already revoked."""
    library_sharing.revoke_library_invite(db, viewer.user_id, invitation_handle)
    return Response(status_code=204)


@router.get("/libraries")
def list_libraries(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List the viewer's libraries in the requested view."""
    view, query = library_governance.parse_libraries_index_query(request.query_params.multi_items())
    page = library_governance.list_libraries(
        db,
        viewer.user_id,
        view=view,
        cursor=query.cursor,
        collection_revision=query.collection_revision,
        limit=query.limit,
    )
    return ok(page, by_alias=True)


@router.get("/libraries/writable-destinations")
def list_writable_library_destinations(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str | None = Query(default=None, max_length=100, description="Name search query"),
    cursor: Annotated[str | None, _CURSOR_QUERY] = None,
    limit: int = Query(default=25, ge=1, le=50, description="Maximum results"),
) -> dict:
    """Rank the named libraries the viewer may file into."""
    result, next_cursor = library_governance.list_writable_library_destinations(
        db, viewer.user_id, q=(q or "").strip().lower(), cursor=cursor, limit=limit
    )
    return ok_page(
        result, LibraryPageInfo(has_more=next_cursor is not None, next_cursor=next_cursor)
    )


@router.get("/podcasts/{podcast_id}/libraries")
def get_podcast_libraries(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read the canonical library placement inventory for one podcast."""
    rows = library_entries.list_item_libraries(
        db, viewer_id=viewer.user_id, target=library_entries.podcast_target(podcast_id)
    )
    return ok(rows, by_alias=True)


@router.post("/libraries", status_code=201)
def create_library(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a non-default library owned and admin'd by the caller."""
    return ok(library_governance.create_library(db, viewer.user_id, body), by_alias=True)


@router.get("/libraries/{library_id}")
def get_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read one library. Non-members get a masked 404."""
    return ok(library_governance.get_library(db, viewer.user_id, library_id), by_alias=True)


@router.patch("/libraries/{library_id}")
def rename_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Rename a library. Admin-only; not the default or a system library."""
    result = library_governance.rename_library(db, viewer.user_id, library_id, body.name)
    return ok(result, by_alias=True)


@router.delete("/libraries/{library_id}")
def delete_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Delete a library. Owner-only; a non-owner admin gets E_OWNER_REQUIRED."""
    return ok(library_governance.delete_library(db, viewer.user_id, library_id), by_alias=True)


@router.post("/libraries/{library_id}/invites", status_code=201)
def create_library_invite(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryInviteRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Invite an existing user to a library. Admin-only."""
    result = library_sharing.create_library_invite(
        db, viewer.user_id, library_id, body.invitee, body.role
    )
    return ok(result, by_alias=True)


@router.get("/libraries/{library_id}/invites")
def list_library_invites(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    status: Annotated[LibraryInvitationStatusValue, _STATUS_QUERY] = "pending",
    cursor: Annotated[str | None, _CURSOR_QUERY] = None,
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> dict:
    """List a library's invitations, newest first. Admin-only."""
    result, page = library_sharing.list_library_invites(
        db, viewer.user_id, library_id, status=status, cursor=cursor, limit=limit
    )
    return ok_page(result, page, by_alias=True)


@router.get("/libraries/{library_id}/members")
def list_library_members(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    cursor: Annotated[str | None, _CURSOR_QUERY] = None,
    limit: Annotated[int, _LIMIT_QUERY] = 100,
) -> dict:
    """List a library's members by immutable member identity. Admin-only."""
    result, page = library_sharing.list_library_members(
        db, viewer.user_id, library_id, cursor=cursor, limit=limit
    )
    return ok_page(result, page, by_alias=True)


@router.patch("/libraries/{library_id}/members/{user_handle}")
def update_library_member_role(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryMemberRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Set a member's role. Admin-only; the owner's role is fixed."""
    result = library_sharing.update_library_member_role(
        db, viewer.user_id, library_id, _user_id(user_handle), body.role
    )
    return ok(result, by_alias=True)


@router.delete("/libraries/{library_id}/members/{user_handle}", status_code=204)
def remove_library_member(
    library_id: UUID,
    user_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a member. Admin-only; idempotent for an absent target."""
    library_sharing.remove_library_member(db, viewer.user_id, library_id, _user_id(user_handle))
    return Response(status_code=204)


@router.post("/libraries/{library_id}/transfer-ownership")
def transfer_library_ownership(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: TransferLibraryOwnershipRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Transfer ownership to another member. Owner-only."""
    result = library_sharing.transfer_library_ownership(
        db, viewer.user_id, library_id, _user_id(body.new_owner_user_handle)
    )
    return ok(result, by_alias=True)


@router.get("/libraries/{library_id}/entries")
def list_library_entries(
    request: Request,
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List a library's entries under a view lens (see `parse_entries_query`)."""
    view, query = library_entry_listing.parse_entries_query(request.query_params.multi_items())
    page = library_entry_listing.list_library_entries(
        db,
        viewer.user_id,
        library_id,
        view=view,
        limit=query.limit,
        cursor=query.cursor,
        collection_revision=query.collection_revision,
    )
    return ok(page, by_alias=True)


@router.get("/libraries/{library_id}/slate")
def get_library_slate(
    request: Request,
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """Read the library's Reading Slate."""
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Reading Slate does not accept query parameters"
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
    """Replace the full entry ordering for a library."""
    library_entries.reorder_entries(db, viewer.user_id, library_id, body)
    return Response(status_code=204)


@router.delete("/libraries/{library_id}/podcasts/{podcast_id}")
def remove_podcast_from_library(
    library_id: UUID,
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Remove a podcast reference from one non-default library."""
    result = library_entries.remove_podcast_from_library(db, viewer.user_id, library_id, podcast_id)
    return ok(result, by_alias=True)


@router.put("/libraries/{library_id}/podcasts/{podcast_id}")
def add_subscribed_podcast_to_library(
    library_id: UUID,
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Place an existing active podcast subscription in one named library."""
    result = library_entries.place_subscribed_podcast_in_named_library(
        db, viewer.user_id, library_id, podcast_id
    )
    return ok(result, by_alias=True)
