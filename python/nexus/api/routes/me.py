"""Current user endpoint.

Returns information about the authenticated viewer including profile fields.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.config import Settings, get_settings
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.nexus_history import (
    NexusHistoryOut,
    NexusSelectionRecordOut,
    NexusSelectionRecordRequest,
)
from nexus.schemas.reader import ReaderProfileOut, ReaderProfilePatch
from nexus.schemas.user import UpdateProfileRequest, UserProfileOut
from nexus.schemas.workspace_session import (
    DEVICE_ID_MAX_LENGTH,
    WorkspaceSessionsOut,
    WorkspaceState,
)
from nexus.services import nexus_history as nexus_history_service
from nexus.services import reader_profile as reader_profile_service
from nexus.services import users as users_service
from nexus.services import workspace_sessions as workspace_sessions_service

router = APIRouter(tags=["user"])


@router.get("/me")
def get_me(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
) -> Data[UserProfileOut]:
    """Get current user information.

    Requires authentication. Returns the authenticated user's ID,
    default library ID, email, display name, and the Post Room ingest address
    when configured.
    """
    profile = users_service.get_user_profile(
        db, viewer.user_id, viewer.default_library_id, viewer.email
    )
    if (
        settings.email_ingest_enabled
        and settings.email_ingest_address_slug
        and settings.email_ingest_domain
    ):
        profile.email_ingest_address = (
            f"{settings.email_ingest_address_slug}@{settings.email_ingest_domain}"
        )
    return Data(data=profile)


@router.patch("/me")
def patch_me(
    body: UpdateProfileRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[UserProfileOut]:
    """Update supplied user profile fields."""
    users_service.update_user_profile(db, viewer.user_id, body)
    return Data(
        data=users_service.get_user_profile(
            db, viewer.user_id, viewer.default_library_id, viewer.email
        )
    )


@router.get("/me/reader-profile")
def get_reader_profile(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[ReaderProfileOut]:
    """Get reader profile (per-user defaults). Returns defaults when none exists."""
    return Data(data=reader_profile_service.get_reader_profile(db, viewer.user_id))


@router.patch("/me/reader-profile")
def patch_reader_profile(
    body: ReaderProfilePatch,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[ReaderProfileOut]:
    """Update reader profile (partial)."""
    return Data(data=reader_profile_service.patch_reader_profile(db, viewer.user_id, body))


@router.get("/me/nexus-history")
def get_nexus_history(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    query: Annotated[str | None, Query(max_length=500)] = None,
) -> Data[NexusHistoryOut]:
    """Get Nexus usage history for the current viewer."""
    return Data(data=nexus_history_service.get_history_for_viewer(db, viewer.user_id, query))


@router.post("/me/nexus-selections")
def post_nexus_selection(
    body: NexusSelectionRecordRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[NexusSelectionRecordOut]:
    """Record one accepted internal Nexus selection for the current viewer."""
    return Data(
        data=nexus_history_service.record_selection_for_viewer(db, viewer.user_id, request=body)
    )


DeviceId = Annotated[str, Query(min_length=1, max_length=DEVICE_ID_MAX_LENGTH)]


@router.get("/me/workspace-session")
def get_workspace_session(
    device_id: DeviceId, viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession
) -> Data[WorkspaceSessionsOut]:
    """This device's own workspace session and the newest one saved elsewhere."""
    return Data(
        data=workspace_sessions_service.get_workspace_sessions(db, viewer.user_id, device_id)
    )


@router.put("/me/workspace-session", status_code=204)
def put_workspace_session(
    device_id: DeviceId,
    state: WorkspaceState,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> None:
    """Replace this device's workspace session (last write wins)."""
    workspace_sessions_service.put_workspace_session(db, viewer.user_id, device_id, state)
