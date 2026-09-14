"""Raw verified reader member bytes; queries and commands retain normal envelopes."""

import base64
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from nexus.api.read_admission import AdmittedReadRoute
from nexus.api.storage_response import StorageResponse
from nexus.auth.middleware import Viewer, get_viewer
from nexus.config import require_reader_publication_limits
from nexus.db.session import get_repeatable_read_db, release_connection
from nexus.errors import ApiErrorCode, InvalidRequestError, ReaderContentTooLargeError
from nexus.responses import ok
from nexus.schemas.highlights import PdfHighlightPaintRequest
from nexus.schemas.reader_publication import (
    ReaderPublicationApparatusLookupRequest,
    ReaderPublicationApparatusRequest,
    ReaderPublicationApparatusTextRequest,
    ReaderPublicationEmbedsRequest,
    ReaderPublicationFindRequest,
    ReaderPublicationHighlightsRequest,
    ReaderPublicationHighlightSummariesRequest,
    ReaderPublicationMemberRole,
    ReaderPublicationResolveRequest,
    ReaderPublicationSectionContextRequest,
)
from nexus.schemas.reader_publication_evidence import (
    ReaderEvidenceAssociationsRequest,
    ReaderEvidenceBucketRequest,
    ReaderEvidenceFactsRequest,
    ReaderEvidenceGutterRequest,
    ReaderEvidenceLocationRequest,
    ReaderEvidenceMarkerPreviewRequest,
    ReaderEvidenceOverviewRequest,
    ReaderEvidenceSeekRequest,
)
from nexus.services.epub_assets import READER_ASSET_CONTENT_SECURITY_POLICY
from nexus.services.media_file_access import parse_single_byte_range
from nexus.services.pdf_highlights import list_pdf_highlights
from nexus.services.reader_publication_apparatus import (
    list_reader_publication_apparatus,
    locate_reader_publication_apparatus,
    lookup_reader_publication_apparatus,
    read_reader_publication_apparatus_text,
)
from nexus.services.reader_publication_embeds import list_reader_publication_embeds
from nexus.services.reader_publication_evidence import (
    get_reader_publication_evidence_overview,
    get_reader_publication_marker_preview,
    list_reader_publication_evidence,
    list_reader_publication_evidence_associations,
    list_reader_publication_evidence_bucket,
    list_reader_publication_gutter,
    locate_reader_publication_evidence,
)
from nexus.services.reader_publication_find import find_reader_publication_for_viewer
from nexus.services.reader_publication_highlights import (
    list_reader_publication_highlight_summaries,
    list_reader_publication_highlights,
)
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.services.reader_publication_resolve import (
    get_reader_publication_section_context,
    resolve_reader_publication_for_viewer,
)
from nexus.storage.client import get_storage_client
from nexus.storage.read import HTTP_STORAGE_CHUNK_BYTES, stream_object_checked

router = APIRouter(tags=["media"])
reads = APIRouter(route_class=AdmittedReadRoute)


def _query_response(payload: BaseModel) -> Response:
    limits = require_reader_publication_limits()
    response = JSONResponse(
        ok(payload), headers={"Cache-Control": "private, no-store, no-transform"}
    )
    if len(response.body) > limits.index_bytes:
        raise ReaderContentTooLargeError(
            "Reader query exceeds response capacity",
            limit="index_bytes",
            limit_value=limits.index_bytes,
            measured=len(response.body),
        )
    return response


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence")
def get_reader_publication_evidence(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceFactsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_evidence(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/seek")
def seek_reader_publication_evidence(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceSeekRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_evidence(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/associations")
def get_reader_publication_evidence_associations(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceAssociationsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_evidence_associations(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/location")
def get_reader_publication_evidence_location(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceLocationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        locate_reader_publication_evidence(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/gutter")
def get_reader_evidence_gutter(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceGutterRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_gutter(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/overview/preview")
def get_reader_evidence_marker_preview(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceMarkerPreviewRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        get_reader_publication_marker_preview(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/overview")
def get_reader_evidence_overview(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceOverviewRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        get_reader_publication_evidence_overview(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/evidence/overview/bucket")
def get_reader_evidence_bucket(
    media_id: UUID,
    generation: int,
    payload: ReaderEvidenceBucketRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_evidence_bucket(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/pdf-highlights")
def get_reader_publication_pdf_highlights(
    media_id: UUID,
    generation: int,
    payload: PdfHighlightPaintRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_pdf_highlights(
            db,
            viewer.user_id,
            media_id,
            payload.page_number,
            reader_generation=generation,
            mine_only=payload.mine_only,
            after=payload.after,
            limit=payload.limit,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/apparatus")
def get_reader_publication_apparatus(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationApparatusRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_apparatus(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/apparatus/lookup")
def get_reader_publication_apparatus_by_key(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationApparatusLookupRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        lookup_reader_publication_apparatus(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            stable_key=payload.stable_key,
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/apparatus/{item_id}/targets")
def get_reader_publication_apparatus_targets(
    media_id: UUID,
    generation: int,
    item_id: UUID,
    payload: ReaderPublicationApparatusRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_apparatus(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
            from_item_id=item_id,
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/apparatus/{item_id}/text")
def get_reader_publication_apparatus_text(
    media_id: UUID,
    generation: int,
    item_id: UUID,
    payload: ReaderPublicationApparatusTextRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        read_reader_publication_apparatus_text(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            item_id=item_id,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/apparatus/{item_id}/location")
def get_reader_publication_apparatus_location(
    media_id: UUID,
    generation: int,
    item_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        locate_reader_publication_apparatus(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            item_id=item_id,
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/highlight-summaries")
def get_reader_publication_highlight_summaries(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationHighlightSummariesRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_highlight_summaries(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/highlights")
def get_reader_publication_highlights(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationHighlightsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_highlights(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/embeds")
def get_reader_publication_embeds(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationEmbedsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        list_reader_publication_embeds(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/section-context")
def get_reader_section_context(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationSectionContextRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        get_reader_publication_section_context(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/resolve")
def resolve_reader_publication(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationResolveRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        resolve_reader_publication_for_viewer(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
        )
    )


@reads.post("/media/{media_id}/reader-publications/{generation}/find")
def find_reader_publication(
    media_id: UUID,
    generation: int,
    payload: ReaderPublicationFindRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _query_response(
        find_reader_publication_for_viewer(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            generation=generation,
            request=payload,
            limits=require_reader_publication_limits(),
        )
    )


def _member_response(
    db: Session,
    *,
    viewer: Viewer,
    media_id: UUID,
    generation: int | None,
    key: str,
    role: ReaderPublicationMemberRole,
    byte_range: str | None = None,
) -> Response:
    source = get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        generation=generation,
        key=key,
        role=role,
    )
    release_connection(db)
    digest = base64.b64encode(bytes.fromhex(source.sha256)).decode("ascii")
    headers = {
        "Cache-Control": "private, no-store, no-transform",
        "ETag": f'"{source.sha256}"',
        "X-Nexus-Reader-Generation": str(source.generation),
        "Content-Length": str(source.size_bytes),
        "X-Content-Type-Options": "nosniff",
    }
    if role == "asset" and source.media_type in {
        "image/svg+xml",
        "text/html",
        "application/xhtml+xml",
        "application/xml",
        "text/xml",
    }:
        headers["Content-Security-Policy"] = READER_ASSET_CONTENT_SECURITY_POLICY
    if role == "asset" and source.media_type in {"text/html", "application/xhtml+xml"}:
        headers["Content-Disposition"] = "attachment"
    storage = get_storage_client()
    if byte_range is not None:
        try:
            interval = parse_single_byte_range(byte_range, size_bytes=source.size_bytes)
        except ValueError:
            return Response(
                status_code=416, headers={"Content-Range": f"bytes */{source.size_bytes}"}
            )
        headers.update(
            {
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {interval.start}-{interval.end}/{source.size_bytes}",
                "Content-Length": str(interval.length),
            }
        )
        return StorageResponse(
            storage.stream_object_range(
                source.storage_path,
                start=interval.start,
                end_inclusive=interval.end,
                chunk_bytes=HTTP_STORAGE_CHUNK_BYTES,
            ),
            media_type=source.media_type,
            status_code=206,
            headers=headers,
        )
    headers["Content-Digest"] = f"sha-256=:{digest}:"
    if role == "asset":
        headers["Accept-Ranges"] = "bytes"
    return StorageResponse(
        stream_object_checked(
            storage,
            source.storage_path,
            expected_size=source.size_bytes,
            chunk_bytes=HTTP_STORAGE_CHUNK_BYTES,
        ),
        media_type=source.media_type,
        headers=headers,
    )


@reads.get("/media/{media_id}/reader-publication")
def select_reader_publication(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _member_response(
        db,
        viewer=viewer,
        media_id=media_id,
        generation=None,
        key="descriptor.json",
        role="descriptor",
    )


@reads.get("/media/{media_id}/reader-publications/{generation}/descriptor")
def get_reader_publication_descriptor(
    media_id: UUID,
    generation: int,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _member_response(
        db,
        viewer=viewer,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )


@reads.get("/media/{media_id}/reader-publications/{generation}/index")
def get_reader_publication_index(
    request: Request,
    media_id: UUID,
    generation: int,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    after: str | None = None,
) -> Response:
    if len(request.query_params.multi_items()) > 1 or any(
        key != "after" for key in request.query_params
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Index accepts one optional member continuation"
        )
    return _member_response(
        db,
        viewer=viewer,
        media_id=media_id,
        generation=generation,
        key=after if after is not None else "index/0.json",
        role="index",
    )


@reads.get("/media/{media_id}/reader-publications/{generation}/units/{key:path}")
def get_reader_publication_unit(
    media_id: UUID,
    generation: int,
    key: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> Response:
    return _member_response(
        db, viewer=viewer, media_id=media_id, generation=generation, key=f"units/{key}", role="unit"
    )


@reads.get("/media/{media_id}/reader-publications/{generation}/assets/{key:path}")
def get_reader_publication_asset(
    media_id: UUID,
    generation: int,
    key: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    byte_range: Annotated[str | None, Header(alias="Range")] = None,
) -> Response:
    return _member_response(
        db,
        viewer=viewer,
        media_id=media_id,
        generation=generation,
        key=f"assets/{key}",
        role="asset",
        byte_range=byte_range,
    )


router.include_router(reads)
