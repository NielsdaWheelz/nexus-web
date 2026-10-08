"""ConnectionDiscovery routes: queue a scan, read its state, dismiss a proposal."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.connection_discovery import (
    ConnectionDiscoveryScanOut,
    ConnectionDiscoveryScanRequest,
)
from nexus.services import connection_discovery
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import CONNECTION_DISCOVERY_SOURCE_SCHEMES

router = APIRouter(prefix="/connection-discovery", tags=["connection-discovery"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


def _scannable(raw: str) -> ResourceRef:
    ref = parse_resource_ref(raw)
    if not isinstance(ref, ResourceRef) or ref.scheme not in CONNECTION_DISCOVERY_SOURCE_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Expected '<scheme>:<uuid>' with a scheme in {', '.join(CONNECTION_DISCOVERY_SOURCE_SCHEMES)}.",
        )
    return ref


@router.post("/scans", status_code=202)
def request_scan(
    body: ConnectionDiscoveryScanRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConnectionDiscoveryScanOut]:
    ref = _scannable(body.ref)
    assert_ref_visible(db, viewer_id=viewer.user_id, ref=ref)
    connection_discovery.queue_connection_discovery_scan(
        db, user_id=viewer.user_id, ref=ref, reason="manual"
    )
    status, outcome = connection_discovery.scan_state(db, user_id=viewer.user_id, ref=ref)
    db.commit()
    return Data(data=ConnectionDiscoveryScanOut(status=status, outcome=outcome))


@router.get("/scans")
def read_scan(ref: str, viewer: ViewerDep, db: DbSession) -> Data[ConnectionDiscoveryScanOut]:
    source = _scannable(ref)
    assert_ref_visible(db, viewer_id=viewer.user_id, ref=source)
    status, outcome = connection_discovery.scan_state(db, user_id=viewer.user_id, ref=source)
    return Data(data=ConnectionDiscoveryScanOut(status=status, outcome=outcome))


@router.post("/edges/{edge_id}/dismiss", status_code=204)
def dismiss_edge(edge_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    connection_discovery.dismiss_connection_discovery_edge(
        db, viewer_id=viewer.user_id, edge_id=edge_id
    )
    return Response(status_code=204)
