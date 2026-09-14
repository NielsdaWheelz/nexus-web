"""Black Forest Oracle REST routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_session_factory
from nexus.responses import ok
from nexus.schemas.oracle import (
    OracleCorpusStatusOut,
    OracleReadingCreateRequest,
    OracleReadingCreateResponse,
)
from nexus.services import oracle as oracle_service
from nexus.services import oracle_corpus, oracle_plates
from nexus.services.image_proxy import etags_match

router = APIRouter(tags=["oracle"])


@router.post("/oracle/readings", status_code=200)
def create_oracle_reading(
    body: OracleReadingCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[
        str | None, Header(alias="Idempotency-Key", min_length=1, max_length=256)
    ] = None,
) -> dict:
    reading = oracle_service.create_reading(
        db,
        viewer_id=viewer.user_id,
        question=body.question,
        idempotency_key=idempotency_key,
    )
    return ok(
        OracleReadingCreateResponse(
            reading_id=reading.id,
            folio_number=reading.folio_number,
            status=reading.status,
        )
    )


@router.get("/oracle/readings")
def list_oracle_readings(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = oracle_service.list_all_readings(db, viewer_id=viewer.user_id)
    return ok(rows)


@router.get("/oracle/corpus")
def get_oracle_corpus_status(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    r = oracle_corpus.get_oracle_corpus_readiness(db)
    library_ref = f"library:{r.library_id}" if r.library_id else None
    return ok(
        OracleCorpusStatusOut(
            library_ref=library_ref,
            library_id=r.library_id,
            status=r.status,
            work_count=r.work_count,
            ready_media_count=r.ready_media_count,
            anchor_count=r.anchor_count,
            resolved_anchor_count=r.resolved_anchor_count,
            plate_count=r.plate_count,
            ready_plate_count=r.ready_plate_count,
        )
    )


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
