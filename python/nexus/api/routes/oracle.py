"""The oracle HTTP surface: ask, list, read, concordance. Plates are static web assets."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.oracle import (
    OracleConcordanceOut,
    OracleReadingCreatedOut,
    OracleReadingCreateRequest,
    OracleReadingOut,
    OracleReadingSummaryOut,
)
from nexus.services.oracle import readings

router = APIRouter(tags=["oracle"])
CurrentViewer = Annotated[Viewer, Depends(get_viewer)]


@router.post("/oracle/readings")
def create_oracle_reading(
    body: OracleReadingCreateRequest,
    viewer: CurrentViewer,
    db: DbSession,
    key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)],
) -> Data[OracleReadingCreatedOut]:
    return Data(
        data=readings.create_reading(db, viewer_id=viewer.user_id, question=body.question, key=key)
    )


@router.get("/oracle/readings")
def list_oracle_readings(
    viewer: CurrentViewer, db: DbSession
) -> Data[list[OracleReadingSummaryOut]]:
    return Data(data=readings.list_readings(db, viewer_id=viewer.user_id))


@router.get("/oracle/readings/{reading_id}")
def get_oracle_reading(
    reading_id: UUID, viewer: CurrentViewer, db: DbSession
) -> Data[OracleReadingOut]:
    return Data(data=readings.get_reading(db, viewer_id=viewer.user_id, reading_id=reading_id))


@router.get("/oracle/readings/{reading_id}/concordance")
def get_oracle_concordance(
    reading_id: UUID, viewer: CurrentViewer, db: DbSession
) -> Data[list[OracleConcordanceOut]]:
    return Data(data=readings.concordance(db, viewer_id=viewer.user_id, reading_id=reading_id))
