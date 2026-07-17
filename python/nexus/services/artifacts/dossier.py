"""The library-dossier read model + REST-facing head owner.

The dossier is one artifact kind (``library_dossier``, subject ``library``). Head
creation/promote-on-success and freshness live on the engine; this module owns the
dossier GET read-model, the 202 generate facade (a thin ``create_revision`` call),
and restore-promote. The REST URLs are unchanged (D-7).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.artifact import ArtifactStatus
from nexus.schemas.citation import CitationOut
from nexus.services.artifacts import engine as artifacts_engine
from nexus.services.artifacts.reducers.library_dossier import (
    live_media_fingerprint_map,
    media_fingerprint_map,
)
from nexus.services.resource_graph.citations import build_citation_outs
from nexus.services.resource_graph.refs import ResourceRef

GENERATE_JOB_KIND = "library_dossier_generate"
_KIND = "library_dossier"


@dataclass(frozen=True)
class RevisionBuild:
    revision_id: UUID
    status: str


@dataclass(frozen=True)
class ArtifactView:
    artifact_id: UUID | None
    revision_id: UUID | None
    status: ArtifactStatus
    content_md: str
    build: RevisionBuild | None
    source_count: int = 0
    covered_source_count: int = 0
    omitted_source_count: int = 0
    custom_instruction: str | None = None
    model_provider: str | None = None
    model_name: str | None = None
    total_tokens: int | None = None
    stale_source_count: int | None = None
    citations: list[CitationOut] = field(default_factory=list)


@dataclass(frozen=True)
class RevisionRef:
    artifact_id: UUID
    revision_id: UUID
    status: str


def get_artifact(db: Session, *, viewer_id: UUID, library_id: UUID) -> ArtifactView:
    """Return the head's current-revision content, citations, and computed status."""
    _require_member(db, viewer_id, library_id)
    head = _head_row(db, library_id=library_id)
    if head is None:
        return ArtifactView(None, None, "unavailable", "", None)

    artifact_id = UUID(str(head["id"]))
    current_revision_id = (
        UUID(str(head["current_revision_id"])) if head["current_revision_id"] is not None else None
    )
    build = _latest_building_revision(db, artifact_id=artifact_id)

    if current_revision_id is None:
        if build is not None:
            return ArtifactView(artifact_id, None, "building", "", build)
        latest = _latest_revision_status(db, artifact_id=artifact_id)
        status: ArtifactStatus = "failed" if latest == "failed" else "unavailable"
        return ArtifactView(artifact_id, None, status, "", None)

    revision_row = (
        db.execute(
            text(
                """
                SELECT r.content_md, r.custom_instruction, r.covered_targets,
                       lc.provider AS model_provider,
                       lc.model_name AS model_name,
                       lc.total_tokens AS total_tokens
                FROM artifact_revisions r
                LEFT JOIN LATERAL (
                    SELECT provider, model_name, total_tokens
                    FROM llm_calls
                    WHERE owner_kind = 'artifact_revision'
                      AND owner_id = r.id
                      AND llm_operation = 'li_reduce'
                      AND error_class IS NULL
                    ORDER BY call_seq DESC
                    LIMIT 1
                ) lc ON true
                WHERE r.id = :revision_id
                """
            ),
            {"revision_id": current_revision_id},
        )
        .mappings()
        .one()
    )
    head_status, stale_source_count = _compute_freshness(
        db, library_id=library_id, current_revision_id=current_revision_id
    )
    source_count, covered_source_count, omitted_source_count = coverage_counts(
        revision_row["covered_targets"]
    )
    citations = build_citation_outs(
        db,
        viewer_id=UUID(str(head["user_id"])),
        source=ResourceRef(scheme="artifact_revision", id=current_revision_id),
    )
    return ArtifactView(
        artifact_id,
        current_revision_id,
        head_status,
        str(revision_row["content_md"] or ""),
        build,
        source_count=source_count,
        covered_source_count=covered_source_count,
        omitted_source_count=omitted_source_count,
        custom_instruction=(
            str(revision_row["custom_instruction"])
            if revision_row["custom_instruction"] is not None
            else None
        ),
        model_provider=(
            str(revision_row["model_provider"])
            if revision_row["model_provider"] is not None
            else None
        ),
        model_name=(
            str(revision_row["model_name"]) if revision_row["model_name"] is not None else None
        ),
        total_tokens=(
            int(revision_row["total_tokens"]) if revision_row["total_tokens"] is not None else None
        ),
        stale_source_count=stale_source_count,
        citations=citations,
    )


def coverage_counts(covered_targets: object) -> tuple[int, int, int]:
    """Return (source_count, covered_source_count, omitted_source_count)."""
    if not isinstance(covered_targets, list):
        return 0, 0, 0
    source_count = 0
    covered_source_count = 0
    omitted_source_count = 0
    for record in covered_targets:
        if not isinstance(record, dict) or record.get("kind") != "media":
            continue
        source_count += 1
        if record.get("coverage") in (None, "included"):
            covered_source_count += 1
        else:
            omitted_source_count += 1
    return source_count, covered_source_count, omitted_source_count


def _compute_freshness(
    db: Session, *, library_id: UUID, current_revision_id: UUID
) -> tuple[ArtifactStatus, int | None]:
    # The dossier's media set is viewer-scoped (spec §4.1); the freshness check
    # must use the SAME viewer the stored fingerprint was built with (the
    # library's owner_user_id — see artifacts/engine.py's collect_viewer/
    # _viewer_for_subject library branch), not the current reader's own
    # viewer_id, or two different members would see divergent staleness for the
    # one shared head.
    owner_user_id = artifacts_engine.library_owner_user_id(db, library_id=library_id)
    assert owner_user_id is not None  # library existence guaranteed by _require_member
    live = live_media_fingerprint_map(db, library_id=library_id, viewer_id=owner_user_id)
    covered = media_fingerprint_map(
        db.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :id"),
            {"id": current_revision_id},
        ).scalar_one_or_none()
        or []
    )
    if live == covered:
        return "current", None
    changed = {
        media_id
        for media_id in live.keys() | covered.keys()
        if live.get(media_id) != covered.get(media_id)
    }
    return "stale", len(changed)


def generate_artifact(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    idempotency_key: str,
    instruction: str | None = None,
) -> RevisionRef:
    """Find-or-create the head + an idempotency-keyed draft; enqueue (via the engine)."""
    _require_member(db, viewer_id, library_id)
    ref = artifacts_engine.create_revision(
        db,
        viewer_id=viewer_id,
        subject_ref=ResourceRef(scheme="library", id=library_id),
        kind=_KIND,
        idempotency_key=idempotency_key,
        custom_instruction=instruction,
    )
    return RevisionRef(artifact_id=ref.artifact_id, revision_id=ref.revision_id, status=ref.status)


def promote_revision(
    db: Session, *, viewer_id: UUID, library_id: UUID, revision_id: UUID
) -> ArtifactView:
    """Restore a prior ``ready`` revision as the head's current (last-wins)."""
    from nexus.db.retries import retry_serializable

    artifact_id, actual_library_id, _owner = _artifact_and_library_for_revision(
        db, revision_id=revision_id, viewer_id=viewer_id
    )
    if actual_library_id != library_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    _require_member(db, viewer_id, library_id)

    def op() -> None:
        status = db.execute(
            text("SELECT status FROM artifact_revisions WHERE id = :rev"),
            {"rev": revision_id},
        ).scalar_one()
        if status != "ready":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Only a ready revision can be promoted"
            )
        db.execute(
            text("UPDATE artifact_revisions SET promoted_at = now() WHERE id = :rev"),
            {"rev": revision_id},
        )
        db.execute(
            text(
                "UPDATE artifacts SET current_revision_id = :rev, updated_at = now() "
                "WHERE id = :artifact_id"
            ),
            {"rev": revision_id, "artifact_id": artifact_id},
        )
        db.commit()

    retry_serializable(db, "promote_revision", op)
    return get_artifact(db, viewer_id=viewer_id, library_id=library_id)


# ---------- internal loaders ------------------------------------------------


def _head_row(db: Session, *, library_id: UUID):
    return (
        db.execute(
            text(
                "SELECT id, current_revision_id, user_id FROM artifacts "
                "WHERE subject_scheme = 'library' AND subject_id = :lib AND kind = :kind"
            ),
            {"lib": library_id, "kind": _KIND},
        )
        .mappings()
        .first()
    )


def _require_member(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    if not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")


def _latest_building_revision(db: Session, *, artifact_id: UUID) -> RevisionBuild | None:
    row = (
        db.execute(
            text(
                "SELECT id, status FROM artifact_revisions "
                "WHERE artifact_id = :artifact_id AND status = 'building' "
                "ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return RevisionBuild(revision_id=UUID(str(row["id"])), status=str(row["status"]))


def _latest_revision_status(db: Session, *, artifact_id: UUID) -> str | None:
    return db.execute(
        text(
            "SELECT status FROM artifact_revisions "
            "WHERE artifact_id = :artifact_id ORDER BY created_at DESC, id DESC LIMIT 1"
        ),
        {"artifact_id": artifact_id},
    ).scalar_one_or_none()


def _artifact_and_library_for_revision(
    db: Session, *, revision_id: UUID, viewer_id: UUID | None = None
) -> tuple[UUID, UUID, UUID]:
    row = (
        db.execute(
            text(
                """
                SELECT a.id AS artifact_id, a.subject_id AS library_id, a.user_id
                FROM artifact_revisions r
                JOIN artifacts a ON a.id = r.artifact_id
                WHERE r.id = :revision_id AND a.subject_scheme = 'library'
                """
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    library_id = UUID(str(row["library_id"]))
    if viewer_id is not None and not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    return UUID(str(row["artifact_id"])), library_id, UUID(str(row["user_id"]))
