"""Lectern + consumption command ports (spec §5).

Transport-only: decode the strict camelCase command, call the consumption
service facade (which owns the fresh session, replay, and transaction), and
return the ``ok()`` envelope. GET uses the request-scoped read boundary.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.consumption import (
    ConsumptionCommand,
    LecternCommand,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.resonance import service as resonance_service

router = APIRouter(tags=["lectern"])


@router.get("/lectern/slate")
def get_lectern_slate(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Reading Slate does not accept query parameters",
        )
    slate = resonance_service.build_lectern_slate(db, viewer_id=viewer.user_id)
    return ok(slate, by_alias=True)


@router.get("/lectern")
def get_lectern(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    snapshot = consumption_service.get_lectern(db, viewer.user_id)
    return ok(snapshot, by_alias=True)


@router.post("/lectern/commands")
def post_lectern_command(
    command: LecternCommand,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    result = consumption_service.run_lectern_command(viewer.user_id, command)
    return ok(result, by_alias=True)


@router.post("/consumption/commands")
def post_consumption_command(
    command: ConsumptionCommand,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    result = consumption_service.run_consumption_command(viewer.user_id, command)
    return ok(result, by_alias=True)
