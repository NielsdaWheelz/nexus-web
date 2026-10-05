"""Synapse routes: queue a scan, read its state, dismiss a proposal."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.synapse import SynapseScanOut, SynapseScanRequest
from nexus.services import synapse
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import SYNAPSE_SOURCE_SCHEMES

router = APIRouter(prefix="/synapse", tags=["synapse"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


def _scannable(raw: str) -> ResourceRef:
    ref = parse_resource_ref(raw)
    if not isinstance(ref, ResourceRef) or ref.scheme not in SYNAPSE_SOURCE_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Expected '<scheme>:<uuid>' with a scheme in {', '.join(SYNAPSE_SOURCE_SCHEMES)}.",
        )
    return ref


@router.post("/scans", status_code=202)
def request_scan(
    body: SynapseScanRequest, viewer: ViewerDep, db: DbSession
) -> Data[SynapseScanOut]:
    ref = _scannable(body.ref)
    assert_ref_visible(db, viewer_id=viewer.user_id, ref=ref)
    synapse.queue_synapse_scan(db, user_id=viewer.user_id, ref=ref, reason="manual")
    status = synapse.scan_status(db, user_id=viewer.user_id, ref=ref)
    db.commit()
    return Data(data=SynapseScanOut(status=status))


@router.get("/scans")
def read_scan(ref: str, viewer: ViewerDep, db: DbSession) -> Data[SynapseScanOut]:
    status = synapse.scan_status(db, user_id=viewer.user_id, ref=_scannable(ref))
    return Data(data=SynapseScanOut(status=status))


@router.post("/edges/{edge_id}/dismiss", status_code=204)
def dismiss_edge(edge_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    synapse.dismiss_synapse_edge(db, viewer_id=viewer.user_id, edge_id=edge_id)
    return Response(status_code=204)
