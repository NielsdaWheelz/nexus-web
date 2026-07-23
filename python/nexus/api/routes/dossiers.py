"""Generic Universal Dossier HTTP routes."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Header, Response
from pydantic import TypeAdapter
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.artifact import (
    DossierBuildCreatedOut,
    DossierBuildExecution,
    DossierBuildSummary,
    DossierCoverageOut,
    DossierGenerateRequest,
    DossierHeadOut,
    DossierRevisionOut,
    DossierRevisionSummaryOut,
)
from nexus.schemas.presence import (
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)
from nexus.services.artifacts import engine
from nexus.services.artifacts import revisions as revision_service
from nexus.services.artifacts.bindings import BINDINGS
from nexus.services.artifacts.dossier_types import (
    CancelledEventPayload,
    DossierSubjectLocator,
    FailedEventPayload,
    InvalidSubjectLocator,
)
from nexus.services.artifacts.handles import unseal_artifact_build
from nexus.services.artifacts.manifests import InputManifestV1
from nexus.services.artifacts.subject_policy import SUBJECT_POLICIES
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)

router = APIRouter(tags=["dossiers"])

_MANIFEST_ADAPTER: TypeAdapter[InputManifestV1] = TypeAdapter(InputManifestV1)
_COVERAGE_ADAPTER: TypeAdapter[DossierCoverageOut] = TypeAdapter(DossierCoverageOut)
def _subject_locator(subject_scheme: str, subject_handle: str) -> DossierSubjectLocator:
    policy = SUBJECT_POLICIES.get(subject_scheme)
    if policy is None:
        raise InvalidSubjectLocator()
    return policy.decode_locator(subject_handle)


def _artifact_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != "artifact":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid artifact reference")
    return parsed


def _revision_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != "artifact_revision":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid revision reference")
    return parsed


def _revision_out(
    view: revision_service.RevisionView,
) -> DossierRevisionOut:
    manifest, coverage = _manifest_and_coverage(view.subject_scheme, view.input_manifest)
    return DossierRevisionOut(
        artifact_id=view.artifact_id,
        artifact_ref=ResourceRef(scheme="artifact", id=view.artifact_id).uri,
        revision_id=view.revision_id,
        revision_ref=ResourceRef(scheme="artifact_revision", id=view.revision_id).uri,
        is_current=view.is_current,
        content_md=view.content_md,
        citations=view.citations,
        input_manifest=manifest,
        coverage=coverage,
        instruction=presence_from_nullable(view.instruction),
        creator_user_id=presence_from_nullable(view.creator_user_id),
        model_provider=presence_from_nullable(view.model_provider),
        model_name=presence_from_nullable(view.model_name),
        total_tokens=presence_from_nullable(view.total_tokens),
        created_at=view.created_at,
        promoted_at=presence_from_nullable(view.promoted_at),
    )


def _revision_summary_out(
    view: revision_service.RevisionSummary,
) -> DossierRevisionSummaryOut:
    manifest, coverage = _manifest_and_coverage(view.subject_scheme, view.input_manifest)
    return DossierRevisionSummaryOut(
        revision_id=view.revision_id,
        revision_ref=ResourceRef(scheme="artifact_revision", id=view.revision_id).uri,
        is_current=view.is_current,
        citation_count=view.citation_count,
        input_manifest=manifest,
        coverage=coverage,
        instruction=presence_from_nullable(view.instruction),
        creator_user_id=presence_from_nullable(view.creator_user_id),
        model_provider=presence_from_nullable(view.model_provider),
        model_name=presence_from_nullable(view.model_name),
        total_tokens=presence_from_nullable(view.total_tokens),
        created_at=view.created_at,
        promoted_at=presence_from_nullable(view.promoted_at),
    )


def _manifest_and_coverage(
    subject_scheme: str,
    raw_manifest: dict,
) -> tuple[InputManifestV1, DossierCoverageOut]:
    manifest = _MANIFEST_ADAPTER.validate_python(raw_manifest)
    binding = BINDINGS[subject_scheme]
    coverage = binding.coverage(manifest)
    return manifest, _COVERAGE_ADAPTER.validate_python({"kind": manifest.kind, **asdict(coverage)})


def _active_build_out(view: engine.DossierActiveBuildView) -> DossierBuildSummary:
    return DossierBuildSummary(
        handle=view.handle,
        requester_user_id=presence_from_nullable(view.requester_user_id),
        instruction=presence_from_nullable(view.instruction),
        created_at=view.created_at,
        execution=present(DossierBuildExecution(phase=view.execution)),
        failure=absent(),
        cancellation=absent(),
    )


def _unsuccessful_build_out(
    view: engine.DossierUnsuccessfulBuildView,
) -> DossierBuildSummary:
    failure = absent()
    cancellation = absent()
    if view.outcome == "failed":
        if view.failure_code is None:
            raise AssertionError("failed Dossier build has no failure code")
        failure = present(
            FailedEventPayload(
                failure_code=view.failure_code,
                detail=presence_from_nullable(view.failure_detail),
                support=presence_from_nullable(view.failure_support),
            )
        )
    else:
        if view.cancelled_at is None:
            raise AssertionError("cancelled Dossier build has no cancellation time")
        cancellation = present(
            CancelledEventPayload(
                actor=presence_from_nullable(view.cancellation_actor_user_id),
                at=view.cancelled_at,
            )
        )
    return DossierBuildSummary(
        handle=view.handle,
        requester_user_id=presence_from_nullable(view.requester_user_id),
        instruction=presence_from_nullable(view.instruction),
        created_at=view.created_at,
        execution=absent(),
        failure=failure,
        cancellation=cancellation,
    )


@router.get("/artifacts/dossiers/{subject_scheme}/{subject_handle}")
def get_dossier(
    subject_scheme: str,
    subject_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    locator = _subject_locator(subject_scheme, subject_handle)
    head = engine.read_head(db, locator=locator, requester_user_id=viewer.user_id)
    current = absent()
    if head.current_revision_id is not None:
        current = present(
            _revision_out(
                revision_service.get_revision(
                    db,
                    viewer_id=viewer.user_id,
                    revision_id=head.current_revision_id,
                )
            )
        )
    return ok(
        DossierHeadOut(
            artifact_id=presence_from_nullable(head.artifact_id),
            artifact_ref=(
                present(ResourceRef(scheme="artifact", id=head.artifact_id).uri)
                if head.artifact_id is not None
                else absent()
            ),
            current_revision=current,
            freshness=(
                present("Current" if head.freshness == "current" else "Stale")
                if head.freshness is not None
                else absent()
            ),
            active_build=(
                present(_active_build_out(head.active_build))
                if head.active_build is not None
                else absent()
            ),
            latest_unsuccessful_build=(
                present(_unsuccessful_build_out(head.latest_unsuccessful_build))
                if head.latest_unsuccessful_build is not None
                else absent()
            ),
            revision_count=head.revision_count,
            media_abstract=BINDINGS[head.subject_scheme].media_abstract(
                db,
                subject_id=head.subject_id,
                requester_user_id=viewer.user_id,
            ),
        )
    )


@router.post(
    "/artifacts/dossiers/{subject_scheme}/{subject_handle}/builds",
    status_code=202,
)
def create_dossier_build(
    subject_scheme: str,
    subject_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)],
    body: Annotated[DossierGenerateRequest, Body()],
) -> dict:
    ticket = engine.create_build(
        db,
        locator=_subject_locator(subject_scheme, subject_handle),
        requester_user_id=viewer.user_id,
        idempotency_key=idempotency_key,
        instruction=nullable_from_presence(body.instruction),
    )
    return ok(
        DossierBuildCreatedOut(
            artifact_ref=ResourceRef(scheme="artifact", id=ticket.artifact_id).uri,
            build_handle=ticket.handle,
            created=ticket.created,
        )
    )


@router.get("/artifacts/{artifact_ref}/revisions")
def list_dossier_revisions(
    artifact_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    ref = _artifact_ref(artifact_ref)
    revisions = revision_service.list_revisions(db, viewer_id=viewer.user_id, artifact_id=ref.id)
    return ok([_revision_summary_out(view) for view in revisions])


@router.get("/artifact-revisions/{artifact_revision_ref}")
def get_dossier_revision(
    artifact_revision_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    ref = _revision_ref(artifact_revision_ref)
    return ok(
        _revision_out(
            revision_service.get_revision(db, viewer_id=viewer.user_id, revision_id=ref.id)
        )
    )


@router.post("/artifact-revisions/{artifact_revision_ref}/make-current", status_code=204)
def make_dossier_revision_current(
    artifact_revision_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    engine.make_current(
        db,
        revision_id=_revision_ref(artifact_revision_ref).id,
        actor_user_id=viewer.user_id,
    )
    return Response(status_code=204)


@router.post("/artifact-builds/{artifact_build_handle}/cancel", status_code=204)
def cancel_dossier_build(
    artifact_build_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    engine.cancel_build(
        db,
        build_id=unseal_artifact_build(artifact_build_handle),
        actor_user_id=viewer.user_id,
    )
    return Response(status_code=204)
