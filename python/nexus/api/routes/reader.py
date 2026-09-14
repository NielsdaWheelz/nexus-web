"""Reader routes: evidence resolution, Document Map, reader progress, file.

Transport-only: validate input, call one reader-family service, return the
envelope. All paths are `/media/{media_id}/...`. Whole-document section, find
and navigation reads belong to the publication routes.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.api.read_admission import AdmittedReadRoute
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.media import MediaEvidenceResponse
from nexus.schemas.reader_progress import ReaderProgressWrite
from nexus.services import (
    locator_resolver,
    media_file_access,
    reader_document_map,
)
from nexus.services.consumption import reader_progress

router = APIRouter(tags=["media"])
reads = APIRouter(route_class=AdmittedReadRoute)


@reads.get(
    "/media/{media_id}/evidence/{evidence_span_id}",
    response_model=MediaEvidenceResponse,
)
def resolve_media_evidence(
    media_id: UUID,
    evidence_span_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = locator_resolver.resolve_evidence_span(
        db,
        viewer_id=viewer.user_id,
        evidence_span_id=evidence_span_id,
    )
    return success_response(result)


@reads.get("/media/{media_id}/document-map")
def get_reader_document_map(
    request: Request,
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """Get the reader Document Map aggregate."""
    unsupported_params = sorted(request.query_params)
    if unsupported_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unsupported Document Map params: {', '.join(unsupported_params)}",
        )
    result = reader_document_map.get_reader_document_map(
        db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return ok(result)


@router.get("/media/{media_id}/offline-reader-state")
def get_reader_progress(
    media_id: UUID,
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    expected_account_id: Annotated[UUID, Header(alias="X-Nexus-Expected-Account-Id")],
) -> dict:
    """Attest the current generation and the cursor's independently recorded source.

    Every reader — hosted and native — persists this pair as its durable
    baseline, so both reads must come from one snapshot rather than two READ
    COMMITTED instants. The path keeps its `offline-` spelling because installed
    native copies address it; the owner it reaches is the shared one.
    """
    state = reader_progress.get(
        db,
        viewer_id=viewer.user_id,
        expected_account_id=expected_account_id,
        media_id=media_id,
    )
    response.headers["Nexus-Account-Id"] = str(state.account_id)
    if state.reader_generation is not None:
        response.headers["Nexus-Reader-Generation"] = str(state.reader_generation)
    return ok(state, by_alias=True)


@router.put("/media/{media_id}/offline-reader-state")
def put_reader_progress(
    media_id: UUID,
    payload: ReaderProgressWrite,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    expected_account_id: Annotated[UUID, Header(alias="X-Nexus-Expected-Account-Id")],
) -> JSONResponse:
    state = reader_progress.put(
        viewer_id=viewer.user_id,
        expected_account_id=expected_account_id,
        media_id=media_id,
        write=payload,
    )
    headers = {"Nexus-Account-Id": str(state.account_id)}
    if state.reader_generation is not None:
        headers["Nexus-Reader-Generation"] = str(state.reader_generation)
    return JSONResponse(content=ok(state, by_alias=True), headers=headers)


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a short-lived signed download URL for a media file (PDF/EPUB only).

    Returns url and expires_at.
    """
    result = media_file_access.get_signed_download_url(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return success_response(result)


router.include_router(reads)
