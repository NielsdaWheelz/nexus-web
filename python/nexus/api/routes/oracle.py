"""Black Forest Oracle REST routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, get_session_factory
from nexus.responses import ok
from nexus.schemas.oracle import OracleReadingCreateRequest, OracleReadingCreateResponse
from nexus.services import oracle as oracle_service
from nexus.services import oracle_plates

router = APIRouter(tags=["oracle"])


@router.post("/oracle/readings", status_code=200)
def create_oracle_reading(
    body: OracleReadingCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
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
    # justify-defect: creation and job enqueue are one transaction; this route
    # can only return the newly-created pending representation.
    if reading.status != "pending":
        raise AssertionError("new Oracle reading is not pending")
    return ok(
        OracleReadingCreateResponse(
            reading_id=reading.id,
            folio_number=reading.folio_number,
            status="pending",
        )
    )


@router.get("/oracle/readings")
def list_oracle_readings(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    rows = oracle_service.list_all_readings(db, viewer_id=viewer.user_id)
    return ok(rows)


@router.get("/oracle/readings/{reading_id}/concordance")
def get_oracle_reading_concordance(
    reading_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    entries = oracle_service.compute_concordance(
        db, viewer_id=viewer.user_id, reading_id=reading_id
    )
    return ok(entries)


@router.get("/oracle/readings/{reading_id}")
def get_oracle_reading(
    reading_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    detail = oracle_service.get_reading_detail(db, viewer_id=viewer.user_id, reading_id=reading_id)
    return ok(detail)


@router.get("/oracle/plates/{image_id}")
def get_oracle_plate(image_id: UUID, request: Request) -> Response:
    inm = request.headers.get("If-None-Match")
    metadata = oracle_plates.get_oracle_plate_metadata(
        session_factory=get_session_factory(), image_id=image_id
    )
    if inm and _etags_match(inm, metadata.etag):
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


def _etags_match(if_none_match: str, cached_etag: str) -> bool:
    """Match an ``If-None-Match`` header against a stored ETag.

    Handles comma-separated lists, the ``W/`` weak prefix, quoting, and ``*``.
    """
    stored = cached_etag.strip('"')
    for raw in if_none_match.split(","):
        tag = raw.strip().removeprefix("W/").strip('"')
        if tag == stored or tag == "*":
            return True
    return False
