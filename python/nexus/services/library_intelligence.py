"""Slim library-intelligence artifact-head owner.

The sole writer of the stable head (``library_intelligence_artifacts``) and the
immutable revisions' lifecycle pointers. It creates a ``building`` draft +
enqueues the reduce, computes the head's read-model + freshness, promotes a prior
revision (restore), lists revisions, and exposes the SSE read dependencies.

The LLM REDUCE worker that turns a draft into prose + citations and promotes it
on success lives in ``library_intelligence_reduce``; this module owns the two
helpers it shares (``resolve_library_media_ids``, ``revision_orm_or_none``) as
their single home.

Staleness is computed at read against the current revision's expanded-media
``covered_targets`` snapshot (content-fingerprint, not membership) — no
invalidation coupling.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.db.models import (
    LibraryIntelligenceArtifactRevision,
    LibraryIntelligenceRevisionEvent,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.jobs.queue import enqueue_unique_job
from nexus.logging import get_logger
from nexus.schemas.citation import CitationOut
from nexus.schemas.library_intelligence import (
    ArtifactStatus,
    LibraryIntelligenceRevisionEventOut,
)
from nexus.services import run_kit
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    replace_citations_for_output,
)
from nexus.services.resource_graph.refs import ResourceRef

logger = get_logger(__name__)

GENERATE_JOB_KIND = "library_intelligence_artifact_generate"


# ---------- public contract (typed dataclass returns) -----------------------


@dataclass(frozen=True)
class RevisionBuild:
    """The in-flight (or just-terminal) draft revision's run status."""

    revision_id: UUID
    status: str


@dataclass(frozen=True)
class ArtifactView:
    """The GET read-model: current-revision content + computed head status."""

    artifact_id: UUID | None
    revision_id: UUID | None
    status: ArtifactStatus
    content_md: str
    build: RevisionBuild | None
    # Number of covered media that differ from the live set when ``status == "stale"``
    # (added, removed, or fingerprint-changed); ``None`` for every other status.
    stale_source_count: int | None = None
    # The artifact's citation edges (§5.5: keyed on the artifact, swapped at
    # promote). Empty until a revision has been promoted.
    citations: list[CitationOut] = field(default_factory=list)


@dataclass(frozen=True)
class RevisionRef:
    """The 202 generate outcome (the revision IS the run)."""

    artifact_id: UUID
    revision_id: UUID
    status: str


@dataclass(frozen=True)
class RevisionSummary:
    revision_id: UUID
    status: str
    created_at: datetime
    promoted_at: datetime | None
    is_current: bool


# ---------- read: get_artifact + computed status (§5.4) ---------------------


def get_artifact(db: Session, *, viewer_id: UUID, library_id: UUID) -> ArtifactView:
    """Return the head's current-revision content, citations, and computed status."""
    _require_member(db, viewer_id, library_id)
    head = (
        db.execute(
            text(
                "SELECT id, current_revision_id, user_id "
                "FROM library_intelligence_artifacts WHERE library_id = :library_id"
            ),
            {"library_id": library_id},
        )
        .mappings()
        .first()
    )
    if head is None:
        return ArtifactView(
            artifact_id=None,
            revision_id=None,
            status="unavailable",
            content_md="",
            build=None,
        )

    artifact_id = UUID(str(head["id"]))
    current_revision_id = (
        UUID(str(head["current_revision_id"])) if head["current_revision_id"] is not None else None
    )
    build = _latest_building_revision(db, artifact_id=artifact_id)

    if current_revision_id is None:
        # No promoted revision yet: building if a draft is in flight, else the
        # latest draft's failure, else unavailable.
        if build is not None:
            return ArtifactView(artifact_id, None, "building", "", build)
        latest = _latest_revision_status(db, artifact_id=artifact_id)
        status: ArtifactStatus = "failed" if latest == "failed" else "unavailable"
        return ArtifactView(artifact_id, None, status, "", None)

    content_md = _revision_content_md(db, revision_id=current_revision_id)
    head_status, stale_source_count = _compute_freshness(
        db, library_id=library_id, current_revision_id=current_revision_id
    )
    # Citation edges are written with the artifact owner's user id at promote;
    # any library member reads the same artifact-keyed set.
    citations = build_citation_outs(
        db,
        viewer_id=UUID(str(head["user_id"])),
        source=ResourceRef(scheme="library_intelligence_artifact", id=artifact_id),
    )
    return ArtifactView(
        artifact_id,
        current_revision_id,
        head_status,
        content_md,
        build,
        stale_source_count=stale_source_count,
        citations=citations,
    )


def _compute_freshness(
    db: Session, *, library_id: UUID, current_revision_id: UUID
) -> tuple[ArtifactStatus, int | None]:
    """Compare the live media->fingerprint map to the current revision's snapshot.

    Returns ``("current", None)`` when the maps match, else ``("stale", N)`` where N
    is the number of media that differ — added, removed, or fingerprint-changed.
    """
    live = _live_media_fingerprints(db, library_id=library_id)
    covered = _covered_media_fingerprints(db, revision_id=current_revision_id)
    if live == covered:
        return "current", None
    changed = {
        media_id
        for media_id in live.keys() | covered.keys()
        if live.get(media_id) != covered.get(media_id)
    }
    return "stale", len(changed)


def _live_media_fingerprints(db: Session, *, library_id: UUID) -> dict[str, str | None]:
    """The current expanded-media -> content_fingerprint map for this library.

    Reuses ``resolve_library_media_ids`` (the single owner of the expansion) then
    reads fingerprints, mirroring how ``covered_targets`` is written: every
    resolved media is recorded, with a media that has no unit mapping to None — so
    live<->covered stays symmetric (a membership change, a re-ingest, or a new
    podcast episode all change the map).
    """
    media_ids = resolve_library_media_ids(db, library_id=library_id)
    if not media_ids:
        return {}
    rows = (
        db.execute(
            text(
                "SELECT media_id, content_fingerprint FROM media_summaries "
                "WHERE media_id = ANY(:ids)"
            ),
            {"ids": media_ids},
        )
        .mappings()
        .all()
    )
    fingerprints = {str(row["media_id"]): row["content_fingerprint"] for row in rows}
    return {
        str(media_id): (
            str(fingerprints[str(media_id)])
            if fingerprints.get(str(media_id)) is not None
            else None
        )
        for media_id in media_ids
    }


def _covered_media_fingerprints(db: Session, *, revision_id: UUID) -> dict[str, str | None]:
    covered = (
        db.execute(
            text(
                "SELECT covered_targets FROM library_intelligence_artifact_revisions "
                "WHERE id = :revision_id"
            ),
            {"revision_id": revision_id},
        ).scalar_one_or_none()
        or []
    )
    result: dict[str, str | None] = {}
    for record in covered:
        if not isinstance(record, dict) or record.get("kind") != "media":
            continue
        fingerprint = record.get("fingerprint")
        result[str(record["id"])] = str(fingerprint) if isinstance(fingerprint, str) else None
    return result


# ---------- write: generate_artifact (202) ----------------------------------


def generate_artifact(
    db: Session, *, viewer_id: UUID, library_id: UUID, idempotency_key: str
) -> RevisionRef:
    """Find-or-create the head + an idempotency-keyed draft revision; enqueue.

    Owns its SERIALIZABLE transaction + bounded serialization retry. A reused
    ``(artifact_id, idempotency_key)`` returns the same revision without
    re-enqueuing.
    """
    _require_member(db, viewer_id, library_id)

    def op() -> RevisionRef:
        ref = _generate_artifact_core(
            db, viewer_id=viewer_id, library_id=library_id, idempotency_key=idempotency_key
        )
        db.commit()
        return ref

    return retry_serializable(db, "generate_artifact", op)


def _generate_artifact_core(
    db: Session, *, viewer_id: UUID, library_id: UUID, idempotency_key: str
) -> RevisionRef:
    # Find-or-create the stable head (explicit SELECT then INSERT/UPDATE; the
    # SERIALIZABLE retry loop in generate_artifact owns concurrent races).
    head = db.execute(
        text("SELECT id FROM library_intelligence_artifacts WHERE library_id = :library_id"),
        {"library_id": library_id},
    ).scalar_one_or_none()
    if head is not None:
        artifact_id = UUID(str(head))
        db.execute(
            text("UPDATE library_intelligence_artifacts SET updated_at = now() WHERE id = :id"),
            {"id": artifact_id},
        )
    else:
        artifact_id = UUID(
            str(
                db.execute(
                    text(
                        "INSERT INTO library_intelligence_artifacts (library_id, user_id) "
                        "VALUES (:library_id, :viewer_id) RETURNING id"
                    ),
                    {"library_id": library_id, "viewer_id": viewer_id},
                ).scalar_one()
            )
        )

    # Find-or-create the idempotency-keyed draft revision.
    existing = (
        db.execute(
            text(
                "SELECT id, status FROM library_intelligence_artifact_revisions "
                "WHERE artifact_id = :artifact_id AND idempotency_key = :idempotency_key"
            ),
            {"artifact_id": artifact_id, "idempotency_key": idempotency_key},
        )
        .mappings()
        .first()
    )
    if existing is not None:
        return RevisionRef(
            artifact_id=artifact_id,
            revision_id=UUID(str(existing["id"])),
            status=str(existing["status"]),
        )

    revision_id = UUID(
        str(
            db.execute(
                text(
                    """
                    INSERT INTO library_intelligence_artifact_revisions (
                        artifact_id, content_md, covered_targets, status, idempotency_key
                    )
                    VALUES (:artifact_id, '', '[]'::jsonb, 'building', :idempotency_key)
                    RETURNING id
                    """
                ),
                {"artifact_id": artifact_id, "idempotency_key": idempotency_key},
            ).scalar_one()
        )
    )
    enqueue_unique_job(
        db,
        kind=GENERATE_JOB_KIND,
        dedupe_key=f"{GENERATE_JOB_KIND}:{revision_id}",
        payload={"revision_id": str(revision_id)},
        max_attempts=1,
    )
    revision = _revision_orm(db, revision_id=revision_id)
    run_kit.append_event(
        db,
        stream=run_kit.library_intelligence_revision_stream(revision),
        event_type="meta",
        payload={"revision_id": str(revision_id), "library_id": str(library_id)},
    )
    return RevisionRef(artifact_id=artifact_id, revision_id=revision_id, status="building")


# ---------- promote / restore -----------------------------------------------


def promote_revision(db: Session, *, viewer_id: UUID, revision_id: UUID) -> None:
    """Restore a prior ``ready`` revision as the head's current (last-wins).

    Citations key on the artifact and swap atomically with its content inside
    this transaction (§5.5). A restored revision's per-revision citations died
    with the LI-private citation table (current-only doctrine), so the restore
    replaces the artifact's citation set with the empty set — the restored prose
    returns without citation chips until the next generate, instead of lying
    with the superseded revision's chips.
    """
    artifact_id, library_id, owner_id = _artifact_and_library_for_revision(
        db, revision_id=revision_id
    )
    _require_member(db, viewer_id, library_id)

    def op() -> None:
        status = db.execute(
            text("SELECT status FROM library_intelligence_artifact_revisions WHERE id = :rev"),
            {"rev": revision_id},
        ).scalar_one()
        if status != "ready":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Only a ready revision can be promoted"
            )
        db.execute(
            text(
                "UPDATE library_intelligence_artifact_revisions "
                "SET promoted_at = now() WHERE id = :rev"
            ),
            {"rev": revision_id},
        )
        # The restored revision's per-revision citations died with the LI-private
        # citation table; citations key on the artifact (§5.5) and swap with the
        # head inside this transaction, so a restore replaces the set with the
        # empty set rather than leaving the superseded revision's chips.
        replace_citations_for_output(
            db,
            viewer_id=owner_id,
            source=ResourceRef(scheme="library_intelligence_artifact", id=artifact_id),
            citations=[],
        )
        db.execute(
            text(
                "UPDATE library_intelligence_artifacts "
                "SET current_revision_id = :rev, updated_at = now() WHERE id = :artifact_id"
            ),
            {"rev": revision_id, "artifact_id": artifact_id},
        )
        db.commit()

    retry_serializable(db, "promote_revision", op)


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
                SELECT id, status, created_at, promoted_at
                FROM library_intelligence_artifact_revisions
                WHERE artifact_id = :artifact_id
                ORDER BY created_at DESC, id DESC
                """
            ),
            {"artifact_id": head["id"]},
        )
        .mappings()
        .all()
    )
    return [
        RevisionSummary(
            revision_id=UUID(str(row["id"])),
            status=str(row["status"]),
            created_at=row["created_at"],
            promoted_at=row["promoted_at"],
            is_current=current is not None and UUID(str(row["id"])) == current,
        )
        for row in rows
    ]


# ---------- SSE handler dependencies ----------------------------------------


def assert_revision_viewer(db: Session, *, viewer_id: UUID, revision_id: UUID) -> None:
    """Raise NotFoundError unless the revision belongs to a library the viewer reads."""
    _artifact_and_library_for_revision(db, revision_id=revision_id, viewer_id=viewer_id)


def get_revision_events(
    db: Session, *, revision_id: UUID, after: int
) -> list[LibraryIntelligenceRevisionEventOut]:
    rows = (
        db.execute(
            select(LibraryIntelligenceRevisionEvent)
            .where(
                LibraryIntelligenceRevisionEvent.revision_id == revision_id,
                LibraryIntelligenceRevisionEvent.seq > after,
            )
            .order_by(LibraryIntelligenceRevisionEvent.seq)
        )
        .scalars()
        .all()
    )
    return [
        LibraryIntelligenceRevisionEventOut(
            seq=row.seq,
            event_type=row.event_type,
            payload=dict(row.payload) if isinstance(row.payload, dict) else {},
        )
        for row in rows
    ]


def is_revision_terminal(db: Session, *, revision_id: UUID) -> bool:
    status = db.execute(
        text("SELECT status FROM library_intelligence_artifact_revisions WHERE id = :revision_id"),
        {"revision_id": revision_id},
    ).scalar_one_or_none()
    # A missing revision (deleted mid-stream) is terminal — otherwise the SSE tail
    # would stream forever; the viewer assertion proved it existed at open. The
    # terminal set has one owner (run_kit).
    return status is None or status in run_kit.terminal_statuses(
        run_kit.RunStreamKind.LibraryIntelligence
    )


# ---------- shared helpers (single owner; imported by the reduce worker) -----


def resolve_library_media_ids(db: Session, *, library_id: UUID) -> list[UUID]:
    """Expand the library's current entries to a media set (direct + podcast episodes).

    The single owner of the EntryTarget -> expanded-media expansion, shared by the
    reduce worker, ``covered_targets``, and the live freshness map.
    """
    rows = (
        db.execute(
            text(
                """
                SELECT DISTINCT media_id FROM (
                    SELECT le.media_id AS media_id
                    FROM library_entries le
                    WHERE le.library_id = :library_id AND le.media_id IS NOT NULL
                    UNION
                    SELECT pe.media_id AS media_id
                    FROM library_entries le
                    JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
                    WHERE le.library_id = :library_id AND le.podcast_id IS NOT NULL
                ) expanded
                WHERE media_id IS NOT NULL
                ORDER BY media_id
                """
            ),
            {"library_id": library_id},
        )
        .mappings()
        .all()
    )
    return [UUID(str(row["media_id"])) for row in rows]


def revision_orm_or_none(
    db: Session, *, revision_id: UUID
) -> LibraryIntelligenceArtifactRevision | None:
    """Load a revision ORM by id (the single home for revision-ORM access)."""
    return db.get(LibraryIntelligenceArtifactRevision, revision_id, populate_existing=True)


# ---------- internal: small loaders -----------------------------------------


def _require_member(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    if not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")


def _revision_orm(db: Session, *, revision_id: UUID) -> LibraryIntelligenceArtifactRevision:
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    return revision


def _latest_building_revision(db: Session, *, artifact_id: UUID) -> RevisionBuild | None:
    row = (
        db.execute(
            text(
                """
                SELECT id, status FROM library_intelligence_artifact_revisions
                WHERE artifact_id = :artifact_id AND status = 'building'
                ORDER BY created_at DESC, id DESC LIMIT 1
                """
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
            "SELECT status FROM library_intelligence_artifact_revisions "
            "WHERE artifact_id = :artifact_id ORDER BY created_at DESC, id DESC LIMIT 1"
        ),
        {"artifact_id": artifact_id},
    ).scalar_one_or_none()


def _revision_content_md(db: Session, *, revision_id: UUID) -> str:
    content = db.execute(
        text("SELECT content_md FROM library_intelligence_artifact_revisions WHERE id = :rev"),
        {"rev": revision_id},
    ).scalar_one_or_none()
    return str(content or "")


def _artifact_and_library_for_revision(
    db: Session, *, revision_id: UUID, viewer_id: UUID | None = None
) -> tuple[UUID, UUID, UUID]:
    """Return (artifact_id, library_id, artifact owner user_id) for a revision."""
    row = (
        db.execute(
            text(
                """
                SELECT a.id AS artifact_id, a.library_id, a.user_id
                FROM library_intelligence_artifact_revisions r
                JOIN library_intelligence_artifacts a ON a.id = r.artifact_id
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
    library_id = UUID(str(row["library_id"]))
    if viewer_id is not None and not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Revision not found")
    return UUID(str(row["artifact_id"])), library_id, UUID(str(row["user_id"]))
