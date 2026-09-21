"""Dossier revision reads: the history list and one full revision.

History is read per head (``revision -> build -> artifact``) and authorized by
the head's audience; model provenance comes from the immutable generation
ledger. Coverage is derived by the route from each revision's typed manifest.
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
from nexus.services.artifacts.subjects import visible_persisted_subject
from nexus.services.generation_spec import (
    CodexPersonalSelection,
    ProviderApiSelection,
    ProviderDispatchTargetSnapshot,
    read_generation_history,
)
from nexus.services.llm_ledger import (
    GenerationRecord,
    LlmCallOwner,
    ModelTurnRecord,
    read_latest_generations_for_owners,
    read_model_turns_for_generations,
)
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef


@dataclass(frozen=True)
class RevisionFacts:
    """Everything both revision reads carry."""

    artifact_id: UUID
    revision_id: UUID
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool
    input_manifest: dict[str, Any]
    instruction: str | None
    creator_user_id: UUID | None
    model_provider: str | None
    model_name: str | None
    total_tokens: int | None


@dataclass(frozen=True)
class RevisionSummary(RevisionFacts):
    """One history entry: no body, a citation count instead of the citations."""

    citation_count: int


@dataclass(frozen=True)
class RevisionView(RevisionFacts):
    """One revision with its body — the boundary the history list does not cross."""

    content_html: str
    content_text: str
    citations: list[CitationOut]


def list_revisions(db: Session, *, viewer_id: UUID, artifact_id: UUID) -> list[RevisionSummary]:
    """The revision history for one head, newest first, 404-masked."""
    current = _assert_artifact_viewer(db, viewer_id=viewer_id, artifact_id=artifact_id)
    rows = (
        db.execute(
            text(
                """
                SELECT r.id, bld.id AS build_id,
                       r.created_at, r.promoted_at, r.input_manifest,
                       r.creator_user_id, bld.instruction,
                       COUNT(e.id) AS citation_count
                FROM artifact_revisions r
                JOIN artifact_builds bld ON bld.id = r.build_id
                LEFT JOIN resource_edges e
                  ON e.source_scheme = 'artifact_revision'
                 AND e.source_id = r.id
                 AND e.origin = 'citation'
                 AND e.ordinal IS NOT NULL
                WHERE bld.artifact_id = :artifact_id
                GROUP BY r.id, bld.id, r.created_at, r.promoted_at,
                         r.input_manifest, r.creator_user_id, bld.instruction
                ORDER BY r.created_at DESC, r.id DESC
                """
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .all()
    )
    provenance = _provenance_by_owner(db, [_owner(row) for row in rows])
    summaries: list[RevisionSummary] = []
    for row in rows:
        revision_id = UUID(str(row["id"]))
        provider, model, total_tokens = provenance[_owner(row)]
        summaries.append(
            RevisionSummary(
                artifact_id=artifact_id,
                revision_id=revision_id,
                created_at=row["created_at"],
                promoted_at=row["promoted_at"],
                is_current=revision_id == current,
                input_manifest=_manifest(row["input_manifest"]),
                instruction=(str(row["instruction"]) if row["instruction"] is not None else None),
                creator_user_id=_optional_uuid(row["creator_user_id"]),
                model_provider=provider,
                model_name=model,
                total_tokens=total_tokens,
                citation_count=int(row["citation_count"]),
            )
        )
    return summaries


def get_revision(db: Session, *, viewer_id: UUID, revision_id: UUID) -> RevisionView:
    """One revision's full content and citations, 404-masked by head audience."""
    row = (
        db.execute(
            text(
                """
                SELECT bld.id AS build_id, bld.artifact_id, bld.instruction,
                       r.content_html, r.content_text,
                       r.created_at, r.promoted_at, r.input_manifest,
                       r.creator_user_id, r.citation_owner_user_id,
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
    _assert_head_viewer(db, row=row, viewer_id=viewer_id, message="Revision not found")
    owner = _owner(row)
    provider, model, total_tokens = _provenance_by_owner(db, [owner])[owner]
    source = ResourceRef(scheme="artifact_revision", id=revision_id)
    return RevisionView(
        artifact_id=UUID(str(row["artifact_id"])),
        revision_id=revision_id,
        created_at=row["created_at"],
        promoted_at=row["promoted_at"],
        is_current=_optional_uuid(row["current_revision_id"]) == revision_id,
        input_manifest=_manifest(row["input_manifest"]),
        instruction=str(row["instruction"]) if row["instruction"] is not None else None,
        creator_user_id=_optional_uuid(row["creator_user_id"]),
        model_provider=provider,
        model_name=model,
        total_tokens=total_tokens,
        content_html=str(row["content_html"]),
        content_text=str(row["content_text"]),
        citations=build_citation_outs_for_sources(
            db,
            viewer_id=viewer_id,
            edge_owner_id=UUID(str(row["citation_owner_user_id"])),
            sources=[source],
        )[source.uri],
    )


def _owner(row: RowMapping) -> LlmCallOwner:
    return LlmCallOwner(kind="artifact_build", id=UUID(str(row["build_id"])))


def _provenance_by_owner(
    db: Session, owners: list[LlmCallOwner]
) -> dict[LlmCallOwner, tuple[str | None, str | None, int | None]]:
    """Read every build's succeeded generation and its usage in two queries."""
    generations = read_latest_generations_for_owners(db, owners=owners, outcome="Succeeded")
    turns = read_model_turns_for_generations(
        db, generation_ids=[generation.id for generation in generations.values()]
    )
    projected: dict[LlmCallOwner, tuple[str | None, str | None, int | None]] = {}
    for owner in owners:
        generation = generations.get(owner)
        projected[owner] = _provenance(
            generation, () if generation is None else turns.get(generation.id, ())
        )
    return projected


def _provenance(
    generation: GenerationRecord | None,
    turns: tuple[ModelTurnRecord, ...],
) -> tuple[str | None, str | None, int | None]:
    if generation is None:
        return None, None, None
    spec = read_generation_history(generation.spec)
    if isinstance(spec.selection, CodexPersonalSelection):
        provider, model = "codex-personal", spec.selection.model
    elif isinstance(spec.selection, ProviderApiSelection):
        target = spec.resolved_dispatch_target
        if not isinstance(target, ProviderDispatchTargetSnapshot):
            raise AssertionError("ProviderApi generation lost its provider target")
        provider, model = str(target.provider), spec.selection.model_ref
    else:
        raise AssertionError("generation selection is not exhaustive")
    totals: list[int] = []
    for turn in turns:
        if turn.usage is None:
            return provider, model, None
        value = turn.usage.get("total_tokens")
        if type(value) is not int or value < 0:
            return provider, model, None
        totals.append(value)
    return provider, model, sum(totals) if totals else None


def _assert_artifact_viewer(db: Session, *, viewer_id: UUID, artifact_id: UUID) -> UUID | None:
    """Authorize the head's audience; return its current revision id."""
    row = (
        db.execute(
            text(
                "SELECT current_revision_id, subject_scheme, subject_id, "
                "audience_scheme, audience_id FROM artifacts WHERE id = :artifact_id"
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact not found")
    _assert_head_viewer(db, row=row, viewer_id=viewer_id, message="Artifact not found")
    return _optional_uuid(row["current_revision_id"])


def _assert_head_viewer(db: Session, *, row: RowMapping, viewer_id: UUID, message: str) -> None:
    if (
        visible_persisted_subject(
            db,
            subject_scheme=str(row["subject_scheme"]),
            subject_id=UUID(str(row["subject_id"])),
            audience_scheme=str(row["audience_scheme"]),
            audience_id=str(row["audience_id"]),
            viewer_id=viewer_id,
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, message)


def _manifest(raw: object) -> dict[str, Any]:
    return dict(raw) if isinstance(raw, dict) else {}


def _optional_uuid(value: object) -> UUID | None:
    return UUID(str(value)) if value is not None else None
