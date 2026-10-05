"""Lectern + consumption command ports (spec §5).

Transport-only: decode the strict camelCase command, call the consumption
service facade (which owns the fresh session, replay, and transaction), and
return the typed data envelope. GET uses the request-scoped read boundary.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.consumption import (
    ConsumptionCommand,
    ConsumptionResult,
    LecternCommand,
    LecternResult,
    LecternSnapshot,
)
from nexus.schemas.resonance import QuickReadsOut, SlateOut
from nexus.services import resonance as resonance_service
from nexus.services.consumption import service as consumption_service

router = APIRouter(tags=["lectern"])


@router.get("/lectern/slate")
def get_lectern_slate(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[SlateOut]:
    slate = resonance_service.build_lectern_slate(db, viewer_id=viewer.user_id)
    return Data(data=slate)


@router.get("/lectern/quick-reads")
def get_quick_reads(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[QuickReadsOut]:
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Quick reads does not accept query parameters"
        )
    quick_reads = resonance_service.build_quick_reads(db, viewer_id=viewer.user_id)
    return Data(data=quick_reads)


@router.get("/lectern")
def get_lectern(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[LecternSnapshot]:
    snapshot = consumption_service.get_lectern(db, viewer.user_id)
    return Data(data=snapshot)


@router.post("/lectern/commands")
def post_lectern_command(
    command: LecternCommand,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Data[LecternResult]:
    result = consumption_service.run_lectern_command(viewer.user_id, command)
    return Data(data=result)


@router.post("/consumption/commands")
def post_consumption_command(
    command: ConsumptionCommand,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Data[ConsumptionResult]:
    result = consumption_service.run_consumption_command(viewer.user_id, command)
    return Data(data=result)
