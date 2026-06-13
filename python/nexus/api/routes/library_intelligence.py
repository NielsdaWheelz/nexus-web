"""Library intelligence routes (stable head + immutable revisions)."""

from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.library_intelligence import (
    LibraryIntelligenceArtifactOut,
    LibraryIntelligenceBuildOut,
    LibraryIntelligenceGenerateOut,
    LibraryIntelligenceRevisionOut,
    LibraryIntelligenceRevisionsOut,
    LibraryIntelligenceRevisionSummaryOut,
    RevisionStatus,
)
from nexus.services import library_intelligence as library_intelligence_service
from nexus.services import library_intelligence_revisions as revisions_service

router = APIRouter(tags=["library-intelligence"])


def _artifact_out(
    view: library_intelligence_service.ArtifactView,
) -> LibraryIntelligenceArtifactOut:
    build = (
        LibraryIntelligenceBuildOut(
            revision_id=view.build.revision_id,
            status=cast("RevisionStatus", view.build.status),
        )
        if view.build is not None
        else None
    )
    return LibraryIntelligenceArtifactOut(
        artifact_id=view.artifact_id,
        artifact_ref=(
            f"library_intelligence_artifact:{view.artifact_id}"
            if view.artifact_id is not None
            else None
        ),
        revision_id=view.revision_id,
        revision_ref=(
            f"library_intelligence_revision:{view.revision_id}"
            if view.revision_id is not None
            else None
        ),
        status=view.status,
        content_md=view.content_md,
        citations=view.citations,
        build=build,
        stale_source_count=view.stale_source_count,
    )


@router.get("/libraries/{library_id}/intelligence")
def get_library_intelligence(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = library_intelligence_service.get_artifact(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    return ok(_artifact_out(view))


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
            artifact_ref=f"library_intelligence_artifact:{ref.artifact_id}",
            revision_id=ref.revision_id,
            revision_ref=f"library_intelligence_revision:{ref.revision_id}",
        )
    )


@router.get("/libraries/{library_id}/intelligence/revisions")
def list_library_intelligence_revisions(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    revisions = revisions_service.list_revisions(
        db, viewer_id=viewer.user_id, library_id=library_id
    )
    return ok(
        LibraryIntelligenceRevisionsOut(
            revisions=[
                LibraryIntelligenceRevisionSummaryOut(
                    artifact_id=revision.artifact_id,
                    artifact_ref=f"library_intelligence_artifact:{revision.artifact_id}",
                    revision_id=revision.revision_id,
                    revision_ref=f"library_intelligence_revision:{revision.revision_id}",
                    status=cast("RevisionStatus", revision.status),
                    created_at=revision.created_at,
                    promoted_at=revision.promoted_at,
                    is_current=revision.is_current,
                    citation_count=revision.citation_count,
                )
                for revision in revisions
            ]
        )
    )


@router.get("/libraries/{library_id}/intelligence/revisions/{revision_id}")
def get_library_intelligence_revision(
    library_id: UUID,
    revision_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = revisions_service.get_revision(
        db, viewer_id=viewer.user_id, library_id=library_id, revision_id=revision_id
    )
    return ok(
        LibraryIntelligenceRevisionOut(
            artifact_id=view.artifact_id,
            artifact_ref=f"library_intelligence_artifact:{view.artifact_id}",
            revision_id=view.revision_id,
            revision_ref=f"library_intelligence_revision:{view.revision_id}",
            status=cast("RevisionStatus", view.status),
            content_md=view.content_md,
            citations=view.citations,
            created_at=view.created_at,
            promoted_at=view.promoted_at,
            is_current=view.is_current,
        )
    )


@router.post("/libraries/{library_id}/intelligence/revisions/{revision_id}/promote")
def promote_library_intelligence_revision(
    library_id: UUID,
    revision_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    view = library_intelligence_service.promote_revision(
        db,
        viewer_id=viewer.user_id,
        library_id=library_id,
        revision_id=revision_id,
    )
    return ok(_artifact_out(view))
