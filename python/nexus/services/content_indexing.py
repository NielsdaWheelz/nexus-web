"""The content index: each owner's text as cited, embedded passages, published whole.

An owner is a media (web article, epub, pdf, or a podcast episode or video through its
transcript) or a note block. Its materialization is its evidence spans, content chunks
and embeddings; ``publish_content_index`` replaces all of them and the owner's state in
the caller's transaction, so readers see the old set or the new one, never a mix. The
state (``content_index_states``) is the only thing readers trust: rows count only while
it is ``ready`` on the active embedding identity.

A media's index is fenced by a monotonic ``revision``. Only ``request_media_content_reindex``
creates jobs, and each request raises the revision and leaves exactly one waiting job for
it, so a revision has at most one job. A job snapshots the source and publishes only
while its revision is current and it still holds its queue claim (``fence``, taken at
both ends of the job). Lock order: media row ``FOR NO KEY UPDATE`` (which admits the
``KEY SHARE`` a worker's history insert takes), then the state row, then queue rows.
A note's index is rebuilt by ``note_indexing``.
"""

from __future__ import annotations

import json
from array import array
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import Row, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.retries import admit_serializable, retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs import queue
from nexus.jobs.registry import get_default_registry
from nexus.schemas.import_history import (
    IndexAccepted,
    IndexExecutionStarted,
    IndexFacts,
    IndexRecoveryAccepted,
    IndexSucceeded,
    IndexSuperseded,
)
from nexus.schemas.imports import RepairSearchOffer
from nexus.schemas.media import SearchRepairAdmission
from nexus.schemas.presence import absent, present
from nexus.services import media_intelligence_lifecycle
from nexus.services.capabilities import SearchRecoveryAnswer, ViewerRecovery
from nexus.services.content_chunking import (
    Chunk,
    EnvelopeExceeded,
    IndexableBlock,
    read_spool,
    spool_chunks,
)
from nexus.services.embeddings import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_PROVIDER,
    embedding_model,
    pgvector_literal,
)
from nexus.services.import_history import append_processing_event
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.reader_apparatus import read_note_regions
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.web_article_structure import (
    add_heading_anchors,
    build_web_article_index_blocks,
)

JOB_KIND = "media_content_reindex_job"
ReindexReason = Literal[
    "source_success", "reconciliation", "oracle_corpus_seed", "operator_heading_normalization"
]
_TRANSCRIPT_KINDS = ("podcast_episode", "video")


@dataclass(frozen=True)
class IndexOwner:
    kind: Literal["media", "note_block"]
    id: UUID


@dataclass(frozen=True)
class ContentIndexResult:
    owner: IndexOwner
    status: str  # ready | no_text | ocr_required
    chunk_count: int


@dataclass(frozen=True)
class MediaContentReindexIntent:
    revision: int
    background_job_id: UUID
    suspended: bool  # the current revision's job is dead; nothing was enqueued
    enqueued: bool  # a new queue row was inserted (not a waiting one reset)


# Materialization: one transaction replaces an owner's whole index.


def _set_state(
    db: Session, owner: IndexOwner, status: str, reason: str | None, *, bump: int = 0
) -> int:
    """Upsert the owner's state, raising its revision by ``bump``; return the revision.

    Only ``ready`` carries the active embedding identity.
    """
    ready = status == "ready"
    return db.execute(
        text(
            """
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason,
                active_embedding_provider, active_embedding_model, revision, updated_at,
                created_at)
            VALUES (:kind, :id, :status, :reason, :provider, :model, :bump, now(), now())
            ON CONFLICT ON CONSTRAINT uq_content_index_states_owner DO UPDATE
            SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
                active_embedding_provider = EXCLUDED.active_embedding_provider,
                active_embedding_model = EXCLUDED.active_embedding_model,
                revision = content_index_states.revision + :bump, updated_at = now()
            RETURNING revision
            """
        ),
        {
            "kind": owner.kind,
            "id": owner.id,
            "status": status,
            "reason": reason,
            "provider": EMBEDDING_PROVIDER if ready else None,
            "model": embedding_model() if ready else None,
            "bump": bump,
        },
    ).scalar_one()


def _clear(db: Session, owner: IndexOwner) -> None:
    """Delete the owner's spans, chunks and embeddings, children of foreign keys first."""
    params = {"kind": owner.kind, "id": owner.id}
    if owner.kind == "media":
        # The media unit's claims cite these spans through a non-cascading key.
        media_intelligence_lifecycle.clear_media_claims_for_reindex(db, media_id=owner.id)
    # Chat citations keep rendering from their snapshots; their reopen fails closed.
    db.execute(
        text(
            "UPDATE message_retrievals mr SET evidence_span_id = NULL FROM evidence_spans es"
            " WHERE mr.evidence_span_id = es.id AND es.owner_kind = :kind AND es.owner_id = :id"
        ),
        params,
    )
    # Bare graph edges die with the rows; cited edges keep rendering from snapshots.
    refs = [
        ResourceRef(scheme=scheme, id=row_id)
        for scheme in ("evidence_span", "content_chunk")  # each in its table, <scheme>s
        for row_id in db.scalars(
            text(f"SELECT id FROM {scheme}s WHERE owner_kind = :kind AND owner_id = :id"), params
        )
    ]
    cleanup.delete_edges_for_deleted_resources(db, refs=refs)
    db.execute(
        text(
            "DELETE FROM content_embeddings ce USING content_chunks cc"
            " WHERE ce.chunk_id = cc.id AND cc.owner_kind = :kind AND cc.owner_id = :id"
        ),
        params,
    )
    for table in ("content_chunks", "evidence_spans"):
        db.execute(text(f"DELETE FROM {table} WHERE owner_kind = :kind AND owner_id = :id"), params)


def publish_content_index(
    db: Session,
    *,
    owner: IndexOwner,
    source_kind: str,
    blocks: Sequence[IndexableBlock],
    chunks: Iterable[Chunk],
    reason: str,
) -> ContentIndexResult:
    """Replace the owner's materialization and state with ``chunks`` (embedded from ``blocks``).

    No chunks: ``ocr_required`` for a pdf, else ``no_text``. A media's ``ready`` publish
    also (re)builds its media unit, in this transaction.
    """
    _clear(db, owner)
    params: dict[str, Any] = {"kind": owner.kind, "id": owner.id}
    resolver = "web" if source_kind == "web_article" else source_kind
    model = embedding_model()
    count = 0
    for count, chunk in enumerate(chunks, start=1):
        heading = blocks[chunk.block_idx].heading_path
        row = params | {"text": chunk.text, "locator": json.dumps(chunk.locator)}
        span_id = db.scalar(
            text(
                "INSERT INTO evidence_spans (owner_kind, owner_id, span_text, selector,"
                " citation_label, resolver_kind) VALUES (:kind, :id, :text,"
                " CAST(:locator AS jsonb), :label, :resolver) RETURNING id"
            ),
            row | {"label": heading[-1] if heading else "Source", "resolver": resolver},
        )
        chunk_id = db.scalar(
            text(
                "INSERT INTO content_chunks (owner_kind, owner_id, primary_evidence_span_id,"
                " chunk_idx, source_kind, chunk_text, heading_path, summary_locator)"
                " VALUES (:kind, :id, :span, :idx, :source_kind, :text,"
                " CAST(:heading AS jsonb), CAST(:locator AS jsonb)) RETURNING id"
            ),
            row
            | {
                "span": span_id,
                "idx": count - 1,
                "source_kind": source_kind,
                "heading": json.dumps(list(heading)),
            },
        )
        vector = array("f")
        vector.frombytes(chunk.embedding_f32)
        db.execute(
            text(
                "INSERT INTO content_embeddings (chunk_id, embedding_provider, embedding_model,"
                " embedding_dimensions, embedding_vector) VALUES (:chunk, :provider, :model,"
                f" :dimensions, CAST(:vector AS vector({EMBEDDING_DIMENSIONS})))"
            ),
            {
                "chunk": chunk_id,
                "provider": EMBEDDING_PROVIDER,
                "model": model,
                "dimensions": EMBEDDING_DIMENSIONS,
                "vector": pgvector_literal(vector),
            },
        )
    if count == 0:
        status = "ocr_required" if source_kind == "pdf" else "no_text"
        _set_state(db, owner, status, status)
        return ContentIndexResult(owner, status, 0)
    _set_state(db, owner, "ready", reason)
    if owner.kind == "media":
        media_intelligence_lifecycle.ensure_media_unit_in_tx(db, media_id=owner.id)
    return ContentIndexResult(owner, "ready", count)


def mark_content_index_pending(db: Session, *, owner: IndexOwner, reason: str) -> None:
    """Gate the owner out of search, keeping its rows until the next publish."""
    _set_state(db, owner, "pending", reason)


def delete_content_index(db: Session, *, owner: IndexOwner) -> None:
    """The owner is going away: its materialization and its state row go first."""
    _clear(db, owner)
    db.execute(
        text("DELETE FROM content_index_states WHERE owner_kind = :kind AND owner_id = :id"),
        {"kind": owner.kind, "id": owner.id},
    )


# A media's blocks, read inside the job's snapshot transaction.


def _media_blocks(db: Session, media_id: UUID, kind: str, plain_text: str) -> list[IndexableBlock]:
    """Web article and epub: fragments; pdf: pages; podcast episode and video: transcript."""
    params = {"media_id": media_id}
    if kind == "pdf":
        return _pdf_blocks(db, media_id, plain_text)
    if kind in _TRANSCRIPT_KINDS:
        blocks: list[IndexableBlock] = []
        offset = 0  # segments sit two characters apart, so no chunk crosses one
        for raw, t_start, t_end in db.execute(
            text(
                "SELECT canonical_text, t_start_ms, t_end_ms FROM podcast_transcript_segments"
                " WHERE media_id = :media_id ORDER BY segment_idx"
            ),
            params,
        ):
            if segment := raw.strip():
                locator = {"kind": "transcript_time_text", "t_start_ms": t_start, "t_end_ms": t_end}
                blocks.append(IndexableBlock(segment, offset, locator))
                offset += len(segment) + 2
        return blocks
    fragments = db.execute(
        text(
            "SELECT id, idx, canonical_text, html_sanitized FROM fragments"
            " WHERE media_id = :media_id ORDER BY idx, id"
        ),
        params,
    ).all()
    spans: dict[UUID, list[tuple[int, int]]] = {}
    if kind == "epub":
        for fragment_id, start, end in db.execute(
            text(
                "SELECT fragment_id, start_offset, end_offset FROM fragment_blocks"
                " WHERE fragment_id = ANY(:ids) ORDER BY fragment_id, block_idx"
            ),
            {"ids": [fragment.id for fragment in fragments]},
        ):
            spans.setdefault(fragment_id, []).append((start, end))
    note_regions = read_note_regions(db, media_id) if kind == "web_article" else []
    blocks = []
    base = 0  # fragments sit two characters apart, so no chunk crosses one
    for fragment_id, idx, source, html in fragments:
        source = source or ""
        anchor: dict[str, object] = {"fragment_id": str(fragment_id), "fragment_idx": idx}
        if kind == "epub":
            for start, end in spans.get(fragment_id) or [(0, len(source))]:
                locator = {"kind": "epub_text", **anchor, "start_offset": start, "end_offset": end}
                blocks.append(IndexableBlock(source[start:end], base + start, locator))
        else:
            html = html or ""
            if add_heading_anchors(html, fragment_idx=idx) != html:
                # Publication owns heading normalization; this job dies so the
                # operator's heading repair (ops.processing_recovery) can find it.
                raise AssertionError("web source fragment is missing Nexus heading anchors")
            for spec in build_web_article_index_blocks(
                html_sanitized=html,
                canonical_text=source,
                fragment_idx=idx,
                fragment_id=fragment_id,
                note_regions=note_regions,
            ):
                start, end = spec.start_offset, spec.end_offset
                locator = {
                    "type": "web_text_offsets",
                    "kind": "web_text",
                    **anchor,
                    "start_offset": start,
                    "end_offset": end,
                }
                if spec.section_id is not None:
                    locator["section_id"] = spec.section_id
                    locator["parent_section_id"] = spec.parent_section_id.model_dump(mode="json")
                    locator["owns_container"] = spec.owns_container
                if spec.anchor_id is not None:
                    locator["anchor_id"] = spec.anchor_id
                if spec.heading_level is not None:
                    locator["heading_level"] = spec.heading_level
                if spec.container_end_offset.kind == "Present":
                    locator["container_end_offset"] = spec.container_end_offset.value
                blocks.append(
                    IndexableBlock(source[start:end], base + start, locator, spec.heading_path)
                )
        base += len(source) + 2
    return blocks


def _pdf_blocks(db: Session, media_id: UUID, plain_text: str) -> list[IndexableBlock]:
    """One block per page span of the extracted text; one whole-text page without spans."""
    pages = db.execute(
        text(
            "SELECT page_number, start_offset, end_offset, page_label, page_width,"
            " page_height, page_rotation_degrees FROM pdf_page_text_spans"
            " WHERE media_id = :media_id ORDER BY page_number"
        ),
        {"media_id": media_id},
    ).all()
    if not pages and plain_text:
        pages = [(1, 0, len(plain_text), None, None, None, None)]
    blocks: list[IndexableBlock] = []
    for number, start, end, label, width, height, rotation in pages:
        page_text = plain_text[start:end]
        locator: dict[str, object] = {
            "kind": "pdf_text",
            "page_number": number,
            "physical_page_number": number,
            "page_label": label or None,
            "plain_text_start_offset": start,
            "plain_text_end_offset": end,
            "page_text_start_offset": 0,
            "page_text_end_offset": len(page_text),
        }
        if width is not None and height is not None:
            locator["geometry"] = {
                "coordinate_space": "pdf_points",
                "page_width": float(width),
                "page_height": float(height),
                "page_rotation_degrees": int(rotation or 0),
                "page_box": "crop",
                "quads": [],
            }
        blocks.append(IndexableBlock(page_text, start, locator, (f"p. {label or number}",)))
    return blocks


# The media revision protocol.


def _lock(db: Session, media_id: UUID) -> Row[Any] | None:
    """Lock the media row, then its state row: ``(revision, status, provider, model)``.

    None when either row is missing.
    """
    if db.scalar(text("SELECT id FROM media WHERE id = :id FOR NO KEY UPDATE"), {"id": media_id}):
        return db.execute(
            text(
                "SELECT revision, status, active_embedding_provider AS provider,"
                " active_embedding_model AS model FROM content_index_states"
                " WHERE owner_kind = 'media' AND owner_id = :id FOR UPDATE"
            ),
            {"id": media_id},
        ).one_or_none()
    return None


def _current_job(db: Session, media_id: UUID, revision: int) -> queue.JobRow | None:
    """The revision's one job, locked."""
    jobs = queue.lock_jobs_for_payload(
        db, kind=JOB_KIND, expected_payload_match={"media_id": str(media_id), "revision": revision}
    )
    return jobs[-1] if jobs else None


def _event(db: Session, media_id: UUID, facts: IndexFacts) -> None:
    append_processing_event(
        db, media_id=media_id, facts=facts, stage=present("Index"), failure_code=absent()
    )


def request_media_content_reindex(
    db: Session, *, media_id: UUID, reason: ReindexReason
) -> MediaContentReindexIntent:
    """Raise the revision and leave exactly one waiting job for it.

    A waiting (unclaimed) job of an older revision is reset to this one; a running job
    keeps its revision and will find itself superseded at its fence.
    """
    db.execute(
        text("SELECT id FROM media WHERE id = :id FOR NO KEY UPDATE"), {"id": media_id}
    ).one()
    revision = _set_state(db, IndexOwner("media", media_id), "pending", reason, bump=1)
    payload = {"media_id": str(media_id), "revision": revision, "reason": reason}
    waiting = [
        job
        for job in queue.lock_jobs_for_payload(
            db, kind=JOB_KIND, expected_payload_match={"media_id": str(media_id)}
        )
        if job.status in ("pending", "failed") and job.claimed_by is None
    ]
    for obsolete in waiting[1:]:
        queue.supersede_unclaimed_job(db, job_id=obsolete.id, kind=JOB_KIND)
    attempts = get_default_registry()[JOB_KIND].max_attempts
    job = (
        queue.reset_unclaimed_job_for_new_intent(
            db, job_id=waiting[0].id, kind=JOB_KIND, payload=payload, max_attempts=attempts
        )
        if waiting
        else queue.enqueue_job(db, kind=JOB_KIND, payload=payload, max_attempts=attempts)
    )
    _event(db, media_id, IndexAccepted(revision=revision, job_id=job.id))
    return MediaContentReindexIntent(revision, job.id, suspended=False, enqueued=not waiting)


def ensure_media_content_reindex_job(
    db: Session, *, media_id: UUID, reason: ReindexReason
) -> MediaContentReindexIntent:
    """The reconciler's admission: keep a live job, report a dead one, else request anew.

    A revision whose job finished without publishing is abandoned for a fresh one (a
    revision never gets a second job). A dead job is never re-admitted here (that would
    retry a deterministic failure every tick); its owner repairs it
    (``repair_dead_media_reindex``).
    """
    state = _lock(db, media_id)
    job = None if state is None else _current_job(db, media_id, state.revision)
    if state is None or job is None or job.status == "succeeded":
        return request_media_content_reindex(db, media_id=media_id, reason=reason)
    return MediaContentReindexIntent(state.revision, job.id, job.status == "dead", enqueued=False)


def request_stale_media_content_reindex(
    db: Session, *, media_id: UUID, reason: ReindexReason
) -> bool:
    """Request a revision unless the index is current or its job is live; whether it did.

    Current: ``ready`` on the active embedding identity, or ``no_text``/``ocr_required``.
    A dead current job is retried by the new revision: the caller asked explicitly.
    """
    state = _lock(db, media_id)
    if state is not None:
        if state.status in ("no_text", "ocr_required") or (
            (state.status, state.provider, state.model)
            == ("ready", EMBEDDING_PROVIDER, embedding_model())
        ):
            return False
        job = _current_job(db, media_id, state.revision)
        if job is not None and job.status in ("pending", "failed", "running"):
            return False
    request_media_content_reindex(db, media_id=media_id, reason=reason)
    return True


def retract_media_content_index(db: Session, *, media_id: UUID) -> None:
    """The media's text is being replaced: drop its passages now and raise the revision.

    Raising the revision supersedes every job of the old text at its fence. The
    transaction that makes the new text readable requests the next revision.
    """
    db.execute(
        text("SELECT id FROM media WHERE id = :id FOR NO KEY UPDATE"), {"id": media_id}
    ).one()
    owner = IndexOwner("media", media_id)
    _clear(db, owner)
    _set_state(db, owner, "pending", "transcript_replacement", bump=1)


# The job: fence and snapshot, embed through a spool outside any transaction, fence and publish.


def run_media_reindex_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    media_id, revision = UUID(payload["media_id"]), int(payload["revision"])
    reason = payload["reason"]
    result: dict[str, object] = {
        "status": "superseded",
        "media_id": str(media_id),
        "revision": revision,
    }
    lease = get_default_registry()[JOB_KIND].lease_seconds

    def record(db: Session, facts: Callable[..., IndexFacts], job_id: UUID) -> None:
        execution = {"revision": revision, "job_id": job_id, "execution_id": context.execution_id}
        _event(db, media_id, facts(**execution))

    def fence(db: Session) -> UUID | None:
        """The claimed job's id while ``revision`` is current; else record supersession."""
        state = _lock(db, media_id)
        job = (
            None
            if state is None
            else queue.lock_and_renew_running_job_claim(db, context=context, lease_seconds=lease)
        )
        if state is None or job is None:
            return None
        if state.revision != revision:
            record(db, IndexSuperseded, job.id)
            return None
        return job.id

    def prepare(db: Session) -> tuple[str, list[IndexableBlock]] | None:
        job_id = fence(db)
        if job_id is None:
            return None
        kind, status, plain_text = db.execute(
            text("SELECT kind, processing_status, plain_text FROM media WHERE id = :id"),
            {"id": media_id},
        ).one()
        if status != "ready_for_reading":
            # A refresh owns the source now; its success requests the next revision.
            record(db, IndexSuperseded, job_id)
            return None
        record(db, IndexExecutionStarted, job_id)
        _set_state(db, IndexOwner("media", media_id), "indexing", reason)
        source_kind = "transcript" if kind in _TRANSCRIPT_KINDS else kind
        return source_kind, _media_blocks(db, media_id, kind, plain_text or "")

    work = _phase("prepare_media_content_reindex", prepare)
    if work is None:
        return result
    source_kind, blocks = work
    with parser_attempt_directory(context.job_id) as directory:
        spool = directory / "content-index.jsonl"
        try:
            spool_chunks(blocks, spool)
        except EnvelopeExceeded:
            return queue.TerminalJobFailure(
                result_payload=result | {"status": "too_large"},
                error_code=ApiErrorCode.E_SOURCE_TOO_LARGE.value,
                error_message="Document content exceeds the bounded indexing envelope.",
            )

        def publish(db: Session) -> ContentIndexResult | None:
            job_id = fence(db)
            if job_id is None:
                return None
            published = publish_content_index(
                db,
                owner=IndexOwner("media", media_id),
                source_kind=source_kind,
                blocks=blocks,
                chunks=read_spool(spool),
                reason=reason,
            )
            record(db, IndexSucceeded, job_id)
            return published

        published = _phase("publish_media_content_reindex", publish)
    if published is None:
        return result
    return result | {"status": published.status, "chunk_count": published.chunk_count}


def _phase[T](label: str, operation: Callable[[Session], T]) -> T:
    """One serializable transaction on a fresh session, retried on conflict."""
    db = get_session_factory()()
    try:

        def attempt() -> T:
            value = operation(db)
            db.commit()
            return value

        return retry_serializable(db, label, attempt)
    finally:
        db.close()


# Recovery of a dead reindex execution.


@dataclass(frozen=True, slots=True)
class SearchRecoveryFacts:
    revision: int
    dead_job_id: UUID | None  # the current revision's job, when it is dead
    is_creator: bool


def search_recovery(facts: SearchRecoveryFacts) -> SearchRecoveryAnswer:
    """The offer (imports, media): the creator may rerun the current revision's dead job.

    ``repair_dead_media_reindex`` admits exactly this, answering 403 and 409 instead.
    """
    if facts.dead_job_id is None:
        return None
    if not facts.is_creator:
        return "NotOwner"
    return RepairSearchOffer(expected_revision=facts.revision, expected_job_id=facts.dead_job_id)


def repair_dead_media_reindex(
    db: Session,
    *,
    actor: ViewerRecovery,
    media_id: UUID,
    expected_revision: int,
    expected_job_id: UUID,
) -> SearchRepairAdmission:
    """Requeue the exact dead job of the current revision; idempotent per mutation id.

    Never touches the source or the materialization: a ``ready`` index keeps serving
    search until the rerun marks it ``indexing``.
    """
    scope = f"media_search_repair:{media_id}"
    request_bytes = canonical_json_bytes(
        {"expected_revision": expected_revision, "expected_job_id": str(expected_job_id)}
    )

    def admit() -> SearchRepairAdmission:
        if not can_read_media(db, actor.viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        creator = db.scalar(
            text("SELECT created_by_user_id FROM media WHERE id = :id"), {"id": media_id}
        )
        if creator is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if creator != actor.viewer_id:
            raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
        replayed = lookup_replay(
            db,
            viewer_id=actor.viewer_id,
            scope=scope,
            client_mutation_id=actor.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replayed is not None:
            db.rollback()
            return SearchRepairAdmission.model_validate(replayed)
        state = _lock(db, media_id)
        if state is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no search index to repair."
            )
        job = _current_job(db, media_id, state.revision)
        dead = job if job is not None and job.status == "dead" else None
        if dead is None or (state.revision, dead.id) != (expected_revision, expected_job_id):
            current: dict[str, object] = {"revision": state.revision}
            if dead is not None:
                current["job_id"] = str(dead.id)
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected search index execution is no longer current.",
                details={"current": current},
            )
        queue.requeue_dead_job(db, job_id=dead.id)
        _event(db, media_id, IndexRecoveryAccepted(revision=state.revision, job_id=dead.id))
        admission = SearchRepairAdmission(
            media_id=media_id, revision=state.revision, job_id=dead.id
        )
        record_replay(
            db,
            viewer_id=actor.viewer_id,
            scope=scope,
            client_mutation_id=actor.client_mutation_id,
            request_bytes=request_bytes,
            response_json=admission.model_dump(mode="json"),
        )
        db.commit()
        return admission

    return admit_serializable(db, "repair_dead_media_reindex", admit)
