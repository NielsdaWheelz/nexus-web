"""The content index: cited text publication, then semantic completion on its exact ids.

An owner is a media (web article, epub, pdf, or a podcast episode or video through its
transcript) or a note block. Its materialization is its evidence spans, content chunks
and embeddings. Text publication atomically replaces spans/chunks and stamps
``lexical_revision = revision``. Semantic completion attaches vectors to those exact
ids, then marks ``ready`` on the active embedding identity. Provider failure retains text.
Retries resume current text; completed outcomes replay without ids/timestamps/effects changes.

A media's index is fenced by a monotonic ``revision``. Only ``request_media_content_reindex``
creates jobs, and each request raises the revision and leaves exactly one waiting job for
it, so a revision has at most one job. A job snapshots the source and publishes only
while its revision is current and it still holds its queue claim (``fence``, taken at
both ends of the job). Lock order: media row ``FOR NO KEY UPDATE`` (which admits the
``KEY SHARE`` a worker's history insert takes), then the state row, then queue rows.
A note's index is rebuilt by ``note_indexing``. Canonical x posts own their
passages once; threads own no chunks. A post index publish requests primary
parents' existing summary jobs after all primary indexes are current.
"""

from __future__ import annotations

import json
from array import array
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from provider_runtime.errors import CredentialMissing
from sqlalchemy import Row, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.retries import admit_serializable, retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs import queue
from nexus.schemas.import_history import (
    IndexAccepted,
    IndexExecutionStarted,
    IndexFacts,
    IndexRecoveryAccepted,
    IndexSucceeded,
    IndexSuperseded,
)
from nexus.schemas.imports import RepairSearchOffer
from nexus.schemas.media_sources import SearchRepairAdmission
from nexus.services import media_intelligence_lifecycle
from nexus.services.capabilities import SearchRecoveryAnswer
from nexus.services.content_chunking import (
    Chunk,
    EnvelopeExceeded,
    IndexableBlock,
    read_embeddings,
    read_spool,
    spool_chunks,
    spool_embeddings,
    spool_published_chunks,
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
from nexus.services.suggestion_changes import record_input_change
from nexus.services.web_article_structure import (
    add_heading_anchors,
    build_web_article_index_blocks,
)

JOB_KIND = "media_content_reindex_job"
ReindexReason = Literal["source_success", "reconciliation", "oracle_corpus_seed"]
_TRANSCRIPT_KINDS = ("podcast_episode", "video")


@dataclass(frozen=True)
class IndexOwner:
    kind: Literal["media", "note_block"]
    id: UUID


@dataclass(frozen=True)
class ContentIndexResult:
    owner: IndexOwner
    status: str  # indexing | ready | no_text | ocr_required
    chunk_count: int


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
    if owner.kind == "note_block":
        # Live derived-reference admission holds KEY SHARE on this owner. Exclude
        # it before replacing endpoints, then resolve old owners before deletion.
        db.execute(text("SELECT id FROM note_blocks WHERE id = :id FOR UPDATE"), {"id": owner.id})
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


def publish_text_index(
    db: Session,
    *,
    owner: IndexOwner,
    source_kind: str,
    blocks: Sequence[IndexableBlock],
    chunks: Iterable[Chunk],
    reason: str,
) -> ContentIndexResult:
    """Replace spans/chunks atomically, without embeddings; publish lexical readiness.

    No chunks completes as ``ocr_required`` for pdf, otherwise ``no_text``.
    """
    _clear(db, owner)
    params: dict[str, Any] = {"kind": owner.kind, "id": owner.id}
    resolver = "web" if source_kind == "web_article" else source_kind
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
        db.execute(
            text(
                "INSERT INTO content_chunks (owner_kind, owner_id, primary_evidence_span_id,"
                " chunk_idx, source_kind, chunk_text, heading_path, summary_locator)"
                " VALUES (:kind, :id, :span, :idx, :source_kind, :text,"
                " CAST(:heading AS jsonb), CAST(:locator AS jsonb))"
            ),
            row
            | {
                "span": span_id,
                "idx": count - 1,
                "source_kind": source_kind,
                "heading": json.dumps(list(heading)),
            },
        )
    status = "indexing" if count else "ocr_required" if source_kind == "pdf" else "no_text"
    _set_state(db, owner, status, reason if count else status)
    db.execute(
        text(
            "UPDATE content_index_states SET lexical_revision = CASE WHEN :has_text THEN revision ELSE NULL END"
            " WHERE owner_kind = :kind AND owner_id = :id"
        ),
        params | {"has_text": bool(count)},
    )
    if not count:
        _complete_media_effects(db, owner, count)
    return ContentIndexResult(owner, status, count)


def _complete_media_effects(db: Session, owner: IndexOwner, count: int) -> None:
    if owner.kind == "media":
        if count or db.scalar(
            text("SELECT 1 FROM x_thread_sources WHERE media_id = :id"), {"id": owner.id}
        ):
            media_intelligence_lifecycle.ensure_media_unit_in_tx(db, media_id=owner.id)
        for parent_id in db.scalars(
            text("""SELECT thread_media_id FROM x_thread_posts
                WHERE post_media_id = :id ORDER BY thread_media_id"""),
            {"id": owner.id},
        ):
            media_intelligence_lifecycle.ensure_media_unit_in_tx(db, media_id=parent_id)


def completed_content_index(
    db: Session, owner: IndexOwner, state: Row[Any]
) -> ContentIndexResult | None:
    """Completed current outcomes replay without changing ids, timestamps or effects."""
    if state.status in ("no_text", "ocr_required") or (
        state.lexical_revision == state.revision
        and (state.status, state.provider, state.model)
        == ("ready", EMBEDDING_PROVIDER, embedding_model())
    ):
        count = db.scalar(
            text("SELECT count(*) FROM content_chunks WHERE owner_kind = :kind AND owner_id = :id"),
            {"kind": owner.kind, "id": owner.id},
        )
        return ContentIndexResult(owner, state.status, count)
    return None


def snapshot_published_chunks(db: Session, owner: IndexOwner, path: Path) -> None:
    """The fenced current publication as a bounded private spool; no provider work."""
    rows = db.execute(
        text(
            "SELECT id, chunk_text FROM content_chunks WHERE owner_kind = :kind AND owner_id = :id ORDER BY chunk_idx, id"
        ),
        {"kind": owner.kind, "id": owner.id},
        execution_options={"yield_per": 1},
    )
    spool_published_chunks(((row.id, row.chunk_text) for row in rows), path)


def publish_embeddings(
    db: Session, *, owner: IndexOwner, embeddings: Iterable[tuple[UUID, bytes]], reason: str
) -> ContentIndexResult:
    """Install complete vectors on existing ids; caller holds claim/revision/lexical fences."""
    params = {"kind": owner.kind, "id": owner.id}
    db.execute(
        text(
            "DELETE FROM content_embeddings ce USING content_chunks cc"
            " WHERE ce.chunk_id = cc.id AND cc.owner_kind = :kind AND cc.owner_id = :id"
        ),
        params,
    )
    current_ids = db.scalars(
        text(
            "SELECT id FROM content_chunks WHERE owner_kind = :kind AND owner_id = :id ORDER BY chunk_idx, id"
        ),
        params,
        execution_options={"stream_results": True},
    )
    model = embedding_model()
    count = 0
    for current_id, (chunk_id, embedding_f32) in zip(current_ids, embeddings, strict=True):
        # justify-service-invariant-check: ordered exact ids prove coverage without an unbounded id set.
        if chunk_id != current_id:
            raise AssertionError("embedding spool differs from the current publication")
        count += 1
        vector = array("f")
        vector.frombytes(embedding_f32)
        db.execute(
            text(
                "INSERT INTO content_embeddings (chunk_id, embedding_provider, embedding_model, embedding_dimensions, embedding_vector)"
                f" VALUES (:chunk, :provider, :model, :dimensions, CAST(:vector AS vector({EMBEDDING_DIMENSIONS})))"
            ),
            {
                "chunk": chunk_id,
                "provider": EMBEDDING_PROVIDER,
                "model": model,
                "dimensions": EMBEDDING_DIMENSIONS,
                "vector": pgvector_literal(vector),
            },
        )
    # justify-service-invariant-check: a ready publication must cover every current chunk exactly once.
    if not count:
        raise AssertionError("embedding spool does not cover the current publication")
    _set_state(db, owner, "ready", reason)
    _complete_media_effects(db, owner, count)
    return ContentIndexResult(owner, "ready", count)


def mark_content_index_pending(db: Session, *, owner: IndexOwner, reason: str) -> int:
    """Raise revision and withdraw capability, retaining rows until text replacement."""
    return _set_state(db, owner, "pending", reason, bump=1)


def delete_content_index(db: Session, *, owner: IndexOwner) -> None:
    """The owner is going away: its materialization and its state row go first."""
    _clear(db, owner)
    db.execute(
        text("DELETE FROM content_index_states WHERE owner_kind = :kind AND owner_id = :id"),
        {"kind": owner.kind, "id": owner.id},
    )


# A media's blocks, read inside the job's snapshot transaction.


def _media_blocks(db: Session, media_id: UUID, kind: str, plain_text: str) -> list[IndexableBlock]:
    """Canonical body passages only; a thread owns no duplicated post chunks."""
    params = {"media_id": media_id}
    if db.scalar(text("SELECT 1 FROM x_thread_sources WHERE media_id = :media_id"), params):
        return []
    if db.scalar(text("SELECT 1 FROM x_post_sources WHERE media_id = :media_id"), params):
        fragment_id, source = db.execute(
            text("""
            SELECT id, canonical_text FROM fragments WHERE media_id = :media_id
        """),
            params,
        ).one()
        return (
            [
                IndexableBlock(
                    source,
                    0,
                    {
                        "type": "web_text_offsets",
                        "kind": "web_text",
                        "fragment_id": str(fragment_id),
                        "fragment_idx": 0,
                        "start_offset": 0,
                        "end_offset": len(source),
                    },
                )
            ]
            if source
            else []
        )
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
                # Publication owns heading normalization: a fragment without
                # anchors is a defect, and this job dies so the repair offer shows it.
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
                    locator["parent_section_id"] = spec.parent_section_id
                    locator["owns_container"] = spec.owns_container
                if spec.anchor_id is not None:
                    locator["anchor_id"] = spec.anchor_id
                if spec.heading_level is not None:
                    locator["heading_level"] = spec.heading_level
                if spec.container_end_offset is not None:
                    locator["container_end_offset"] = spec.container_end_offset
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


def _lock_media_and_summary_parents(db: Session, media_id: UUID) -> bool:
    """Source/index publication and summary publication share the parent media lock."""
    ids = db.scalars(
        text("""
        SELECT id FROM media WHERE id = :id OR id IN (
            SELECT thread_media_id FROM x_thread_posts WHERE post_media_id = :id)
        ORDER BY id FOR NO KEY UPDATE
    """),
        {"id": media_id},
    ).all()
    return media_id in ids


def _lock(db: Session, media_id: UUID) -> Row[Any] | None:
    """Lock the media row, then its state row: ``(revision, status, provider, model)``.

    None when either row is missing.
    """
    if _lock_media_and_summary_parents(db, media_id):
        return db.execute(
            text(
                "SELECT revision, lexical_revision, status, active_embedding_provider AS provider,"
                " active_embedding_model AS model FROM content_index_states"
                " WHERE owner_kind = 'media' AND owner_id = :id FOR UPDATE"
            ),
            {"id": media_id},
        ).one_or_none()
    return None


def _current_job(db: Session, media_id: UUID, revision: int) -> queue.JobRow | None:
    """The revision's newest job, locked."""
    match = {"media_id": str(media_id), "revision": revision}
    jobs = queue.jobs_for_payload(db, kind=JOB_KIND, match=match, lock=True)
    return jobs[-1] if jobs else None


def _event(db: Session, media_id: UUID, facts: IndexFacts) -> None:
    append_processing_event(db, media_id=media_id, facts=facts, stage="Index", failure_code=None)


def request_media_content_reindex(db: Session, *, media_id: UUID, reason: ReindexReason) -> None:
    """Raise the revision and leave exactly one waiting job for it.

    A waiting (unclaimed) job of an older revision is reset to this one; a running job
    keeps its revision and will find itself superseded at its fence.
    """
    if not _lock_media_and_summary_parents(db, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    revision = _set_state(db, IndexOwner("media", media_id), "pending", reason, bump=1)
    payload = {"media_id": str(media_id), "revision": revision, "reason": reason}
    waiting = [
        job
        for job in queue.jobs_for_payload(
            db, kind=JOB_KIND, match={"media_id": str(media_id)}, lock=True
        )
        if job.status in ("pending", "failed")
    ]
    for obsolete in waiting[1:]:
        queue.supersede_unclaimed_job(db, job_id=obsolete.id, kind=JOB_KIND)
    if waiting:
        queue.reset_unclaimed_job(db, job_id=waiting[0].id, kind=JOB_KIND, payload=payload)
    else:
        queue.enqueue_job(db, kind=JOB_KIND, payload=payload)
    _event(db, media_id, IndexAccepted(revision=revision))


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
            state.lexical_revision == state.revision
            and (state.status, state.provider, state.model)
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
    if not _lock_media_and_summary_parents(db, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
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

    def record(db: Session, facts: Callable[..., IndexFacts]) -> None:
        _event(db, media_id, facts(revision=revision))

    def fence(db: Session) -> bool:
        """Whether the claim holds while ``revision`` is current; a newer one is recorded."""
        state = _lock(db, media_id)
        job = None if state is None else queue.lock_running_job_claim(db, context=context)
        if state is None or job is None:
            return False
        if state.revision != revision:
            record(db, IndexSuperseded)
            return False
        return True

    owner = IndexOwner("media", media_id)

    def prepare(db: Session) -> ContentIndexResult | tuple[str, list[IndexableBlock], bool] | None:
        if not fence(db):
            return None
        state = _lock(db, media_id)
        assert state is not None
        completed = completed_content_index(db, owner, state)
        if completed is not None:
            return completed
        kind, status, plain_text = db.execute(
            text("SELECT kind, processing_status, plain_text FROM media WHERE id = :id"),
            {"id": media_id},
        ).one()
        if status != "ready_for_reading":
            record(db, IndexSuperseded)
            return None
        record(db, IndexExecutionStarted)
        _set_state(db, owner, "indexing", reason)
        lexical_ready = state.lexical_revision == revision
        source_kind = "transcript" if kind in _TRANSCRIPT_KINDS else kind
        blocks = [] if lexical_ready else _media_blocks(db, media_id, kind, plain_text or "")
        record_input_change(db)
        return source_kind, blocks, lexical_ready

    work = index_phase("prepare_media_content_reindex", prepare)
    if work is None:
        return result
    if isinstance(work, ContentIndexResult):
        return result | {"status": work.status, "chunk_count": work.chunk_count}
    source_kind, blocks, lexical_ready = work
    with parser_attempt_directory(context.job_id) as directory:
        chunks_spool = directory / "text.jsonl"
        embedding_spool = directory / "embeddings.jsonl"
        try:
            if not lexical_ready:
                spool_chunks(blocks, chunks_spool)

                def publish_text(db: Session) -> ContentIndexResult | None:
                    if not fence(db):
                        return None
                    published = publish_text_index(
                        db,
                        owner=owner,
                        source_kind=source_kind,
                        blocks=blocks,
                        chunks=read_spool(chunks_spool),
                        reason=reason,
                    )
                    if published.status != "indexing":
                        record(db, IndexSucceeded)
                    record_input_change(db)
                    return published

                published = index_phase("publish_media_text", publish_text)
                if published is None:
                    return result
                if published.status != "indexing":
                    return result | {
                        "status": published.status,
                        "chunk_count": published.chunk_count,
                    }

            def snapshot(db: Session) -> bool:
                if not fence(db):
                    return False
                state = _lock(db, media_id)
                if state is None or state.lexical_revision != revision:
                    return False
                snapshot_published_chunks(db, owner, chunks_spool)
                return True

            if not index_phase("snapshot_media_chunks", snapshot):
                return result
            spool_embeddings(chunks_spool, embedding_spool)
        except CredentialMissing:
            return queue.TerminalJobFailure(
                result_payload=result | {"status": "embedding_not_configured"},
                error_code=ApiErrorCode.E_EMBEDDING_NOT_CONFIGURED.value,
                error_message="No embedding provider credential is configured.",
            )
        except EnvelopeExceeded:
            return queue.TerminalJobFailure(
                result_payload=result | {"status": "too_large"},
                error_code=ApiErrorCode.E_SOURCE_TOO_LARGE.value,
                error_message="Document content exceeds the bounded indexing envelope.",
            )

        def publish(db: Session) -> ContentIndexResult | None:
            if not fence(db):
                return None
            state = _lock(db, media_id)
            if state is None or state.lexical_revision != revision:
                return None
            published = publish_embeddings(
                db, owner=owner, embeddings=read_embeddings(embedding_spool), reason=reason
            )
            record(db, IndexSucceeded)
            record_input_change(db)
            return published

        published = index_phase("publish_media_embeddings", publish)
    if published is None:
        return result
    return result | {"status": published.status, "chunk_count": published.chunk_count}


def index_phase[T](label: str, operation: Callable[[Session], T]) -> T:
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
    ready_for_reading: bool


def search_recovery(facts: SearchRecoveryFacts) -> SearchRecoveryAnswer:
    """The offer (imports, media): the creator may rerun the current revision's dead job.

    ``repair_dead_media_reindex`` admits exactly this, answering 403 and 409 instead.
    """
    if facts.dead_job_id is None or not facts.ready_for_reading:
        return None
    if not facts.is_creator:
        return "NotOwner"
    return RepairSearchOffer(expected_revision=facts.revision, expected_job_id=facts.dead_job_id)


def repair_dead_media_reindex(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_revision: int,
    expected_job_id: UUID,
) -> SearchRepairAdmission:
    """Requeue the exact dead job of the current revision.

    Retry rule: the same revision and job, no longer dead, is the repair that landed.
    Never touches the source or the materialization. Current text keeps serving; a
    completed current outcome replays without changing state, ids or effects.
    """

    def admit() -> SearchRepairAdmission:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        creator = db.scalar(
            text("SELECT created_by_user_id FROM media WHERE id = :id"), {"id": media_id}
        )
        if creator is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if creator != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
        state = _lock(db, media_id)
        if (
            db.scalar(
                text("SELECT processing_status::text FROM media WHERE id = :id"), {"id": media_id}
            )
            != "ready_for_reading"
        ):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media is not ready for search indexing."
            )
        if state is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no search index to repair."
            )
        job = _current_job(db, media_id, state.revision)
        if job is None or (state.revision, job.id) != (expected_revision, expected_job_id):
            current: dict[str, object] = {"revision": state.revision}
            if job is not None and job.status == "dead":
                current["job_id"] = str(job.id)
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected search index execution is no longer current.",
                details={"current": current},
            )
        if job.status == "dead":
            queue.requeue_dead_job(db, job_id=job.id)
            _event(db, media_id, IndexRecoveryAccepted(revision=state.revision))
        db.commit()
        return SearchRepairAdmission(media_id=media_id, revision=state.revision, job_id=job.id)

    return admit_serializable(db, "repair_dead_media_reindex", admit)
