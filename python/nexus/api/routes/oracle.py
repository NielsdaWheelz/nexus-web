"""Black Forest Oracle REST routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_session_factory
from nexus.responses import ok
from nexus.schemas.oracle import (
    OracleReadingCreateRequest,
    OracleReadingCreateResponse,
    OracleStreamConnectionOut,
)
from nexus.services import oracle as oracle_service
from nexus.services import oracle_plates
from nexus.services.image_proxy import etags_match
from nexus.services.stream_tokens import mint_stream_token

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
    stream_base_url = stream_token.stream_base_url
    response = OracleReadingCreateResponse(
        reading_id=reading.id,
        folio_number=reading.folio_number,
        status=reading.status,
        stream=OracleStreamConnectionOut(
            token=stream_token.token,
            stream_base_url=stream_base_url,
            event_url=f"{stream_base_url}/stream/oracle-readings/{reading.id}/events",
            expires_at=stream_token.expires_at,
        ),
    )
    return ok(response)


@router.get("/oracle/readings")
def list_oracle_readings(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = oracle_service.list_all_readings(db, viewer_id=viewer.user_id)
    return ok(rows)


@router.get("/oracle/readings/{reading_id}/concordance")
def get_oracle_reading_concordance(
    reading_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    entries = oracle_service.compute_concordance(
        db, viewer_id=viewer.user_id, reading_id=reading_id
    )
    return ok(entries)


@router.get("/oracle/readings/{reading_id}")
def get_oracle_reading(
    reading_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    detail = oracle_service.get_reading_detail(db, viewer_id=viewer.user_id, reading_id=reading_id)
    return ok(detail)


@router.get("/oracle/plates/{image_id}")
def get_oracle_plate(image_id: UUID, request: Request) -> Response:
    inm = request.headers.get("If-None-Match")
    metadata = oracle_plates.get_oracle_plate_metadata(
        session_factory=get_session_factory(), image_id=image_id
    )
    if inm and etags_match(inm, metadata.etag):
        return Response(status_code=304, headers={"ETag": metadata.etag})
    plate = oracle_plates.read_oracle_plate_bytes(metadata)
    return Response(
        content=plate.data,
        media_type=plate.content_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Length": str(plate.byte_size),
            "X-Content-Type-Options": "nosniff",
            "ETag": plate.etag,
        },
    )
