"""Generic dossier revision read models (list + get + viewer assert).

Recomposed for the universal head/build/revision normalization: history is read
per artifact head (join ``revision -> build -> artifact``), authorization is the
head's derived :class:`AudienceScope` (a user match, or library membership), and
model provenance is read in bulk through the typed generation ledger. Coverage
is binding-owned and derived by the route from the revision's typed
``input_manifest``; it is no longer computed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.citation import CitationOut
from nexus.services.artifacts.subject_policy import visible_persisted_subject
from nexus.services.llm_ledger import LlmCallOwner, read_latest_generations_for_owners
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef


@dataclass(frozen=True)
class RevisionView:
    artifact_id: UUID
    subject_scheme: str
    revision_id: UUID
    content_html: str
    content_text: str
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citations: list[CitationOut]
    input_manifest: dict[str, Any]
    instruction: str | None
    creator_user_id: UUID | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


@dataclass(frozen=True)
class RevisionSummary:
    artifact_id: UUID
    subject_scheme: str
    revision_id: UUID
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citation_count: int
    input_manifest: dict[str, Any]
    instruction: str | None
    creator_user_id: UUID | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


def list_revisions(db: Session, *, viewer_id: UUID, artifact_id: UUID) -> list[RevisionSummary]:
    """The revision history for one artifact head (newest first), 404-masked."""
    current = _assert_artifact_viewer(db, viewer_id=viewer_id, artifact_id=artifact_id)
    rows = (
        db.execute(
            text(
                """
                SELECT r.id, bld.id AS build_id, a.subject_scheme,
                       r.created_at, r.promoted_at, r.input_manifest,
                       r.creator_user_id,
                       bld.instruction,
                       COUNT(e.id) AS citation_count
                FROM artifact_revisions r
                JOIN artifact_builds bld ON bld.id = r.build_id
                JOIN artifacts a ON a.id = bld.artifact_id
                LEFT JOIN resource_edges e
                  ON e.source_scheme = 'artifact_revision'
                 AND e.source_id = r.id
                 AND e.origin = 'citation'
                 AND e.ordinal IS NOT NULL
                WHERE bld.artifact_id = :artifact_id
                GROUP BY r.id, bld.id, a.subject_scheme, r.created_at, r.promoted_at,
                         r.input_manifest, r.creator_user_id, bld.instruction
                ORDER BY r.created_at DESC, r.id DESC
                """
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .all()
    )
    generations_by_owner = read_latest_generations_for_owners(
        db,
        owners=[LlmCallOwner(kind="artifact_build", id=UUID(str(row["build_id"]))) for row in rows],
        outcome="Succeeded",
    )
    summaries: list[RevisionSummary] = []
    for row in rows:
        revision_id = UUID(str(row["id"]))
        generation = generations_by_owner.get(
            LlmCallOwner(kind="artifact_build", id=UUID(str(row["build_id"])))
        )
        summaries.append(
            RevisionSummary(
                artifact_id=artifact_id,
                subject_scheme=str(row["subject_scheme"]),
                revision_id=revision_id,
                created_at=row["created_at"],
                promoted_at=row["promoted_at"],
                is_current=current is not None and revision_id == current,
                citation_count=int(row["citation_count"]),
                input_manifest=(
                    dict(row["input_manifest"]) if isinstance(row["input_manifest"], dict) else {}
                ),
                instruction=(str(row["instruction"]) if row["instruction"] is not None else None),
                creator_user_id=(
                    UUID(str(row["creator_user_id"]))
                    if row["creator_user_id"] is not None
                    else None
                ),
                model_provider=generation.backend if generation is not None else None,
                model_name=generation.model_name if generation is not None else None,
                total_tokens=generation.total_tokens if generation is not None else None,
            )
        )
    return summaries


def get_revision(db: Session, *, viewer_id: UUID, revision_id: UUID) -> RevisionView:
    """One revision's full content + citations, 404-masked by head audience."""
    row = (
        db.execute(
            text(
                """
                SELECT bld.id AS build_id, bld.artifact_id, bld.instruction,
                       r.content_html, r.content_text,
                       r.created_at, r.promoted_at, r.input_manifest,
                       r.creator_user_id,
                       r.citation_owner_user_id,
                       a.current_revision_id, a.subject_scheme, a.subject_id,
                       a.audience_scheme, a.audience_id
                FROM artifact_revisions r
                JOIN artifact_builds bld ON bld.id = r.build_id
                JOIN artifacts a ON a.id = bld.artifact_id
                WHERE r.id = :revision_id
                """
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    _assert_subject_and_audience_viewer(
        db,
        row=row,
        viewer_id=viewer_id,
        message="Revision not found",
    )
    build_owner = LlmCallOwner(kind="artifact_build", id=UUID(str(row["build_id"])))
    generation = read_latest_generations_for_owners(
        db,
        owners=[build_owner],
        outcome="Succeeded",
    ).get(build_owner)
    citation_owner = UUID(str(row["citation_owner_user_id"]))
    source = ResourceRef(scheme="artifact_revision", id=revision_id)
    citations = build_citation_outs_for_sources(
        db,
        viewer_id=viewer_id,
        edge_owner_id=citation_owner,
        sources=[source],
    )[source.uri]
    current = row["current_revision_id"]
    return RevisionView(
        artifact_id=UUID(str(row["artifact_id"])),
        subject_scheme=str(row["subject_scheme"]),
        revision_id=revision_id,
        content_html=str(row["content_html"]),
        content_text=str(row["content_text"]),
        created_at=row["created_at"],
        promoted_at=row["promoted_at"],
        is_current=current is not None and UUID(str(current)) == revision_id,
        citations=citations,
        input_manifest=dict(row["input_manifest"])
        if isinstance(row["input_manifest"], dict)
        else {},
        instruction=str(row["instruction"]) if row["instruction"] is not None else None,
        creator_user_id=(
            UUID(str(row["creator_user_id"])) if row["creator_user_id"] is not None else None
        ),
        model_provider=generation.backend if generation is not None else None,
        model_name=generation.model_name if generation is not None else None,
        total_tokens=generation.total_tokens if generation is not None else None,
    )


def assert_revision_viewer(db: Session, *, viewer_id: UUID, revision_id: UUID) -> None:
    """Ownership assert for the revision read (404-masked by head audience)."""
    row = (
        db.execute(
            text(
                "SELECT a.subject_scheme, a.subject_id, "
                "a.audience_scheme, a.audience_id "
                "FROM artifact_revisions r "
                "JOIN artifact_builds b ON b.id = r.build_id "
                "JOIN artifacts a ON a.id = b.artifact_id "
                "WHERE r.id = :revision_id"
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    _assert_subject_and_audience_viewer(
        db,
        row=row,
        viewer_id=viewer_id,
        message="Revision not found",
    )


def _assert_artifact_viewer(db: Session, *, viewer_id: UUID, artifact_id: UUID) -> UUID | None:
    """Assert the viewer may read the head's audience; return its current revision."""
    row = (
        db.execute(
            text(
                "SELECT current_revision_id, subject_scheme, subject_id, "
                "audience_scheme, audience_id "
                "FROM artifacts WHERE id = :artifact_id"
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact not found")
    _assert_subject_and_audience_viewer(
        db,
        row=row,
        viewer_id=viewer_id,
        message="Artifact not found",
    )
    return UUID(str(row["current_revision_id"])) if row["current_revision_id"] is not None else None


def _assert_subject_and_audience_viewer(
    db: Session,
    *,
    row: RowMapping,
    viewer_id: UUID,
    message: str,
) -> None:
    subject_scheme = str(row["subject_scheme"])
    subject_id = UUID(str(row["subject_id"]))
    if (
        visible_persisted_subject(
            db,
            subject_scheme=subject_scheme,
            subject_id=subject_id,
            audience_scheme=str(row["audience_scheme"]),
            audience_id=str(row["audience_id"]),
            viewer_id=viewer_id,
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, message)
