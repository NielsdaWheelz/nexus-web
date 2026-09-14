"""Authorize preparation and stream already-verified retained package bytes."""

from __future__ import annotations

import base64
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from nexus.api.read_admission import AdmittedPackageTransferRoute
from nexus.auth.account_binding import require_expected_account
from nexus.auth.bearer import parse_bearer_token
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, release_connection
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.responses import success_response
from nexus.schemas.offline_reading_preparation import (
    OFFLINE_ARCHIVE_SCHEMA_VERSION,
    OfflineReadingTokenRequest,
)
from nexus.services import stream_tokens
from nexus.services.offline_reading_preparation import (
    ensure_offline_package_for_viewer,
    read_offline_package_status_for_viewer,
    read_ready_offline_archive,
    require_offline_publication_for_viewer,
)
from nexus.storage.client import get_storage_client

router = APIRouter(tags=["offline-reading"])
# The package body is the largest response in the system. It draws on its own
# qualified transfer budget so downloads cannot consume the read budget that
# mint, status and the rest of the foreground depend on.
transfers = APIRouter(route_class=AdmittedPackageTransferRoute)


@router.get("/internal/offline-reading/account-binding")
def get_offline_reading_account_binding(
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    return success_response(
        {
            "account_id": str(viewer.user_id),
            "protocol_version": 1,
            "package_schema_version": OFFLINE_ARCHIVE_SCHEMA_VERSION,
            "reader_contract_version": 1,
            "minimum_reader_bundle_version": 2,
        }
    )


@router.post("/internal/media/{media_id}/offline-reading-token", response_model=None)
def create_offline_reading_token(
    media_id: UUID,
    request: OfflineReadingTokenRequest,
    expected_account_id: Annotated[UUID, Header(alias="X-Nexus-Expected-Account-Id")],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict | JSONResponse:
    require_expected_account(viewer.user_id, expected_account_id)
    generation = request.expected_reader_generation
    if not ensure_offline_package_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id, generation=generation
    ):
        return JSONResponse(
            status_code=202,
            content=success_response(
                {
                    "reader_generation": generation,
                    "status_path": f"/media/{media_id}/reader-publications/{generation}/offline-package?schema=2",
                }
            ),
        )
    release_connection(db)
    result = stream_tokens.mint_offline_reading_package_token(
        user_id=viewer.user_id, media_id=media_id, reader_generation=generation
    )
    return success_response(
        {
            "token": result.token,
            "package_base_url": result.package_base_url,
            "account_id": str(result.account_id),
            "reader_generation": result.reader_generation,
            "package_schema_version": result.package_schema_version,
            "expires_at": result.expires_at,
        }
    )


@router.get("/media/{media_id}/reader-publications/{generation}/offline-package")
def get_offline_package_status(
    media_id: UUID,
    generation: int,
    schema: Annotated[int, Query(ge=2, le=2)],
    expected_account_id: Annotated[UUID, Header(alias="X-Nexus-Expected-Account-Id")],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    require_expected_account(viewer.user_id, expected_account_id)
    status = read_offline_package_status_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id, generation=generation
    )
    return success_response(status.model_dump(mode="json"))


@transfers.get("/offline-reading/packages/{media_id}")
def get_offline_reading_package(
    request: Request,
    media_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> StreamingResponse:
    encoded = parse_bearer_token(request.headers.get("authorization"))
    if encoded is None:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID, "Missing or invalid Authorization header"
        )
    token = stream_tokens.verify_offline_reading_package_token(encoded, expected_media_id=media_id)
    require_offline_publication_for_viewer(
        db, viewer_id=token.user_id, media_id=media_id, generation=token.reader_generation
    )
    archive = read_ready_offline_archive(db, media_id=media_id, generation=token.reader_generation)
    if archive is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Verified offline archive not found")
    storage_path = archive.storage_path
    media_type = archive.media_type
    digest = base64.b64encode(bytes.fromhex(archive.sha256)).decode("ascii")
    headers = {
        "Cache-Control": "private, no-store, no-transform",
        "Content-Length": str(archive.size_bytes),
        "Content-Digest": f"sha-256=:{digest}:",
        "Nexus-Account-Id": str(token.user_id),
        "Nexus-Reader-Generation": str(token.reader_generation),
        "Nexus-Expanded-Length": str(archive.archive_expanded_bytes),
        "X-Content-Type-Options": "nosniff",
    }
    release_connection(db)
    stream_tokens.claim_offline_reading_package_token(token)
    return StreamingResponse(
        get_storage_client().stream_object(storage_path), media_type=media_type, headers=headers
    )


router.include_router(transfers)
