"""Weekly empty-page/note collection and reviewed, content-free operator inventories.

The graph owns retention; this module owns discovery and transaction boundaries.
Each job candidate locks the claim, then its root, then rechecks with a fresh
READ COMMITTED snapshot. Its disposition and cursor commit together. Operator
apply locks and validates the entire bounded inventory before deleting anything.
Canonical teardown is flush-only. Absent resources have already landed on retry.
"""

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page
from nexus.db.retries import retry_read_committed
from nexus.db.session import get_session_factory
from nexus.jobs import queue
from nexus.runtime_health import get_runtime_identity
from nexus.services import note_bodies, notes
from nexus.services.resource_graph import retention
from nexus.services.resource_graph.refs import ResourceRef, require_ref
from nexus.services.resource_items import versions
from nexus.services.suggestion_changes import record_input_change

BATCH_SIZE = 100


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatabaseIdentity(_Closed):
    name: str
    system_identifier: str


class CandidateEvidence(_Closed):
    ref: str
    owner_id: UUID
    last_activity_at: datetime
    versions: dict[str, int]
    dependent_rows: dict[str, int]


class CleanupInventory(_Closed):
    database: DatabaseIdentity
    schema_revision: str
    implementation_sha: str
    cutoff: datetime
    entries: list[CandidateEvidence] = Field(max_length=BATCH_SIZE)
    truncated: bool


class _RunRequest(_Closed):
    request_id: str


class _Progress(_RunRequest):
    cutoff: datetime
    cursor: str | None = None
    inspected: int = 0
    deleted: int = 0
    absent: int = 0
    recent: int = 0
    nonempty: int = 0
    retained: int = 0


def _database_identity(db: Session) -> DatabaseIdentity:
    row = db.execute(
        text("SELECT current_database() AS name, system_identifier::text FROM pg_control_system()")
    ).one()
    return DatabaseIdentity(name=row.name, system_identifier=row.system_identifier)


def _schema_revision(db: Session) -> str:
    return db.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def _cutoff(db: Session) -> datetime:
    return db.execute(text("SELECT clock_timestamp() - interval '7 days'")).scalar_one()


def _candidates(db: Session, cursor: str | None, limit: int | None) -> list[ResourceRef]:
    rows = db.execute(
        text("""
            SELECT scheme, id FROM (
                SELECT 'page' AS scheme, id FROM pages
                UNION ALL SELECT 'note_block' AS scheme, id FROM note_blocks
            ) resources
            WHERE CAST(:cursor AS text) IS NULL OR
                (scheme, id) > (split_part(:cursor, ':', 1), CAST(split_part(:cursor, ':', 2) AS uuid))
            ORDER BY scheme, id LIMIT :limit
        """),
        {"cursor": cursor, "limit": limit},
    )
    return [require_ref(f"{row.scheme}:{row.id}") for row in rows]


def _lock_root(db: Session, ref: ResourceRef) -> None:
    model = Page if ref.scheme == "page" else NoteBlock
    db.scalar(select(model.id).where(model.id == ref.id).with_for_update())


def _resource(db: Session, ref: ResourceRef) -> Page | NoteBlock | None:
    model = Page if ref.scheme == "page" else NoteBlock
    return db.scalar(
        select(model).where(model.id == ref.id).execution_options(populate_existing=True)
    )


def _reason(
    db: Session, ref: ResourceRef, resource: Page | NoteBlock | None, cutoff: datetime
) -> Literal["eligible", "absent", "recent", "nonempty", "retained"]:
    if resource is None:
        return "absent"
    if resource.last_activity_at > cutoff:
        return "recent"
    if isinstance(resource, NoteBlock) and not retention.canonical_blank(resource.body_pm_json):
        return "nonempty"
    if retention.has_retainer(db, resource.user_id, ref):
        return "retained"
    return "eligible"


def _evidence(db: Session, ref: ResourceRef, resource: Page | NoteBlock) -> CandidateEvidence:
    counts = (
        db.execute(
            text("""
            WITH owned AS (
                SELECT CAST(:scheme AS text) AS scheme, CAST(:id AS uuid) AS id
                UNION ALL SELECT 'passage_anchor', id FROM passage_anchors
                    WHERE owner_scheme = :scheme AND owner_id = :id
                UNION ALL SELECT 'evidence_span', id FROM evidence_spans
                    WHERE owner_kind = :scheme AND owner_id = :id
                UNION ALL SELECT 'content_chunk', id FROM content_chunks
                    WHERE owner_kind = :scheme AND owner_id = :id
            ), own_edges AS (
                SELECT e.id FROM resource_edges e WHERE
                    (e.source_scheme, e.source_id) IN (SELECT * FROM owned) OR
                    (e.target_scheme, e.target_id) IN (SELECT * FROM owned) OR
                    e.snapshot #>> '{evidence,target,owner_ref}' = :ref
            )
            SELECT
                (SELECT count(*) FROM daily_page_bindings WHERE page_id = :id
                    AND :scheme = 'page') AS daily_bindings,
                (SELECT count(*) FROM passage_anchors
                    WHERE owner_scheme = :scheme AND owner_id = :id) AS passage_anchors,
                (SELECT count(*) FROM evidence_spans
                    WHERE owner_kind = :scheme AND owner_id = :id) AS evidence_spans,
                (SELECT count(*) FROM content_chunks
                    WHERE owner_kind = :scheme AND owner_id = :id) AS content_chunks,
                (SELECT count(*) FROM content_embeddings e JOIN content_chunks c ON c.id = e.chunk_id
                    WHERE c.owner_kind = :scheme AND c.owner_id = :id) AS content_embeddings,
                (SELECT count(*) FROM content_index_states
                    WHERE owner_kind = :scheme AND owner_id = :id) AS content_index_states,
                (SELECT count(*) FROM own_edges) AS resource_edges,
                (SELECT count(*) FROM resource_versions
                    WHERE (resource_scheme, resource_id) IN (SELECT * FROM owned)) AS resource_versions,
                (SELECT count(*) FROM resource_view_states WHERE
                    (surface_scheme, surface_id) IN (SELECT * FROM owned) OR
                    (target_scheme, target_id) IN (SELECT * FROM owned) OR
                    edge_id IN (SELECT id FROM own_edges)) AS resource_view_states,
                (SELECT count(*) FROM background_jobs WHERE
                    (kind = 'note_reindex_job' AND :scheme = 'note_block'
                        AND payload ->> 'note_block_id' = CAST(:id AS text)) OR
                    (kind = 'connection_discovery_scan' AND payload ->> 'ref' = :ref)) AS jobs
        """),
            {"scheme": ref.scheme, "id": ref.id, "ref": ref.uri},
        )
        .mappings()
        .one()
    )
    return CandidateEvidence(
        ref=ref.uri,
        owner_id=resource.user_id,
        last_activity_at=resource.last_activity_at,
        versions=versions.versions_for_ref(db, viewer_id=resource.user_id, ref=ref),
        dependent_rows=dict(counts),
    )


def preview(db: Session) -> CleanupInventory:
    """One read-only inventory; truncated means apply it, then preview the remainder."""
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    cutoff = _cutoff(db)
    entries = []
    truncated = False
    for ref in _candidates(db, None, None):
        resource = _resource(db, ref)
        if resource is None or _reason(db, ref, resource, cutoff) != "eligible":
            continue
        if len(entries) == BATCH_SIZE:
            truncated = True
            break
        entries.append(_evidence(db, ref, resource))
    inventory = CleanupInventory(
        database=_database_identity(db),
        schema_revision=_schema_revision(db),
        implementation_sha=get_runtime_identity().source_sha,
        cutoff=cutoff,
        entries=entries,
        truncated=truncated,
    )
    db.commit()
    return inventory


def _delete(db: Session, ref: ResourceRef, owner_id: UUID) -> None:
    if ref.scheme == "page":
        notes.delete_page_in_current_transaction(db, owner_id, ref.id)
    else:
        note_bodies.delete_note(db, viewer_id=owner_id, note_id=ref.id)


def apply(db: Session, inventory: CleanupInventory) -> dict[str, int | bool]:
    """Apply exactly this reviewed set; any surviving entry's drift refuses all of it."""
    refs = [require_ref(entry.ref) for entry in inventory.entries]
    if any(ref.scheme not in ("page", "note_block") for ref in refs) or len(set(refs)) != len(refs):
        raise ValueError("Inventory must contain distinct page or note refs")
    ordered = sorted(
        zip(refs, inventory.entries, strict=True), key=lambda pair: (pair[0].scheme, pair[0].id)
    )

    def op() -> dict[str, int | bool]:
        if (
            inventory.database != _database_identity(db)
            or inventory.schema_revision != _schema_revision(db)
            or inventory.implementation_sha != get_runtime_identity().source_sha
        ):
            raise ValueError("Inventory database, schema or implementation changed")
        for ref, _ in ordered:
            _lock_root(db, ref)
        live: list[tuple[ResourceRef, UUID]] = []
        absent = 0
        for ref, expected in ordered:
            resource = _resource(db, ref)
            if resource is None:
                absent += 1
                continue
            if (
                _reason(db, ref, resource, inventory.cutoff) != "eligible"
                or _evidence(db, ref, resource) != expected
            ):
                raise ValueError(f"Inventory resource changed: {ref.uri}")
            live.append((ref, resource.user_id))
        for ref, owner_id in live:
            _delete(db, ref, owner_id)
        if live:
            record_input_change(db)
        db.commit()
        return {
            "deleted": len(live),
            "already_absent": absent,
            "preview_truncated": inventory.truncated,
        }

    return retry_read_committed(db, "apply_empty_resource_inventory", op)


def _checkpoint(db: Session, context: queue.JobExecutionContext, progress: _Progress) -> None:
    if not queue.update_running_job_payload(
        db, context=context, payload=progress.model_dump(mode="json")
    ):
        raise RuntimeError("Empty resource cleanup job claim lost at checkpoint")


def run_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> Mapping[str, Any] | queue.RescheduleRequested:
    """Inspect at most 100 candidates; resumption uses only the fenced durable payload."""
    del payload  # the locked claim is authoritative after retries and continuation
    with get_session_factory()() as db:

        def initialize() -> _Progress | None:
            claim = queue.lock_running_job_claim(db, context=context)
            if claim is None:
                db.rollback()
                return None
            if "cutoff" in claim.payload:
                progress = _Progress.model_validate(claim.payload)
            else:
                request = _RunRequest.model_validate(claim.payload)
                progress = _Progress(request_id=request.request_id, cutoff=_cutoff(db))
            _checkpoint(db, context, progress)
            db.commit()
            return progress

        progress = retry_read_committed(db, "initialize_empty_resource_cleanup", initialize)
        if progress is None:
            return {"status": "claim_lost"}
        candidates = _candidates(db, progress.cursor, BATCH_SIZE)
        db.commit()
        for ref in candidates:

            def inspect(ref: ResourceRef = ref) -> _Progress | None:
                claim = queue.lock_running_job_claim(db, context=context)
                if claim is None:
                    db.rollback()
                    return None
                current = _Progress.model_validate(claim.payload)
                _lock_root(db, ref)
                # Separate statement: the lock may have waited for a committed writer.
                resource = _resource(db, ref)
                reason = _reason(db, ref, resource, current.cutoff)
                if reason == "eligible":
                    assert resource is not None  # justify-defect: eligible requires a live row
                    _delete(db, ref, resource.user_id)
                    current.deleted += 1
                elif reason == "absent":
                    current.absent += 1
                elif reason == "recent":
                    current.recent += 1
                elif reason == "nonempty":
                    current.nonempty += 1
                else:
                    current.retained += 1
                current.inspected += 1
                current.cursor = ref.uri
                _checkpoint(db, context, current)
                if reason == "eligible":
                    record_input_change(db)
                db.commit()
                return current

            progress = retry_read_committed(db, "inspect_empty_resource", inspect)
            if progress is None:
                return {"status": "claim_lost"}
        if len(candidates) == BATCH_SIZE:
            return queue.RescheduleRequested(
                datetime.now(UTC), payload=progress.model_dump(mode="json")
            )
        return {"status": "complete", **progress.model_dump(mode="json")}
