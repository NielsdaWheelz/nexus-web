"""Conversation-distillate read model + on-demand distill facade.

The distillate is one artifact kind (``conversation_distillate``, subject
``conversation``). Head creation/promote/freshness live on the engine; this module
owns the conversation-facing read and the ``Distill`` verb (a thin
``create_revision`` call).
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.artifact import ArtifactStatus
from nexus.schemas.citation import CitationOut
from nexus.services import conversations as conversations_service
from nexus.services.artifacts import engine
from nexus.services.resource_graph.citations import build_citation_outs
from nexus.services.resource_graph.refs import ResourceRef

_KIND = "conversation_distillate"


@dataclass(frozen=True)
class DistillateBuild:
    revision_id: UUID
    status: str


@dataclass(frozen=True)
class DistillateView:
    artifact_id: UUID | None
    revision_id: UUID | None
    status: ArtifactStatus
    content_md: str
    build: DistillateBuild | None
    citations: list[CitationOut]


@dataclass(frozen=True)
class DistillRef:
    artifact_id: UUID
    revision_id: UUID
    status: str


def distill(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> DistillRef:
    """Enqueue a distillate revision for the viewer's active branch (the ``Distill`` verb)."""
    conversations_service.get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    subject_ref = ResourceRef(scheme="conversation", id=conversation_id)
    live = engine.reducer_for_kind(_KIND).live_fingerprint(db, subject_ref, viewer_id)
    signature = live[0] if live else {}
    key = f"distill:{signature.get('active_leaf_message_id')}:{signature.get('message_count')}"
    ref = engine.create_revision(
        db,
        viewer_id=viewer_id,
        subject_ref=subject_ref,
        kind=_KIND,
        idempotency_key=key,
    )
    return DistillRef(artifact_id=ref.artifact_id, revision_id=ref.revision_id, status=ref.status)


def read_distillate(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> DistillateView:
    """Return the conversation's current distillate content + citations + status."""
    conversations_service.get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    head = (
        db.execute(
            text(
                "SELECT id, current_revision_id FROM artifacts "
                "WHERE subject_scheme = 'conversation' AND subject_id = :cid AND kind = :kind"
            ),
            {"cid": conversation_id, "kind": _KIND},
        )
        .mappings()
        .first()
    )
    if head is None:
        return DistillateView(None, None, "unavailable", "", None, [])
    artifact_id = UUID(str(head["id"]))
    current_revision_id = (
        UUID(str(head["current_revision_id"])) if head["current_revision_id"] is not None else None
    )
    build = _latest_building_revision(db, artifact_id=artifact_id)
    if current_revision_id is None:
        if build is not None:
            return DistillateView(artifact_id, None, "building", "", build, [])
        latest = db.execute(
            text(
                "SELECT status FROM artifact_revisions WHERE artifact_id = :aid "
                "ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            {"aid": artifact_id},
        ).scalar_one_or_none()
        status: ArtifactStatus = "failed" if latest == "failed" else "unavailable"
        return DistillateView(artifact_id, None, status, "", None, [])

    content_md = db.execute(
        text("SELECT content_md FROM artifact_revisions WHERE id = :id"),
        {"id": current_revision_id},
    ).scalar_one_or_none()
    stale = engine.is_artifact_stale(
        db,
        subject_scheme="conversation",
        subject_id=conversation_id,
        kind=_KIND,
        current_revision_id=current_revision_id,
    )
    citations = build_citation_outs(
        db,
        viewer_id=viewer_id,
        source=ResourceRef(scheme="artifact_revision", id=current_revision_id),
    )
    return DistillateView(
        artifact_id,
        current_revision_id,
        "stale" if stale else "current",
        str(content_md or ""),
        build,
        citations,
    )


def _latest_building_revision(db: Session, *, artifact_id: UUID) -> DistillateBuild | None:
    row = (
        db.execute(
            text(
                "SELECT id, status FROM artifact_revisions "
                "WHERE artifact_id = :aid AND status = 'building' "
                "ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            {"aid": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return DistillateBuild(revision_id=UUID(str(row["id"])), status=str(row["status"]))
