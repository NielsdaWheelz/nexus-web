"""Single-use auth handoff codes for the native Android sign-in flow."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.services.auth_handoff_codes import (
    consume_auth_handoff_code,
    create_auth_handoff_code,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class MintHandoffCodeRequest(BaseModel):
    access_token: str = Field(min_length=1)
    refresh_token: str = Field(min_length=1)
    challenge: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


@router.post("/handoff-codes", status_code=201)
def create_auth_handoff_code_route(
    payload: MintHandoffCodeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    code = create_auth_handoff_code(
        db=db,
        user_id=viewer.user_id,
        access_token=payload.access_token,
        refresh_token=payload.refresh_token,
        challenge=payload.challenge,
    )
    return success_response({"code": code})


class ConsumeHandoffCodeRequest(BaseModel):
    code: str = Field(min_length=1)
    verifier: str = Field(min_length=1)


@router.post("/handoff-codes/consume")
def consume_auth_handoff_code_route(
    payload: ConsumeHandoffCodeRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = consume_auth_handoff_code(db=db, code=payload.code, verifier=payload.verifier)
    if result is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Auth handoff code is invalid or expired")
    access_token, refresh_token = result
    return success_response({"access_token": access_token, "refresh_token": refresh_token})
