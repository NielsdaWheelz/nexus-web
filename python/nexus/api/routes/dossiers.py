"""The dossier HTTP surface: read a head, start a build, learn an idea, cancel a build."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.dossier import (
    DossierBuildCreatedOut,
    DossierGenerateRequest,
    DossierHeadOut,
    LearnDossierOut,
    LearnDossierRequest,
)
from nexus.schemas.presence import nullable_from_presence
from nexus.services.dossier import engine
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["dossiers"])
CurrentViewer = Annotated[Viewer, Depends(get_viewer)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]


def _ref_id(raw: str, scheme: str) -> UUID:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != scheme:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid {scheme} reference")
    return parsed.id


@router.get("/artifacts/dossiers/{subject_scheme}/{subject_handle}")
def get_dossier(
    subject_scheme: str, subject_handle: str, viewer: CurrentViewer, db: RepeatableReadDbSession
) -> Data[DossierHeadOut]:
    head = engine.read_subject_head(
        db, scheme=subject_scheme, handle=subject_handle, viewer_id=viewer.user_id
    )
    return Data(data=head)


@router.post("/artifacts/dossiers/{subject_scheme}/{subject_handle}/builds", status_code=202)
def create_dossier_build(
    subject_scheme: str,
    subject_handle: str,
    viewer: CurrentViewer,
    db: DbSession,
    key: IdempotencyKey,
    body: Annotated[DossierGenerateRequest, Body()],
) -> Data[DossierBuildCreatedOut]:
    created = engine.start_build(
        db,
        scheme=subject_scheme,
        handle=subject_handle,
        viewer_id=viewer.user_id,
        key=key,
        instruction=nullable_from_presence(body.instruction),
    )
    return Data(data=created)


@router.post("/artifacts/dossiers/learn")
def learn_dossier(
    viewer: CurrentViewer,
    db: DbSession,
    key: IdempotencyKey,
    body: Annotated[LearnDossierRequest, Body()],
) -> Data[LearnDossierOut]:
    highlight_id = _ref_id(body.highlight_ref, "highlight")
    return Data(data=engine.learn(db, highlight_id=highlight_id, viewer_id=viewer.user_id, key=key))


@router.get("/artifacts/{artifact_ref}")
def get_dossier_by_ref(
    artifact_ref: str, viewer: CurrentViewer, db: RepeatableReadDbSession
) -> Data[DossierHeadOut]:
    artifact_id = _ref_id(artifact_ref, "artifact")
    return Data(data=engine.read_head(db, artifact_id=artifact_id, viewer_id=viewer.user_id))


@router.post("/artifacts/{artifact_ref}/builds", status_code=202)
def regenerate_dossier(
    artifact_ref: str,
    viewer: CurrentViewer,
    db: DbSession,
    key: IdempotencyKey,
    body: Annotated[DossierGenerateRequest, Body()],
) -> Data[DossierBuildCreatedOut]:
    created = engine.regenerate(
        db,
        artifact_id=_ref_id(artifact_ref, "artifact"),
        viewer_id=viewer.user_id,
        key=key,
        instruction=nullable_from_presence(body.instruction),
    )
    return Data(data=created)


@router.post("/artifact-builds/{artifact_build_id}/cancel", status_code=204)
def cancel_dossier_build(artifact_build_id: UUID, viewer: CurrentViewer, db: DbSession) -> Response:
    engine.cancel_build(db, build_id=artifact_build_id, viewer_id=viewer.user_id)
    return Response(status_code=204)
