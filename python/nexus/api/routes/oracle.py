"""Black Forest Oracle REST routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.stream_token import mint_stream_token
from nexus.responses import success_response
from nexus.schemas.oracle import (
    OracleReadingCreateRequest,
    OracleReadingCreateResponse,
    OracleStreamConnectionOut,
)
from nexus.services import oracle as oracle_service

router = APIRouter(tags=["oracle"])


@router.post("/oracle/readings", status_code=200)
def create_oracle_reading(
    body: OracleReadingCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    reading = oracle_service.create_reading(
        db,
        viewer_id=viewer.user_id,
        question=body.question,
    )
    stream_token = mint_stream_token(viewer.user_id)
    stream_base_url = str(stream_token["stream_base_url"]).rstrip("/")
    response = OracleReadingCreateResponse(
        reading_id=reading.id,
        folio_number=reading.folio_number,
        status=reading.status,
        stream=OracleStreamConnectionOut(
            token=str(stream_token["token"]),
            stream_base_url=stream_base_url,
            event_url=f"{stream_base_url}/stream/oracle-readings/{reading.id}/events",
            expires_at=str(stream_token["expires_at"]),
        ),
    )
    return success_response(response.model_dump(mode="json"))


@router.get("/oracle/readings")
def list_oracle_readings(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = oracle_service.list_recent_readings(db, viewer_id=viewer.user_id)
    return success_response([row.model_dump(mode="json") for row in rows])


@router.get("/oracle/readings/{reading_id}")
def get_oracle_reading(
    reading_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    detail = oracle_service.get_reading_detail(db, viewer_id=viewer.user_id, reading_id=reading_id)
    return success_response(detail.model_dump(mode="json"))
