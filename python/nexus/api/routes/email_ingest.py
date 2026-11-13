"""Bounded, wire-versioned email admission, authenticated independently of sessions."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from starlette.concurrency import run_in_threadpool

from nexus.api.edge import WIRE_REVISION
from nexus.config import Settings, get_settings
from nexus.db.retries import DatabaseBusyError
from nexus.db.session import DbSession
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.media_sources import EmailAcceptance
from nexus.services.email_ingest_service import (
    EMAIL_INGEST_MAX_BYTES,
    accept_email_message,
    canonical_email_recipient,
    resolve_email_ingest_config,
    verify_email_signature,
)

router = APIRouter(tags=["ingest"])


@router.post("/ingest/email")
async def post_email_ingest(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    signature: Annotated[str | None, Header(alias="x-nexus-email-signature")] = None,
    recipient: Annotated[str | None, Header(alias="x-nexus-email-recipient")] = None,
) -> Data[EmailAcceptance]:
    config = resolve_email_ingest_config(settings)
    if config is None:
        raise ApiError(ApiErrorCode.E_EMAIL_INGEST_UNAVAILABLE, "Email import is not configured.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > EMAIL_INGEST_MAX_BYTES:
            raise ApiError(ApiErrorCode.E_SOURCE_TOO_LARGE, "Email exceeds the 2 MiB limit.")
        body.extend(chunk)
    raw_body = bytes(body)
    canonical_recipient = canonical_email_recipient(recipient or "")
    if canonical_recipient is None:
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Email recipient is invalid.")
    if not verify_email_signature(
        raw_body,
        signature,
        config.secret,
        recipient=canonical_recipient,
        wire_revision=str(WIRE_REVISION),
    ):
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Email signature is invalid.")
    if not hmac.compare_digest(config.address, canonical_recipient):
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Email recipient does not match.")
    try:
        result = await run_in_threadpool(
            accept_email_message,
            db=db,
            raw_body=raw_body,
            owner_user_id=config.owner_user_id,
            request_id=get_request_id(),
        )
    except DatabaseBusyError as exc:
        raise ApiError(
            ApiErrorCode.E_DATABASE_BUSY, "Email import is busy; retry delivery."
        ) from exc
    return Data(data=result)
