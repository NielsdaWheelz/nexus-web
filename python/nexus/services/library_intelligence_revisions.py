"""Library Intelligence revision read models."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.citation import CitationOut
from nexus.services.library_intelligence import coverage_counts
from nexus.services.resource_graph.citations import build_citation_outs
from nexus.services.resource_graph.refs import ResourceRef


@dataclass(frozen=True)
class RevisionView:
    artifact_id: UUID
    revision_id: UUID
    status: str
    content_md: str
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citations: list[CitationOut]
    source_count: int
    covered_source_count: int
    omitted_source_count: int
    custom_instruction: str | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


@dataclass(frozen=True)
class RevisionSummary:
    artifact_id: UUID
    revision_id: UUID
    status: str
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citation_count: int
    source_count: int
    covered_source_count: int
    omitted_source_count: int
    custom_instruction: str | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


def list_revisions(db: Session, *, viewer_id: UUID, library_id: UUID) -> list[RevisionSummary]:
    _require_member(db, viewer_id, library_id)
    head = (
        db.execute(
            text(
                "SELECT id, current_revision_id FROM library_intelligence_artifacts "
                "WHERE library_id = :library_id"
            ),
            {"library_id": library_id},
        )
        .mappings()
        .first()
    )
    if head is None:
        return []
    current = (
        UUID(str(head["current_revision_id"])) if head["current_revision_id"] is not None else None
    )
    rows = (
        db.execute(
            text(
                """
                SELECT r.id, r.status, r.created_at, r.promoted_at,
                       r.custom_instruction, r.covered_targets,
                       lc.provider AS model_provider,
                       lc.model_name AS model_name,
                       lc.total_tokens AS total_tokens,
                       COUNT(e.id) AS citation_count
                FROM library_intelligence_artifact_revisions r
                LEFT JOIN LATERAL (
                    SELECT provider, model_name, total_tokens
                    FROM llm_calls
                    WHERE owner_kind = 'li_revision'
                      AND owner_id = r.id
                      AND llm_operation = 'li_reduce'
                      AND error_class IS NULL
                    ORDER BY call_seq DESC
                    LIMIT 1
                ) lc ON true
                LEFT JOIN resource_edges e
                  ON e.source_scheme = 'library_intelligence_revision'
                 AND e.source_id = r.id
                 AND e.origin = 'citation'
                 AND e.ordinal IS NOT NULL
                WHERE r.artifact_id = :artifact_id
                GROUP BY r.id, r.status, r.created_at, r.promoted_at,
                         r.custom_instruction, r.covered_targets,
                         lc.provider, lc.model_name, lc.total_tokens
                ORDER BY created_at DESC, id DESC
                """
            ),
            {"artifact_id": head["id"]},
        )
        .mappings()
        .all()
    )
    summaries: list[RevisionSummary] = []
    for row in rows:
        source_count, covered_source_count, omitted_source_count = coverage_counts(
            row["covered_targets"]
        )
        summaries.append(
            RevisionSummary(
                artifact_id=UUID(str(head["id"])),
                revision_id=UUID(str(row["id"])),
                status=str(row["status"]),
                created_at=row["created_at"],
                promoted_at=row["promoted_at"],
                is_current=current is not None and UUID(str(row["id"])) == current,
                citation_count=int(row["citation_count"]),
                source_count=source_count,
                covered_source_count=covered_source_count,
                omitted_source_count=omitted_source_count,
                custom_instruction=(
                    str(row["custom_instruction"])
                    if row["custom_instruction"] is not None
                    else None
                ),
                model_provider=(
                    str(row["model_provider"]) if row["model_provider"] is not None else None
                ),
                model_name=str(row["model_name"]) if row["model_name"] is not None else None,
                total_tokens=int(row["total_tokens"]) if row["total_tokens"] is not None else None,
            )
        )
    return summaries


def get_revision(
    db: Session, *, viewer_id: UUID, library_id: UUID, revision_id: UUID
) -> RevisionView:
    _require_member(db, viewer_id, library_id)
    row = (
        db.execute(
            text(
                """
                SELECT r.artifact_id, r.status, r.content_md, r.created_at,
                       r.promoted_at, r.custom_instruction, r.covered_targets,
                       lc.provider AS model_provider,
                       lc.model_name AS model_name,
                       lc.total_tokens AS total_tokens,
                       a.current_revision_id, a.user_id
                FROM library_intelligence_artifact_revisions r
                JOIN library_intelligence_artifacts a ON a.id = r.artifact_id
                LEFT JOIN LATERAL (
                    SELECT provider, model_name, total_tokens
                    FROM llm_calls
                    WHERE owner_kind = 'li_revision'
                      AND owner_id = r.id
                      AND llm_operation = 'li_reduce'
                      AND error_class IS NULL
                    ORDER BY call_seq DESC
                    LIMIT 1
                ) lc ON true
                WHERE r.id = :revision_id AND a.library_id = :library_id
                """
            ),
            {"revision_id": revision_id, "library_id": library_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    citations = build_citation_outs(
        db,
        viewer_id=UUID(str(row["user_id"])),
        source=ResourceRef(scheme="library_intelligence_revision", id=revision_id),
    )
    source_count, covered_source_count, omitted_source_count = coverage_counts(
        row["covered_targets"]
    )
    return RevisionView(
        artifact_id=UUID(str(row["artifact_id"])),
        revision_id=revision_id,
        status=str(row["status"]),
        content_md=str(row["content_md"] or ""),
        created_at=row["created_at"],
        promoted_at=row["promoted_at"],
        is_current=UUID(str(row["current_revision_id"])) == revision_id
        if row["current_revision_id"] is not None
        else False,
        citations=citations,
        source_count=source_count,
        covered_source_count=covered_source_count,
        omitted_source_count=omitted_source_count,
        custom_instruction=(
            str(row["custom_instruction"]) if row["custom_instruction"] is not None else None
        ),
        model_provider=str(row["model_provider"]) if row["model_provider"] is not None else None,
        model_name=str(row["model_name"]) if row["model_name"] is not None else None,
        total_tokens=int(row["total_tokens"]) if row["total_tokens"] is not None else None,
    )


def _require_member(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    if not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
