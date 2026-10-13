"""Post Room: the public email ingress.

Authenticated by an HMAC body signature from the Cloudflare Email Worker plus a
capability slug, never by session, bearer or internal header: this is a
PUBLIC_PATHS member. Unless its secret, slug, domain and owner are all set it
answers 503 before reading anything.
"""

from __future__ import annotations

import hmac
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from nexus.config import Settings, get_settings
from nexus.db.session import DbSession
from nexus.logging import get_request_id
from nexus.responses import success_response
from nexus.services.email_ingest_service import accept_email_message, verify_email_signature

router = APIRouter(tags=["ingest"])


@router.post("/ingest/email")
async def post_email_ingest(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    x_nexus_email_signature: Annotated[str | None, Header(alias="x-nexus-email-signature")] = None,
    x_nexus_email_recipient: Annotated[str | None, Header(alias="x-nexus-email-recipient")] = None,
) -> JSONResponse:
    """Configuration, size, signature, recipient, owner — all before any MIME parse."""
    secret = settings.email_ingest_hmac_secret
    slug = settings.email_ingest_address_slug
    owner = settings.email_ingest_owner_user_id
    if not (secret and slug and settings.email_ingest_domain and owner):
        return JSONResponse({"data": {"error": "email_ingest_not_configured"}}, status_code=503)
    raw_body = await request.body()
    if len(raw_body) > settings.email_ingest_max_bytes:
        return JSONResponse({"data": {"error": "payload_too_large"}}, status_code=413)
    if not verify_email_signature(raw_body, x_nexus_email_signature, secret):
        return JSONResponse({"data": {"error": "invalid_signature"}}, status_code=401)
    recipient = (x_nexus_email_recipient or "").split("@")[0]
    if not hmac.compare_digest(slug.lower(), recipient.lower()):
        return JSONResponse({"data": {"error": "recipient_mismatch"}}, status_code=403)
    try:
        owner_user_id = UUID(owner.strip())
    except ValueError:
        return JSONResponse(
            {"data": {"error": "email_ingest_owner_not_configured"}}, status_code=503
        )
    result = await run_in_threadpool(
        accept_email_message,
        db=db,
        raw_body=raw_body,
        owner_user_id=owner_user_id,
        request_id=get_request_id(),
    )
    return JSONResponse(
        success_response({"outcome": result.outcome, "media_id": str(result.media_id)})
    )
