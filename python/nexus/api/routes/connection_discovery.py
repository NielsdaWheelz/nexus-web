"""Discovery scan routes: enqueue a scan, read its state, dismiss one edge.

Transport only — dedupe, dossier, judgment and suppression live in
``nexus.services.connection_discovery``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.connection_discovery import (
    DiscoveryScanOut,
    DiscoveryScanRequest,
    DiscoveryScanStatusOut,
)
from nexus.services import connection_discovery as connection_discovery_service
from nexus.services.resource_graph import resolve as resolve_service
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import CONNECTION_DISCOVERY_SOURCE_SCHEMES

router = APIRouter(prefix="/resource-graph/discovery", tags=["connections"])


def _parse_scannable_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    if parsed.scheme not in CONNECTION_DISCOVERY_SOURCE_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unscannable scheme: {parsed.scheme!r}. Expected one of "
            f"{', '.join(CONNECTION_DISCOVERY_SOURCE_SCHEMES)}.",
        )
    return parsed


@router.post("/scans", status_code=202)
def request_scan(
    body: DiscoveryScanRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Data[DiscoveryScanOut]:
    """Queue a manual scan. 404 when the object is not visible."""
    ref = _parse_scannable_ref(body.ref)
    resolve_service.assert_ref_visible(db, viewer_id=viewer.user_id, ref=ref)
    queued = connection_discovery_service.queue_connection_discovery_scan(
        db, user_id=viewer.user_id, ref=ref, reason="manual"
    )
    status = connection_discovery_service.scan_status(db, user_id=viewer.user_id, ref=ref)
    db.commit()
    return Data(data=DiscoveryScanOut(queued=queued, status=status))


@router.get("/scans")
def read_scan_status(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    ref: Annotated[str, Query(description="Source object ref, e.g. 'highlight:<uuid>'")],
) -> Data[DiscoveryScanStatusOut]:
    """Scan state for ``ref``: idle, pending, or running."""
    parsed = _parse_scannable_ref(ref)
    status = connection_discovery_service.scan_status(db, user_id=viewer.user_id, ref=parsed)
    return Data(data=DiscoveryScanStatusOut(status=status))


@router.post("/links/{link_id}/dismiss", status_code=204)
def dismiss_link(
    link_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Suppress the edge's pair forever, then delete the edge. 409 off-origin."""
    connection_discovery_service.dismiss_discovery_link(
        db, viewer_id=viewer.user_id, edge_id=link_id
    )
    db.commit()
    return Response(status_code=204)
