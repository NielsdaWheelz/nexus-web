"""Library intelligence routes (stable head + immutable revisions)."""

from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.library_intelligence import (
    LibraryIntelligenceArtifactOut,
    LibraryIntelligenceBuildOut,
    LibraryIntelligenceGenerateOut,
    LibraryIntelligenceRevisionsOut,
    LibraryIntelligenceRevisionSummaryOut,
    RevisionStatus,
)
from nexus.services import library_intelligence as library_intelligence_service
from nexus.services.retrieval_citation import build_citation_outs_for_revision

router = APIRouter(tags=["library-intelligence"])


@router.get("/libraries/{library_id}/intelligence")
def get_library_intelligence(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = library_intelligence_service.get_artifact(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    citations = (
        build_citation_outs_for_revision(db, revision_id=view.revision_id)
        if view.revision_id is not None
        else []
    )
    build = (
        LibraryIntelligenceBuildOut(
            revision_id=view.build.revision_id,
            status=cast("RevisionStatus", view.build.status),
        )
        if view.build is not None
        else None
    )
    return ok(
        LibraryIntelligenceArtifactOut(
            artifact_id=view.artifact_id,
            revision_id=view.revision_id,
            status=view.status,
            content_md=view.content_md,
            citations=citations,
            build=build,
            stale_source_count=view.stale_source_count,
        )
    )


@router.post("/libraries/{library_id}/intelligence/generate", status_code=202)
def generate_library_intelligence(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=256)],
) -> dict:
    ref = library_intelligence_service.generate_artifact(
        db,
        viewer_id=viewer.user_id,
        library_id=library_id,
        idempotency_key=idempotency_key,
    )
    return ok(
        LibraryIntelligenceGenerateOut(
            artifact_id=ref.artifact_id,
            revision_id=ref.revision_id,
            run_id=ref.revision_id,
        )
    )


@router.get("/libraries/{library_id}/intelligence/revisions")
def list_library_intelligence_revisions(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    revisions = library_intelligence_service.list_revisions(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    return ok(
        LibraryIntelligenceRevisionsOut(
            revisions=[
                LibraryIntelligenceRevisionSummaryOut(
                    revision_id=revision.revision_id,
                    status=cast("RevisionStatus", revision.status),
                    created_at=revision.created_at,
                    promoted_at=revision.promoted_at,
                    is_current=revision.is_current,
                )
                for revision in revisions
            ]
        )
    )


@router.post("/libraries/{library_id}/intelligence/revisions/{revision_id}/promote")
def promote_library_intelligence_revision(
    library_id: UUID,
    revision_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    library_intelligence_service.promote_revision(
        db, viewer_id=viewer.user_id, revision_id=revision_id
    )
    return success_response(None)
