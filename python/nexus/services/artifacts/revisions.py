"""Generic dossier revision read models (list + get + viewer assert).

Recomposed for the universal head/build/revision normalization: history is read
per artifact head (join ``revision -> build -> artifact``), authorization is the
head's derived :class:`AudienceScope` (a user match, or library membership), and
the model provenance join is the build-owned ``llm_calls`` (``owner_kind =
'artifact_build'``) with no per-operation filter. Coverage is binding-owned and
derived by the route from the revision's typed ``input_manifest``; it is no longer
computed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.citation import CitationOut
from nexus.services.resource_graph.citations import build_citation_outs
from nexus.services.resource_graph.refs import ResourceRef


@dataclass(frozen=True)
class RevisionView:
    artifact_id: UUID
    revision_id: UUID
    content_md: str
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citations: list[CitationOut]
    input_manifest: dict[str, Any]
    instruction: str | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


@dataclass(frozen=True)
class RevisionSummary:
    artifact_id: UUID
    revision_id: UUID
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    citation_count: int
    instruction: str | None
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
                SELECT r.id, r.created_at, r.promoted_at,
                       bld.instruction,
                       lc.provider AS model_provider,
                       lc.model_name AS model_name,
                       lc.total_tokens AS total_tokens,
                       COUNT(e.id) AS citation_count
                FROM artifact_revisions r
                JOIN artifact_builds bld ON bld.id = r.build_id
                LEFT JOIN LATERAL (
                    SELECT provider, model_name, total_tokens
                    FROM llm_calls
                    WHERE owner_kind = 'artifact_build'
                      AND owner_id = bld.id
                      AND outcome = 'succeeded'
                    ORDER BY call_seq DESC
                    LIMIT 1
                ) lc ON true
                LEFT JOIN resource_edges e
                  ON e.source_scheme = 'artifact_revision'
                 AND e.source_id = r.id
                 AND e.origin = 'citation'
                 AND e.ordinal IS NOT NULL
                WHERE bld.artifact_id = :artifact_id
                GROUP BY r.id, r.created_at, r.promoted_at, bld.instruction,
                         lc.provider, lc.model_name, lc.total_tokens
                ORDER BY r.created_at DESC, r.id DESC
                """
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .all()
    )
    return [
        RevisionSummary(
            artifact_id=artifact_id,
            revision_id=UUID(str(row["id"])),
            created_at=row["created_at"],
            promoted_at=row["promoted_at"],
            is_current=current is not None and UUID(str(row["id"])) == current,
            citation_count=int(row["citation_count"]),
            instruction=(str(row["instruction"]) if row["instruction"] is not None else None),
            model_provider=(
                str(row["model_provider"]) if row["model_provider"] is not None else None
            ),
            model_name=str(row["model_name"]) if row["model_name"] is not None else None,
            total_tokens=int(row["total_tokens"]) if row["total_tokens"] is not None else None,
        )
        for row in rows
    ]


def get_revision(db: Session, *, viewer_id: UUID, revision_id: UUID) -> RevisionView:
    """One revision's full content + citations, 404-masked by head audience."""
    row = (
        db.execute(
            text(
                """
                SELECT bld.artifact_id, bld.instruction,
                       r.content_md, r.created_at, r.promoted_at, r.input_manifest,
                       r.citation_owner_user_id,
                       a.current_revision_id, a.audience_scheme, a.audience_id,
                       lc.provider AS model_provider,
                       lc.model_name AS model_name,
                       lc.total_tokens AS total_tokens
                FROM artifact_revisions r
                JOIN artifact_builds bld ON bld.id = r.build_id
                JOIN artifacts a ON a.id = bld.artifact_id
                LEFT JOIN LATERAL (
                    SELECT provider, model_name, total_tokens
                    FROM llm_calls
                    WHERE owner_kind = 'artifact_build'
                      AND owner_id = bld.id
                      AND outcome = 'succeeded'
                    ORDER BY call_seq DESC
                    LIMIT 1
                ) lc ON true
                WHERE r.id = :revision_id
                """
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .first()
    )
    if row is None or not _audience_ok(
        db,
        audience_scheme=str(row["audience_scheme"]),
        audience_id=str(row["audience_id"]),
        viewer_id=viewer_id,
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    citation_owner = UUID(str(row["citation_owner_user_id"]))
    citations = build_citation_outs(
        db,
        viewer_id=citation_owner,
        source=ResourceRef(scheme="artifact_revision", id=revision_id),
    )
    current = row["current_revision_id"]
    return RevisionView(
        artifact_id=UUID(str(row["artifact_id"])),
        revision_id=revision_id,
        content_md=str(row["content_md"] or ""),
        created_at=row["created_at"],
        promoted_at=row["promoted_at"],
        is_current=current is not None and UUID(str(current)) == revision_id,
        citations=citations,
        input_manifest=dict(row["input_manifest"])
        if isinstance(row["input_manifest"], dict)
        else {},
        instruction=str(row["instruction"]) if row["instruction"] is not None else None,
        model_provider=str(row["model_provider"]) if row["model_provider"] is not None else None,
        model_name=str(row["model_name"]) if row["model_name"] is not None else None,
        total_tokens=int(row["total_tokens"]) if row["total_tokens"] is not None else None,
    )


def assert_revision_viewer(db: Session, *, viewer_id: UUID, revision_id: UUID) -> None:
    """Ownership assert for the revision read (404-masked by head audience)."""
    row = (
        db.execute(
            text(
                "SELECT a.audience_scheme, a.audience_id "
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
    if row is None or not _audience_ok(
        db,
        audience_scheme=str(row["audience_scheme"]),
        audience_id=str(row["audience_id"]),
        viewer_id=viewer_id,
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")


def _assert_artifact_viewer(db: Session, *, viewer_id: UUID, artifact_id: UUID) -> UUID | None:
    """Assert the viewer may read the head's audience; return its current revision."""
    row = (
        db.execute(
            text(
                "SELECT current_revision_id, audience_scheme, audience_id "
                "FROM artifacts WHERE id = :artifact_id"
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None or not _audience_ok(
        db,
        audience_scheme=str(row["audience_scheme"]),
        audience_id=str(row["audience_id"]),
        viewer_id=viewer_id,
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact not found")
    return UUID(str(row["current_revision_id"])) if row["current_revision_id"] is not None else None


def _audience_ok(db: Session, *, audience_scheme: str, audience_id: str, viewer_id: UUID) -> bool:
    if audience_scheme == "user":
        return UUID(audience_id) == viewer_id
    if audience_scheme == "library":
        return is_library_member(db, viewer_id, UUID(audience_id))
    return False
