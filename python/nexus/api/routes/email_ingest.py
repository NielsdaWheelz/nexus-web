"""Post Room: the public email ingress.

Mounted only when ``EMAIL_INGEST_ENABLED``. Authenticated by an HMAC body
signature from the Cloudflare Email Worker plus a capability slug, never by
session, bearer or internal header: this is a PUBLIC_PATHS member.
"""

from __future__ import annotations

import hmac
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.config import Settings, get_settings
from nexus.db.session import get_db
from nexus.responses import success_response
from nexus.services.email_ingest_service import accept_email_message, verify_email_signature

router = APIRouter(tags=["ingest"])


@router.post("/ingest/email")
async def post_email_ingest(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    x_nexus_email_signature: Annotated[str | None, Header(alias="x-nexus-email-signature")] = None,
    x_nexus_email_recipient: Annotated[str | None, Header(alias="x-nexus-email-recipient")] = None,
) -> JSONResponse:
    """Size, then signature, then recipient, then owner — all before any MIME parse."""
    raw_body = await request.body()
    if len(raw_body) > settings.email_ingest_max_bytes:
        return JSONResponse({"data": {"error": "payload_too_large"}}, status_code=413)
    if not verify_email_signature(
        raw_body, x_nexus_email_signature, settings.email_ingest_hmac_secret or ""
    ):
        return JSONResponse({"data": {"error": "invalid_signature"}}, status_code=401)
    recipient = (x_nexus_email_recipient or "").split("@")[0]
    if not hmac.compare_digest(
        (settings.email_ingest_address_slug or "").lower(), recipient.lower()
    ):
        return JSONResponse({"data": {"error": "recipient_mismatch"}}, status_code=403)
    # Staging and production validate the owner at boot; local and CI can enable
    # the flag without it, so fail legibly instead of on UUID("").
    try:
        owner_user_id = UUID((settings.email_ingest_owner_user_id or "").strip())
    except ValueError:
        return JSONResponse(
            {"data": {"error": "email_ingest_owner_not_configured"}}, status_code=503
        )
    result = await run_in_threadpool(
        accept_email_message,
        db=db,
        raw_body=raw_body,
        owner_user_id=owner_user_id,
        request_id=request.headers.get("x-request-id"),
    )
    return JSONResponse(
        success_response({"outcome": result.outcome, "media_id": str(result.media_id)})
    )
