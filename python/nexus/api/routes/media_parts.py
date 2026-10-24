"""Piece command transport; domain owners retain transactions and retry semantics."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data, DataPage
from nexus.schemas.media_parts import (
    CandidateReceipt,
    PartCandidateDecision,
    PartCreate,
    PartDefinition,
    PartDiscovery,
    PartListRow,
    PartOperation,
    PartPage,
    PartPrepare,
    PartPreview,
    PartReceipt,
    PartUpdate,
)
from nexus.schemas.media_sources import SearchRepairAdmission
from nexus.schemas.reader import MediaNavigationOut
from nexus.schemas.reader_document import ReaderPartDocumentOut
from nexus.services import content_indexing, media_parts, part_discovery
from nexus.services.reader_navigation import get_media_navigation_for_viewer

router = APIRouter(tags=["media"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/media/{source_media_id}/parts")
def list_parts(
    source_media_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> DataPage[PartListRow, PartPage]:
    rows, page = media_parts.list_parts(
        db, viewer_id=viewer.user_id, source_media_id=source_media_id, limit=limit, cursor=cursor
    )
    return DataPage(data=rows, page=page)


@router.post("/media/{source_media_id}/parts")
def create_part(
    source_media_id: UUID, body: PartCreate, viewer: ViewerDep, db: DbSession
) -> Data[PartReceipt]:
    return Data(
        data=media_parts.create_part(
            db, viewer_id=viewer.user_id, source_media_id=source_media_id, request=body
        )
    )


@router.get("/media/{media_id}/part")
def get_part(
    media_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[PartDefinition]:
    return Data(
        data=media_parts.get_part_definition(db, viewer_id=viewer.user_id, media_id=media_id)
    )


@router.put("/media/{media_id}/part")
def update_part(
    media_id: UUID, body: PartUpdate, viewer: ViewerDep, db: DbSession
) -> Data[PartReceipt]:
    return Data(
        data=media_parts.update_part(db, viewer_id=viewer.user_id, media_id=media_id, request=body)
    )


@router.put("/media/{source_media_id}/part-candidates/{candidate_id}")
def decide_candidate(
    source_media_id: UUID,
    candidate_id: UUID,
    body: PartCandidateDecision,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[CandidateReceipt]:
    return Data(
        data=media_parts.decide_candidate(
            db,
            viewer_id=viewer.user_id,
            source_media_id=source_media_id,
            candidate_id=candidate_id,
            request=body,
        )
    )


@router.post("/media/{source_media_id}/parts/preview")
def preview_part(
    source_media_id: UUID, body: PartPreview, viewer: ViewerDep, db: DbSession
) -> Data[ReaderPartDocumentOut]:
    return Data(
        data=media_parts.preview_part(
            db, viewer_id=viewer.user_id, source_media_id=source_media_id, request=body
        )
    )


@router.post("/media/{source_media_id}/parts/prepare")
def prepare_parts(
    source_media_id: UUID, body: PartPrepare, viewer: ViewerDep, db: DbSession
) -> Data[SearchRepairAdmission]:
    return Data(
        data=content_indexing.prepare_media_parts(
            db, viewer_id=viewer.user_id, source_media_id=source_media_id, request=body
        )
    )


@router.post("/media/{source_media_id}/part-discovery", status_code=202)
def discover_parts(
    source_media_id: UUID, body: PartDiscovery, viewer: ViewerDep, db: DbSession
) -> Data[PartOperation]:
    return Data(
        data=part_discovery.discover_parts(
            db, viewer_id=viewer.user_id, source_media_id=source_media_id, request=body
        )
    )


@router.get("/media/{media_id}/navigation")
def get_navigation(
    media_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[MediaNavigationOut]:
    return Data(
        data=get_media_navigation_for_viewer(db, viewer_id=viewer.user_id, media_id=media_id)
    )
