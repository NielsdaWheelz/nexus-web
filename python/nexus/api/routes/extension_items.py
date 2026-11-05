"""Saved-item controls behind the extension bearer; domain writers stay shared with the app."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.library import LibraryPlacementOut, PlaceItemRequest
from nexus.schemas.media import ExtensionItemOut, MediaRemovalPreviewOut, RemoveMediaRequest
from nexus.services import library_entries, media, media_deletion

router = APIRouter(prefix="/extension", tags=["extension"])
ExtensionViewer = Annotated[Viewer, Depends(get_extension_viewer)]
_KINDS = frozenset({"web_article", "pdf", "epub"})


@router.get("/items/{media_id}")
def get_item(
    media_id: UUID, viewer: ExtensionViewer, db: RepeatableReadDbSession
) -> Data[ExtensionItemOut]:
    return Data(data=media.get_extension_item(db, viewer.user_id, media_id))


@router.put("/libraries/{library_id}/items/{ref}")
def set_item_library(
    library_id: UUID, ref: str, body: PlaceItemRequest, viewer: ExtensionViewer, db: DbSession
) -> Data[LibraryPlacementOut]:
    target = library_entries.parse_entry_target(ref)
    return Data(
        data=library_entries.set_item(
            db,
            viewer.user_id,
            library_id,
            target,
            included=body.included,
            expected_order_revision=int(body.expected_order_revision),
            expected_removal_revision=None
            if body.expected_removal_revision is None
            else int(body.expected_removal_revision),
            allowed_kinds=_KINDS,
        )
    )


@router.get("/items/{media_id}/removal-preview")
def removal_preview(
    media_id: UUID, viewer: ExtensionViewer, db: RepeatableReadDbSession
) -> Data[MediaRemovalPreviewOut]:
    media.require_extension_media_kind(db, viewer.user_id, media_id)
    return Data(data=media_deletion.media_removal_preview(db, viewer.user_id, media_id))


@router.delete("/items/{media_id}", status_code=204)
def remove_item(
    media_id: UUID, body: RemoveMediaRequest, viewer: ExtensionViewer, db: DbSession
) -> Response:
    media_deletion.remove_media_for_viewer(
        db,
        viewer.user_id,
        media_id,
        expected_acquisition_revision=int(body.expected_acquisition_revision),
        allowed_kinds=_KINDS,
    )
    return Response(status_code=204)
