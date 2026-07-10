"""Post Room: public email ingest endpoint.

Mounted only when ``EMAIL_INGEST_ENABLED=true``. Authenticates via HMAC body
signature (Cloudflare Email Worker → this endpoint) + capability slug, never
via session/bearer/internal header (PUBLIC_PATHS member).
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
from nexus.services.email_ingest_service import (
    accept_email_message,
    verify_email_signature,
)

router = APIRouter(tags=["ingest"])


@router.post("/ingest/email")
async def post_email_ingest(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    x_nexus_email_signature: Annotated[str | None, Header(alias="x-nexus-email-signature")] = None,
    x_nexus_email_recipient: Annotated[str | None, Header(alias="x-nexus-email-recipient")] = None,
) -> JSONResponse:
    """Receive a raw MIME message from the Cloudflare Email Worker.

    Auth order (AC-3, AC-4, AC-5):
    1. Size re-check — 413.
    2. HMAC verify (constant-time) — 401.
    3. Slug compare (constant-time) — 403.
    4. Accept/dedupe/enqueue — 200.
    """
    raw_body = await request.body()

    # 1. Size re-check (D-7: never trust the worker).
    if len(raw_body) > settings.email_ingest_max_bytes:
        return JSONResponse({"data": {"error": "payload_too_large"}}, status_code=413)

    # 2. Constant-time HMAC verify (AC-3: before any parse).
    secret = settings.email_ingest_hmac_secret or ""
    if not verify_email_signature(raw_body, x_nexus_email_signature, secret):
        return JSONResponse({"data": {"error": "invalid_signature"}}, status_code=401)

    # 3. Constant-time slug compare (G-2: no plain ==).
    expected_slug = settings.email_ingest_address_slug or ""
    recipient = x_nexus_email_recipient or ""
    # Normalise: extract local-part if a full address was sent.
    if "@" in recipient:
        recipient = recipient.split("@")[0]
    if not hmac.compare_digest(expected_slug.lower(), recipient.lower()):
        return JSONResponse({"data": {"error": "recipient_mismatch"}}, status_code=403)

    # 4. Accept.
    # Owner is required whenever the route is mounted; in staging/prod config.validate
    # enforces it, but local/CI can enable the flag without it — fail legibly, not with
    # an opaque 500 from UUID("").
    owner_raw = (settings.email_ingest_owner_user_id or "").strip()
    try:
        owner_user_id = UUID(owner_raw)
    except ValueError:
        return JSONResponse(
            {"data": {"error": "email_ingest_owner_not_configured"}}, status_code=503
        )
    request_id = request.headers.get("x-request-id")
    result = await run_in_threadpool(
        accept_email_message,
        db=db,
        raw_body=raw_body,
        owner_user_id=owner_user_id,
        request_id=request_id,
    )
    payload: dict[str, object] = {"outcome": result.outcome, "media_id": str(result.media_id)}
    return JSONResponse(success_response(payload))
