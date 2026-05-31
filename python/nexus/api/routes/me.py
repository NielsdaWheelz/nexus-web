"""Current user endpoint.

Returns information about the authenticated viewer including profile fields.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.models import WorkspaceSession
from nexus.db.session import get_db
from nexus.responses import success_response
from nexus.schemas.command_palette import CommandPaletteSelectionRecordRequest
from nexus.schemas.reader import ReaderProfilePatch
from nexus.schemas.user import UpdateProfileRequest
from nexus.schemas.workspace_session import WorkspaceSessionPutRequest
from nexus.services import command_palette as command_palette_service
from nexus.services import reader as reader_service
from nexus.services import users as users_service
from nexus.services import workspace_sessions as workspace_sessions_service

router = APIRouter()


def _workspace_session_payload(session: WorkspaceSession | None) -> dict | None:
    """Shape a workspace session row for the API, or None when absent."""
    if session is None:
        return None
    return {"state": session.state, "updated_at": session.updated_at.isoformat()}


@router.get("/me")
def get_me(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get current user information.

    Requires authentication. Returns the authenticated user's ID,
    default library ID, email, and display name.
    """
    profile = users_service.get_user_profile(
        db, viewer.user_id, viewer.default_library_id, viewer.email
    )
    return success_response(profile.model_dump(mode="json"))


@router.patch("/me")
def patch_me(
    body: UpdateProfileRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update user profile (display_name)."""
    users_service.update_display_name(db, viewer.user_id, body.display_name)
    profile = users_service.get_user_profile(
        db, viewer.user_id, viewer.default_library_id, viewer.email
    )
    return success_response(profile.model_dump(mode="json"))


@router.get("/me/reader-profile")
def get_reader_profile(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get reader profile (per-user defaults). Returns defaults when none exists."""
    result = reader_service.get_reader_profile(db, viewer.user_id)
    return success_response(result.model_dump(mode="json"))


@router.patch("/me/reader-profile")
def patch_reader_profile(
    body: ReaderProfilePatch,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update reader profile (partial)."""
    result = reader_service.patch_reader_profile(db, viewer.user_id, body)
    return success_response(result.model_dump(mode="json"))


@router.get("/me/palette-history")
def get_palette_history(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    query: Annotated[str | None, Query(max_length=500)] = None,
) -> dict:
    """Get command palette usage history for the current viewer."""
    result = command_palette_service.get_history_for_viewer(db, viewer.user_id, query=query)
    return success_response(result.model_dump(mode="json"))


@router.post("/me/palette-selections")
def post_palette_selection(
    body: CommandPaletteSelectionRecordRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Record one accepted command palette selection for the current viewer."""
    result = command_palette_service.record_selection_for_viewer(
        db,
        viewer.user_id,
        query=body.query,
        target_key=body.target_key,
        target_kind=body.target_kind,
        target_href=body.target_href,
        title_snapshot=body.title_snapshot,
        source=body.source,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/me/workspace-session")
def get_workspace_session(
    device_id: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get this device's own workspace session and the most recent one elsewhere."""
    own = workspace_sessions_service.get_workspace_session(db, viewer.user_id, device_id)
    other = workspace_sessions_service.get_most_recent_session_elsewhere(
        db, viewer.user_id, device_id
    )
    return success_response(
        {
            "own": _workspace_session_payload(own),
            "most_recent_elsewhere": _workspace_session_payload(other),
        }
    )


@router.put("/me/workspace-session")
def put_workspace_session(
    body: WorkspaceSessionPutRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Upsert this device's workspace session (last-write-wins)."""
    result = workspace_sessions_service.upsert_workspace_session(
        db, viewer.user_id, body.device_id, body.state
    )
    return success_response(_workspace_session_payload(result))
