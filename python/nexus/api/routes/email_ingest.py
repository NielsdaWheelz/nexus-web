"""Post Room: the public email ingress.

Authenticated by the Cloudflare Email Worker's HMAC body signature plus the address
slug, never by session, bearer or internal header (a PUBLIC_PATHS member). Unless its
secret, slug, domain and owner are all set it answers 503 before reading the body. A
4xx refuses the message; a 5xx (storage or database down) makes the worker defer it.
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


def _refused(error: str, status: int) -> JSONResponse:
    return JSONResponse({"data": {"error": error}}, status_code=status)


@router.post("/ingest/email")
async def post_email_ingest(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    signature: Annotated[str | None, Header(alias="x-nexus-email-signature")] = None,
    recipient: Annotated[str | None, Header(alias="x-nexus-email-recipient")] = None,
) -> JSONResponse:
    """Configuration, size, signature, recipient and owner, all before any MIME parse."""
    secret, slug = settings.email_ingest_hmac_secret, settings.email_ingest_address_slug
    owner = settings.email_ingest_owner_user_id
    if not (secret and slug and settings.email_ingest_domain and owner):
        return _refused("email_ingest_not_configured", 503)
    raw_body = await request.body()
    if len(raw_body) > settings.email_ingest_max_bytes:
        return _refused("payload_too_large", 413)
    if not verify_email_signature(raw_body, signature, secret):
        return _refused("invalid_signature", 401)
    if not hmac.compare_digest(slug.lower(), (recipient or "").split("@")[0].lower()):
        return _refused("recipient_mismatch", 403)
    try:
        owner_user_id = UUID(owner.strip())
    except ValueError:
        return _refused("email_ingest_owner_not_configured", 503)
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
