"""The universal dossier HTTP surface."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Request, Response
from llm_tools import Available, ToolId
from pydantic import TypeAdapter
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.artifact import (
    CollectionDossierCoverageOut,
    ConversationDossierCoverageOut,
    DossierBuildAdmittedGenerationOut,
    DossierBuildCreatedOut,
    DossierBuildExactModelToolsOut,
    DossierBuildExecution,
    DossierBuildNoModelToolsOut,
    DossierBuildSummary,
    DossierBuildToolPlanOut,
    DossierCoverageOut,
    DossierGenerateRequest,
    DossierHeadOut,
    DossierRevisionOut,
    DossierRevisionSummaryOut,
    IdeaDossierCoverageOut,
    IdeaDossierIdentityOut,
    LearnDossierBuildAcceptedOut,
    LearnDossierOpenedOut,
    LearnDossierRequest,
    MediaDossierCoverageOut,
    NoteDossierCoverageOut,
    PageDossierCoverageOut,
    ResourceDossierIdentityOut,
)
from nexus.schemas.presence import (
    Presence,
    Present,
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)
from nexus.services.artifacts import engine, subjects
from nexus.services.artifacts import revisions as revision_service
from nexus.services.artifacts.dossier_types import (
    CancelledEventPayload,
    FailedEventPayload,
    WebResearchNotConfigured,
)
from nexus.services.artifacts.idea import IdeaSubject
from nexus.services.artifacts.manifests import (
    ContributorInputManifestV1,
    ConversationInputManifestV1,
    InputManifestV1,
    LibraryInputManifestV1,
    MediaDisposition,
    MediaInputManifestV1,
    NoteInputManifestV1,
    PageInputManifestV1,
    PodcastInputManifestV1,
    aggregate_entries,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import resolve_ref
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.tool_runtime.catalog import ComposedToolRuntime

router = APIRouter(tags=["dossiers"])

_MANIFEST_ADAPTER: TypeAdapter[InputManifestV1] = TypeAdapter(InputManifestV1)


def _require_idea_web_research(request: Request) -> None:
    runtime: ComposedToolRuntime = request.app.state.tool_runtime
    operation = runtime.operations["idea_dossier_research"]
    binding = operation.plan.catalog_view.binding(ToolId("web.search"))
    if not isinstance(binding.execute, Available):
        raise WebResearchNotConfigured()


def _ref(raw: str, scheme: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != scheme:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid {scheme} reference")
    return parsed


def _coverage(manifest: InputManifestV1) -> DossierCoverageOut:
    """The one coverage projection over the typed manifest union."""
    if isinstance(manifest, MediaInputManifestV1):
        return MediaDossierCoverageOut(
            offered_claim_count=manifest.offered_claim_count,
            omitted_evidence_refs=[item.evidence_ref for item in manifest.omitted_evidence],
        )
    if isinstance(manifest, ConversationInputManifestV1):
        return ConversationDossierCoverageOut(
            message_refs=manifest.message_refs,
            context_refs=manifest.context_refs,
        )
    if isinstance(
        manifest, LibraryInputManifestV1 | PodcastInputManifestV1 | ContributorInputManifestV1
    ):
        entries = aggregate_entries(manifest)
        return CollectionDossierCoverageOut(
            kind=manifest.kind,
            included=[
                entry.media_ref
                for entry in entries
                if entry.disposition is MediaDisposition.Included
            ],
            omitted=[
                (entry.media_ref, entry.disposition)
                for entry in entries
                if entry.disposition is not MediaDisposition.Included
            ],
        )
    if isinstance(manifest, PageInputManifestV1):
        return PageDossierCoverageOut(
            block_refs=manifest.block_refs,
            connection_refs=manifest.connection_refs,
        )
    if isinstance(manifest, NoteInputManifestV1):
        return NoteDossierCoverageOut(
            body_present=isinstance(manifest.body_fingerprint, Present),
            connection_refs=manifest.connection_refs,
        )
    return IdeaDossierCoverageOut(
        seed_count=sum(source.role == "seed" for source in manifest.included_sources),
        nexus_source_count=sum(source.role == "nexus" for source in manifest.included_sources),
        web_source_count=sum(source.role == "web" for source in manifest.included_sources),
        omitted_sources=[(item.locator, item.reason) for item in manifest.omitted_sources],
    )


def _revision_out(view: revision_service.RevisionView) -> DossierRevisionOut:
    manifest = _MANIFEST_ADAPTER.validate_python(view.input_manifest)
    return DossierRevisionOut(
        artifact_id=view.artifact_id,
        artifact_ref=ResourceRef(scheme="artifact", id=view.artifact_id).uri,
        revision_id=view.revision_id,
        revision_ref=ResourceRef(scheme="artifact_revision", id=view.revision_id).uri,
        is_current=view.is_current,
        content_html=view.content_html,
        content_text=view.content_text,
        citations=view.citations,
        input_manifest=manifest,
        coverage=_coverage(manifest),
        instruction=presence_from_nullable(view.instruction),
        creator_user_id=presence_from_nullable(view.creator_user_id),
        model_provider=presence_from_nullable(view.model_provider),
        model_name=presence_from_nullable(view.model_name),
        total_tokens=presence_from_nullable(view.total_tokens),
        created_at=view.created_at,
        promoted_at=presence_from_nullable(view.promoted_at),
    )


def _revision_summary_out(view: revision_service.RevisionSummary) -> DossierRevisionSummaryOut:
    manifest = _MANIFEST_ADAPTER.validate_python(view.input_manifest)
    return DossierRevisionSummaryOut(
        revision_id=view.revision_id,
        revision_ref=ResourceRef(scheme="artifact_revision", id=view.revision_id).uri,
        is_current=view.is_current,
        citation_count=view.citation_count,
        input_manifest=manifest,
        coverage=_coverage(manifest),
        instruction=presence_from_nullable(view.instruction),
        creator_user_id=presence_from_nullable(view.creator_user_id),
        model_provider=presence_from_nullable(view.model_provider),
        model_name=presence_from_nullable(view.model_name),
        total_tokens=presence_from_nullable(view.total_tokens),
        created_at=view.created_at,
        promoted_at=presence_from_nullable(view.promoted_at),
    )


def _admitted_generation_out(
    view: engine.AdmittedGeneration | None,
) -> Presence[DossierBuildAdmittedGenerationOut]:
    if view is None:
        return absent()
    plan, effect_mode = view.spec.model_tool_plan_snapshot, view.spec.tool_effect_mode
    tool_plan: DossierBuildToolPlanOut = DossierBuildNoModelToolsOut()
    if isinstance(plan, Present) and isinstance(effect_mode, Present):
        tool_plan = DossierBuildExactModelToolsOut(
            plan_id=plan.value.plan_id,
            plan_revision=plan.value.plan_revision,
            effect_mode=effect_mode.value,
        )
    return present(
        DossierBuildAdmittedGenerationOut(
            selection=view.spec.selection,
            display_at_dispatch=view.spec.display_at_dispatch,
            tool_plan=tool_plan,
            tool_positions=view.tool_positions,
        )
    )


def _active_build_out(view: engine.ActiveBuildView) -> DossierBuildSummary:
    return DossierBuildSummary(
        handle=view.handle,
        requester_user_id=presence_from_nullable(view.requester_user_id),
        instruction=presence_from_nullable(view.instruction),
        created_at=view.created_at,
        execution=present(DossierBuildExecution(phase=view.execution)),
        failure=absent(),
        cancellation=absent(),
        admitted_generation=_admitted_generation_out(view.admitted_generation),
        capacity_pause=presence_from_nullable(view.capacity_pause),
    )


def _unsuccessful_build_out(view: engine.UnsuccessfulBuildView) -> DossierBuildSummary:
    outcome = view.outcome
    failure: Presence[FailedEventPayload] = absent()
    cancellation: Presence[CancelledEventPayload] = absent()
    if isinstance(outcome, engine.BuildFailed):
        failure = present(
            FailedEventPayload(
                failure_code=outcome.code,
                detail=presence_from_nullable(outcome.detail),
            )
        )
    else:
        cancellation = present(
            CancelledEventPayload(
                actor=presence_from_nullable(outcome.actor_user_id),
                at=outcome.at,
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
        admitted_generation=_admitted_generation_out(view.admitted_generation),
        capacity_pause=absent(),
    )


def _head_out(db: Session, *, viewer_id: UUID, head: engine.DossierHeadView) -> DossierHeadOut:
    subject = head.subject
    if isinstance(subject, IdeaSubject):
        identity = IdeaDossierIdentityOut(title=subject.display_title)
    else:
        resolved = resolve_ref(db, viewer_id=viewer_id, ref=subject)
        identity = ResourceDossierIdentityOut(
            title=resolved.label,
            activation=resource_activation_for_ref(
                db, viewer_id=viewer_id, ref=subject, missing=resolved.missing
            ),
        )
    return DossierHeadOut(
        artifact_id=presence_from_nullable(head.artifact_id),
        artifact_ref=(
            present(ResourceRef(scheme="artifact", id=head.artifact_id).uri)
            if head.artifact_id is not None
            else absent()
        ),
        identity=present(identity),
        current_revision=(
            present(
                _revision_out(
                    revision_service.get_revision(
                        db, viewer_id=viewer_id, revision_id=head.current_revision_id
                    )
                )
            )
            if head.current_revision_id is not None
            else absent()
        ),
        freshness=presence_from_nullable(head.freshness),
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
        media_abstract=subjects.media_abstract(
            db,
            subject_scheme=head.subject_scheme,
            subject_id=head.subject_id,
            requester_user_id=viewer_id,
        ),
    )


@router.get("/artifacts/dossiers/{subject_scheme}/{subject_handle}")
def get_dossier(
    subject_scheme: str,
    subject_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    head = engine.read_head(
        db,
        subject_scheme=subject_scheme,
        subject_handle=subject_handle,
        requester_user_id=viewer.user_id,
    )
    return ok(_head_out(db, viewer_id=viewer.user_id, head=head))


@router.post("/artifacts/dossiers/{subject_scheme}/{subject_handle}/builds", status_code=202)
def create_dossier_build(
    subject_scheme: str,
    subject_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
    body: Annotated[DossierGenerateRequest, Body()],
) -> dict:
    ticket = engine.start_build(
        db,
        subject_scheme=subject_scheme,
        subject_handle=subject_handle,
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


@router.post("/artifacts/dossiers/learn")
def learn_dossier(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
    body: Annotated[LearnDossierRequest, Body()],
) -> dict:
    _require_idea_web_research(request)
    outcome = engine.learn_idea(
        db,
        highlight_id=_ref(body.highlight_ref, "highlight").id,
        requester_user_id=viewer.user_id,
        idempotency_key=idempotency_key,
    )
    artifact_ref = ResourceRef(scheme="artifact", id=outcome.artifact_id).uri
    if outcome.kind == "Opened":
        return ok(LearnDossierOpenedOut(artifact_ref=artifact_ref))
    return ok(
        LearnDossierBuildAcceptedOut(
            artifact_ref=artifact_ref,
            build_handle=str(outcome.build_id),
        )
    )


@router.get("/artifacts/{artifact_ref}")
def get_dossier_by_ref(
    artifact_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    head = engine.read_artifact_head(
        db,
        artifact_id=_ref(artifact_ref, "artifact").id,
        requester_user_id=viewer.user_id,
    )
    return ok(_head_out(db, viewer_id=viewer.user_id, head=head))


@router.post("/artifacts/{artifact_ref}/builds", status_code=202)
def regenerate_dossier(
    request: Request,
    artifact_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
    body: Annotated[DossierGenerateRequest, Body()],
) -> dict:
    artifact_id = _ref(artifact_ref, "artifact").id
    scheme = engine.artifact_subject_scheme(
        db, artifact_id=artifact_id, requester_user_id=viewer.user_id
    )
    if scheme == "idea":
        _require_idea_web_research(request)
    ticket = engine.start_artifact_build(
        db,
        artifact_id=artifact_id,
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
    revisions = revision_service.list_revisions(
        db, viewer_id=viewer.user_id, artifact_id=_ref(artifact_ref, "artifact").id
    )
    return ok([_revision_summary_out(view) for view in revisions])


@router.get("/artifact-revisions/{artifact_revision_ref}")
def get_dossier_revision(
    artifact_revision_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        _revision_out(
            revision_service.get_revision(
                db,
                viewer_id=viewer.user_id,
                revision_id=_ref(artifact_revision_ref, "artifact_revision").id,
            )
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
        revision_id=_ref(artifact_revision_ref, "artifact_revision").id,
        actor_user_id=viewer.user_id,
    )
    return Response(status_code=204)


@router.post("/artifact-builds/{artifact_build_id}/cancel", status_code=204)
def cancel_dossier_build(
    artifact_build_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    engine.cancel_build(db, build_id=artifact_build_id, actor_user_id=viewer.user_id)
    return Response(status_code=204)
