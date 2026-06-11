"""Synapse resonance scan routes (synapse spec §8).

- POST /synapse/scans                    manual scan enqueue for one object
- GET  /synapse/scans?ref=               scan state (background-job projection)
- POST /synapse/edges/{edge_id}/dismiss  suppress a pair forever, delete the edge

Routes parse ref strings at the boundary, call the synapse service, and
return envelopes. Scan semantics (dedupe, dossier, judgment, suppression)
live in ``nexus.services.synapse``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.synapse import SynapseScanOut, SynapseScanRequest, SynapseScanStatusOut
from nexus.services import synapse as synapse_service
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph import resolve as resolve_service
from nexus.services.resource_graph.refs import ResourceRef

router = APIRouter(prefix="/synapse", tags=["synapse"])


def _parse_scannable_ref_or_400(raw: str) -> ResourceRef:
    parsed = refs_service.parse_resource_ref(raw)
    if isinstance(parsed, refs_service.ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    if parsed.scheme not in synapse_service.SYNAPSE_SOURCE_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unscannable scheme: {parsed.scheme!r}. Expected one of "
            f"{', '.join(synapse_service.SYNAPSE_SOURCE_SCHEMES)}.",
        )
    return parsed


@router.post("/scans", status_code=202)
def request_scan(
    body: SynapseScanRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Queue a manual resonance scan for one object.

    Always 202: enqueue is idempotent per ref (``queued`` is False when a scan
    is already in flight or the engine is disabled); ``status`` reflects the
    job row either way.

    Errors:
        E_INVALID_REQUEST (400): malformed ref or unscannable scheme.
        E_NOT_FOUND (404): the object does not exist or is not visible.
    """
    ref = _parse_scannable_ref_or_400(body.ref)
    resolve_service.assert_ref_visible(db, viewer_id=viewer.user_id, ref=ref)
    queued = synapse_service.queue_synapse_scan(
        db, user_id=viewer.user_id, ref=ref, reason="manual"
    )
    status = synapse_service.scan_status(db, user_id=viewer.user_id, ref=ref)
    db.commit()
    return ok(SynapseScanOut(queued=queued, status=status))


@router.get("/scans")
def read_scan_status(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    ref: Annotated[str, Query(description="Source object ref, e.g. 'highlight:<uuid>'")],
) -> dict:
    """Report scan state for ``ref``: idle, pending, or running.

    Errors:
        E_INVALID_REQUEST (400): malformed ref or unscannable scheme.
    """
    parsed = _parse_scannable_ref_or_400(ref)
    status = synapse_service.scan_status(db, user_id=viewer.user_id, ref=parsed)
    return ok(SynapseScanStatusOut(status=status))


@router.post("/edges/{edge_id}/dismiss", status_code=204)
def dismiss_edge(
    edge_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Dismiss one synapse edge: record a permanent suppression, then delete it.

    Errors:
        E_NOT_FOUND (404): edge does not exist or is not the viewer's.
        E_CONFLICT (409): edge exists but is not synapse-origin.
    """
    synapse_service.dismiss_synapse_edge(db, viewer_id=viewer.user_id, edge_id=edge_id)
    db.commit()
    return Response(status_code=204)
