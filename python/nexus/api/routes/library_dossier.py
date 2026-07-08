"""Library-dossier routes (stable head + immutable revisions).

The URLs are unchanged (``/libraries/{id}/intelligence…``, D-7); only the module
name and its internals moved to the artifact engine.
"""

from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.artifact import (
    ArtifactBuildOut,
    DossierArtifactOut,
    DossierGenerateOut,
    DossierGenerateRequest,
    DossierRevisionOut,
    DossierRevisionsOut,
    DossierRevisionSummaryOut,
    RevisionStatus,
)
from nexus.services.artifacts import dossier as dossier_service
from nexus.services.artifacts import revisions as revisions_service

router = APIRouter(tags=["library-dossier"])


def _artifact_out(view: dossier_service.ArtifactView) -> DossierArtifactOut:
    build = (
        ArtifactBuildOut(
            revision_id=view.build.revision_id,
            status=cast("RevisionStatus", view.build.status),
        )
        if view.build is not None
        else None
    )
    return DossierArtifactOut(
        artifact_id=view.artifact_id,
        artifact_ref=(f"artifact:{view.artifact_id}" if view.artifact_id is not None else None),
        revision_id=view.revision_id,
        revision_ref=(
            f"artifact_revision:{view.revision_id}" if view.revision_id is not None else None
        ),
        status=view.status,
        content_md=view.content_md,
        citations=view.citations,
        citation_count=len(view.citations),
        source_count=view.source_count,
        covered_source_count=view.covered_source_count,
        omitted_source_count=view.omitted_source_count,
        custom_instruction=view.custom_instruction,
        model_provider=view.model_provider,
        model_name=view.model_name,
        total_tokens=view.total_tokens,
        build=build,
        stale_source_count=view.stale_source_count,
    )


@router.get("/libraries/{library_id}/intelligence")
def get_library_dossier(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = dossier_service.get_artifact(db, viewer_id=viewer.user_id, library_id=library_id)
    return ok(_artifact_out(view))


@router.post("/libraries/{library_id}/intelligence/generate", status_code=202)
def generate_library_dossier(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)],
    body: Annotated[DossierGenerateRequest | None, Body()] = None,
) -> dict:
    ref = dossier_service.generate_artifact(
        db,
        viewer_id=viewer.user_id,
        library_id=library_id,
        idempotency_key=idempotency_key,
        instruction=body.instruction if body is not None else None,
    )
    return ok(
        DossierGenerateOut(
            artifact_id=ref.artifact_id,
            artifact_ref=f"artifact:{ref.artifact_id}",
            revision_id=ref.revision_id,
            revision_ref=f"artifact_revision:{ref.revision_id}",
        )
    )


@router.get("/libraries/{library_id}/intelligence/revisions")
def list_library_dossier_revisions(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    revisions = revisions_service.list_revisions(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    return ok(
        DossierRevisionsOut(
            revisions=[
                DossierRevisionSummaryOut(
                    artifact_id=revision.artifact_id,
                    artifact_ref=f"artifact:{revision.artifact_id}",
                    revision_id=revision.revision_id,
                    revision_ref=f"artifact_revision:{revision.revision_id}",
                    status=cast("RevisionStatus", revision.status),
                    created_at=revision.created_at,
                    promoted_at=revision.promoted_at,
                    is_current=revision.is_current,
                    citation_count=revision.citation_count,
                    source_count=revision.source_count,
                    covered_source_count=revision.covered_source_count,
                    omitted_source_count=revision.omitted_source_count,
                    custom_instruction=revision.custom_instruction,
                    model_provider=revision.model_provider,
                    model_name=revision.model_name,
                    total_tokens=revision.total_tokens,
                )
                for revision in revisions
            ]
        )
    )


@router.get("/libraries/{library_id}/intelligence/revisions/{revision_id}")
def get_library_dossier_revision(
    library_id: UUID,
    revision_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = revisions_service.get_revision(
        db, viewer_id=viewer.user_id, library_id=library_id, revision_id=revision_id
    )
    return ok(
        DossierRevisionOut(
            artifact_id=view.artifact_id,
            artifact_ref=f"artifact:{view.artifact_id}",
            revision_id=view.revision_id,
            revision_ref=f"artifact_revision:{view.revision_id}",
            status=cast("RevisionStatus", view.status),
            content_md=view.content_md,
            citations=view.citations,
            source_count=view.source_count,
            covered_source_count=view.covered_source_count,
            omitted_source_count=view.omitted_source_count,
            citation_count=len(view.citations),
            custom_instruction=view.custom_instruction,
            model_provider=view.model_provider,
            model_name=view.model_name,
            total_tokens=view.total_tokens,
            created_at=view.created_at,
            promoted_at=view.promoted_at,
            is_current=view.is_current,
        )
    )


@router.post("/libraries/{library_id}/intelligence/revisions/{revision_id}/promote")
def promote_library_dossier_revision(
    library_id: UUID,
    revision_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = dossier_service.promote_revision(
        db, viewer_id=viewer.user_id, library_id=library_id, revision_id=revision_id
    )
    return ok(_artifact_out(view))
