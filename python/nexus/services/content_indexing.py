"""The content index: each owner's citable text and embedded passages.

An owner is a media (web article, epub, pdf, or a podcast episode or video through its
transcript) or a note block. Its materialization is its evidence spans, content chunks
and embeddings. Text publication replaces chunks and spans atomically and sets
``lexical_revision``. Embedding publication later fills vectors for those exact chunks.
Lexical readers require the current revision; semantic readers also require the active
provider and model. A pending replacement never admits stale rows.

A media's index is fenced by a monotonic ``revision``. Only ``request_media_content_reindex``
creates jobs, and each request raises the revision and leaves exactly one waiting job for
it, so a revision has at most one job. A job snapshots the source and publishes only
while its revision is current and it still holds its queue claim (``fence``, taken at
both ends of the job). Lock order: media row ``FOR NO KEY UPDATE`` (which admits the
``KEY SHARE`` a worker's history insert takes), then the state row, then queue rows.
A note's index is rebuilt by ``note_indexing``. Canonical x posts own their
passages once; threads own no chunks. A post index publish requests primary
parents' existing summary jobs after all primary indexes are current.

A text source (an epub or web article, never an x composition) is indexed once, cut
at its partition: every detected section start/end and accepted piece endpoint. Its
state records ``section_bounds_key`` (generation, sorted partition points, chunker
contract version) for the partition its published index used, and
``section_witness_key`` (generation, section geometry, detector version) once
structural preparation completed for that geometry, proved or not, independent of
embedding status. A job's payload freezes both target keys. A job lacking current
preparation rederives EPUB navigation from the verified stored package outside any
transaction and commits it before embedding. changed geometry supersedes the old
index revision through normal admission, preserving canonical text, generation and
accepted piece cuts. a provider outage blocks neither creation nor discovery; html proves its cuts from retained dom at read time. Every
transaction that changes accepted bounds calls ``reconcile_media_section_bounds``,
which raises the revision unless the partition is already published or requested, and
publication asserts its captured partition under the revision fence: a ``ready`` index
always carries its source's current partition. ``reading_chunks_sql`` is the one
admission of chunks to reading identities; a piece never owns chunks or embeddings.
"""

from __future__ import annotations

import hashlib
import json
from array import array
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from provider_runtime.errors import CredentialMissing
from sqlalchemy import Row, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_serializable
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
from nexus.schemas.media_parts import PartPrepare
from nexus.schemas.media_sources import SearchRepairAdmission
from nexus.schemas.reader_apparatus import NoteRegion
from nexus.services import library_entries, media_intelligence_lifecycle
from nexus.services.content_chunking import (
    CHUNKER_CONTRACT_VERSION,
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
from nexus.services.epub_ingest import (
    EpubNavigationPlan,
    RetainedEpubFragment,
    derive_epub_navigation,
    replace_epub_navigation_projection,
)
from nexus.services.import_history import append_processing_event
from nexus.services.media_parts import part_source_block_reason, require_part_source_creator
from nexus.services.media_text_scope import text_scope_rows_sql
from nexus.services.parser_temp import parser_attempt_directory, stream_storage_object_to_file
from nexus.services.reader_apparatus import read_note_regions
from nexus.services.reader_navigation import read_media_navigation_proof
from nexus.services.reader_publication import read_publication_generation
from nexus.services.reader_structure import NavigationProof
from nexus.services.reader_text_slice import section_witness_key
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.services.web_article_structure import (
    add_heading_anchors,
    build_web_article_index_blocks,
)
from nexus.storage.client import get_storage_client

JOB_KIND = "media_content_reindex_job"
ReindexReason = Literal[
    "source_success",
    "reconciliation",
    "oracle_corpus_seed",
    "section_preparation",
    "section_bounds",
]
_TRANSCRIPT_KINDS = ("podcast_episode", "video")
_LIVE = ("pending", "failed", "running")


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
    """Delete index children, then withdraw their known-deleted keyword identities."""
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
    if owner.kind == "media":
        projection.withdraw(
            db, "content_chunk", [ref.id for ref in refs if ref.scheme == "content_chunk"]
        )


def _insert_chunk_batch(db: Session, owner: IndexOwner, source_kind: str, rows: list[str]) -> None:
    """Insert paired spans/chunks from one bounded batch, without positional pairing."""
    inserted = db.scalar(
        text(
            """
            WITH input AS MATERIALIZED (
                SELECT gen_random_uuid() AS span_id, item.*
                FROM jsonb_to_recordset(CAST(:chunks AS jsonb)) AS item(
                    chunk_idx integer, chunk_text text, heading_path jsonb,
                    locator jsonb, citation_label text
                )
            ), spans AS (
                INSERT INTO evidence_spans (
                    id, owner_kind, owner_id, span_text, selector, citation_label, resolver_kind
                )
                SELECT span_id, :kind, :id, chunk_text, locator, citation_label, :resolver
                FROM input
                RETURNING id
            ), chunks AS (
                INSERT INTO content_chunks (
                    owner_kind, owner_id, primary_evidence_span_id, chunk_idx,
                    source_kind, chunk_text, heading_path, summary_locator
                )
                SELECT :kind, :id, input.span_id, input.chunk_idx, :source_kind,
                    input.chunk_text, input.heading_path, input.locator
                FROM input JOIN spans ON spans.id = input.span_id
                RETURNING id
            )
            SELECT count(*) FROM chunks
            """
        ),
        {
            "kind": owner.kind,
            "id": owner.id,
            "source_kind": source_kind,
            "resolver": "web" if source_kind == "web_article" else source_kind,
            "chunks": "[" + ",".join(rows) + "]",
        },
    )
    assert inserted == len(rows), "content chunk batch was not fully inserted"


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
    Media callers own serializable source reads and worker fences through commit.
    Paired inserts stream in batches of 128 rows or 512 KiB; a single larger row
    remains valid. Batching does not split the publication transaction.
    """
    _clear(db, owner)
    params: dict[str, Any] = {"kind": owner.kind, "id": owner.id}
    batch: list[str] = []
    size = 2  # JSON array brackets.
    count = 0
    for count, chunk in enumerate(chunks, start=1):
        heading = blocks[chunk.block_idx].heading_path
        encoded = json.dumps(
            {
                "chunk_idx": count - 1,
                "chunk_text": chunk.text,
                "heading_path": list(heading),
                "locator": chunk.locator,
                "citation_label": heading[-1] if heading else "Source",
            }
        )
        row_bytes = len(encoded.encode("utf-8"))
        if batch and (len(batch) == 128 or size + 1 + row_bytes > 512 * 1024):
            _insert_chunk_batch(db, owner, source_kind, batch)
            batch = []
            size = 2
        batch.append(encoded)
        size += row_bytes + (1 if len(batch) > 1 else 0)
    if batch:
        _insert_chunk_batch(db, owner, source_kind, batch)
    status = "indexing" if count else "ocr_required" if source_kind == "pdf" else "no_text"
    _set_state(db, owner, status, reason if count else status)
    db.execute(
        text(
            "UPDATE content_index_states SET lexical_revision = CASE WHEN :has_text THEN revision ELSE NULL END"
            " WHERE owner_kind = :kind AND owner_id = :id"
        ),
        params | {"has_text": bool(count)},
    )
    if owner.kind == "media":
        new_chunk_ids = db.scalars(
            text("SELECT id FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :id"),
            {"id": owner.id},
        ).all()
        projection.refresh(db, "content_chunk", new_chunk_ids)
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


# A text source's sections and partition, read under the media lock.


@dataclass(frozen=True)
class _Sections:
    """Detected sections and the index partition at the source's current publication."""

    generation: int
    proof: NavigationProof
    witness_key: str
    bounds_key: str
    points: list[tuple[int, int]]  # sorted unique (fragment_idx, offset)


def _read_sections(db: Session, media_id: UUID) -> _Sections | None:
    """None unless the media is a ready, published piece source (``media_parts`` owns
    that eligibility). Titles, candidates and rich cuts never enter the partition."""
    media = db.get(Media, media_id)
    if media is None or part_source_block_reason(db, media=media) is not None:
        return None
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None:
        return None
    proof = read_media_navigation_proof(
        db,
        media_id=media_id,
        kind="epub" if media.kind == "epub" else "web_article",
        generation=generation,
    )
    points = {(s.start.fragment_idx, s.start.offset) for s in proof.sections}
    points |= {(s.end.fragment_idx, s.end.offset) for s in proof.sections if s.end is not None}
    for start_idx, start, end_idx, end in db.execute(
        text(
            "SELECT start_fragment_idx, start_offset, end_fragment_idx, end_offset"
            " FROM media_parts WHERE source_media_id = :id"
        ),
        {"id": media_id},
    ):
        points |= {(start_idx, start), (end_idx, end)}
    ordered = sorted(points)
    bounds_key = hashlib.sha256(
        json.dumps([generation, ordered, CHUNKER_CONTRACT_VERSION], separators=(",", ":")).encode()
    ).hexdigest()
    return _Sections(
        generation, proof, section_witness_key(generation, proof.sections), bounds_key, ordered
    )


def _partitioned(
    blocks: Sequence[IndexableBlock], points: Sequence[tuple[int, int]]
) -> list[IndexableBlock]:
    """Cut each fragment block at the partition points inside it; a block's partition is
    the number of points at or before its start, so chunks never join across a point."""
    out: list[IndexableBlock] = []
    for block in blocks:
        idx = int(str(block.locator["fragment_idx"]))
        start, end = int(str(block.locator["start_offset"])), int(str(block.locator["end_offset"]))
        inside = points[bisect_right(points, (idx, start)) : bisect_left(points, (idx, end))]
        for lo, hi in pairwise([start, *(offset for _, offset in inside), end]):
            out.append(
                IndexableBlock(
                    block.text[lo - start : hi - start],
                    block.start + lo - start,
                    block.locator | {"start_offset": lo, "end_offset": hi},
                    block.heading_path,
                    bisect_right(points, (idx, lo)),
                )
            )
    return out


def reading_chunks_sql(reading_ids_sql: str) -> str:
    """``(reading_media_id, chunk_id)``: current lexical chunks each reading identity
    admits; the one chunk admission for search, reads and similarity.

    ``reading_ids_sql`` yields ``media_id`` and already carries its audience. A media
    admits its own current text index whole. A piece admits the chunks of its source's
    partitioned index lying wholly inside its frozen range, so text beyond its bounds
    never enters; exact partition currency is the reconcile protocol's invariant above.
    Embedding identity (provider/model) stays with vector consumers.
    """
    return f"""
        SELECT chunk_reader.media_id AS reading_media_id, admitted_chunk.id AS chunk_id
        FROM ({reading_ids_sql}) chunk_reader
        JOIN content_chunks admitted_chunk ON admitted_chunk.owner_kind = 'media'
            AND admitted_chunk.owner_id = chunk_reader.media_id
        JOIN content_index_states admitted_state ON admitted_state.owner_kind = 'media'
            AND admitted_state.owner_id = admitted_chunk.owner_id
            AND admitted_state.lexical_revision = admitted_state.revision
        UNION ALL
        SELECT bounded.reading_media_id, admitted_chunk.id
        FROM ({text_scope_rows_sql(reading_ids_sql)}) bounded
        JOIN content_index_states admitted_state ON admitted_state.owner_kind = 'media'
            AND admitted_state.owner_id = bounded.source_media_id
            AND admitted_state.lexical_revision = admitted_state.revision
            AND admitted_state.section_bounds_key IS NOT NULL
        JOIN content_chunks admitted_chunk ON admitted_chunk.owner_kind = 'media'
            AND admitted_chunk.owner_id = bounded.source_media_id
            AND admitted_chunk.summary_locator ->> 'fragment_id' = CAST(bounded.fragment_id AS text)
            AND bounded.start_offset
                <= CAST(admitted_chunk.summary_locator ->> 'start_offset' AS integer)
            AND CAST(admitted_chunk.summary_locator ->> 'end_offset' AS integer)
                <= bounded.end_offset
        WHERE bounded.reading_media_id <> bounded.source_media_id
    """


# A media's blocks, read inside the job's snapshot transaction.


def _media_blocks(
    db: Session, media_id: UUID, kind: str, plain_text: str, points: Sequence[tuple[int, int]]
) -> list[IndexableBlock]:
    """Canonical body passages only, cut at ``points``; a thread owns no duplicated post
    chunks."""
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
    return _partitioned(blocks, points)


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
    """Lock the media row, then its state row: ``(revision, lexical_revision, status, provider, model,
    section_witness_key, section_bounds_key)``.

    None when either row is missing.
    """
    if _lock_media_and_summary_parents(db, media_id):
        return db.execute(
            text(
                "SELECT revision, lexical_revision, status, active_embedding_provider AS provider,"
                " active_embedding_model AS model, section_witness_key, section_bounds_key"
                " FROM content_index_states"
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


@dataclass(frozen=True)
class _ClientRequest:
    """An explicit section preparation: its client-minted job id and immutable request."""

    job_id: UUID
    requester_user_id: UUID
    source_generation: int

    @property
    def identity(self) -> dict[str, object]:
        return {
            "requester_user_id": str(self.requester_user_id),
            "source_generation": self.source_generation,
        }


def request_media_content_reindex(db: Session, *, media_id: UUID, reason: ReindexReason) -> int:
    """Raise the revision and leave exactly one waiting job for it; return the revision.

    The payload freezes the source's target section witness and partition keys (null for
    a media without sections). A waiting (unclaimed) server-minted job of an older
    revision is reset to this one; a running job keeps its revision and will find itself
    superseded at its fence.
    """
    return _request(db, media_id, reason, None)


def _request(
    db: Session, media_id: UUID, reason: ReindexReason, client: _ClientRequest | None
) -> int:
    """A client-identified job keeps its original request: it is never reset to another
    request, only superseded, and a client request always takes its own id."""
    if not _lock_media_and_summary_parents(db, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    sections = _read_sections(db, media_id)
    revision = _set_state(db, IndexOwner("media", media_id), "pending", reason, bump=1)
    payload = {
        "media_id": str(media_id),
        "revision": revision,
        "reason": reason,
        "request": None if client is None else client.identity,
        "section_witness_key": None if sections is None else sections.witness_key,
        "section_bounds_key": None if sections is None else sections.bounds_key,
    }
    waiting = [
        job
        for job in queue.jobs_for_payload(
            db, kind=JOB_KIND, match={"media_id": str(media_id)}, lock=True
        )
        if job.status in ("pending", "failed")
    ]
    reused = (
        [job for job in waiting if job.payload["request"] is None][:1] if client is None else []
    )
    for obsolete in waiting:
        if obsolete not in reused:
            queue.supersede_unclaimed_job(db, job_id=obsolete.id, kind=JOB_KIND)
    if reused:
        queue.reset_unclaimed_job(db, job_id=reused[0].id, kind=JOB_KIND, payload=payload)
    else:
        queue.enqueue_job(
            db, kind=JOB_KIND, payload=payload, id=None if client is None else client.job_id
        )
    _event(db, media_id, IndexAccepted(revision=revision))
    return revision


def request_stale_media_content_reindex(
    db: Session, *, media_id: UUID, reason: ReindexReason
) -> bool:
    """Request a revision unless the index is current or its job is live; whether it did.

    Current: ``ready`` on the active embedding identity, or ``no_text``/``ocr_required``.
    A dead current job is retried by the new revision: the caller asked explicitly.
    """
    state = _lock(db, media_id)
    if state is not None:
        sections = _read_sections(db, media_id)
        current_bounds = None if sections is None else sections.bounds_key
        if state.section_bounds_key == current_bounds and (
            state.status in ("no_text", "ocr_required")
            or (
                state.lexical_revision == state.revision
                and (state.status, state.provider, state.model)
                == ("ready", EMBEDDING_PROVIDER, embedding_model())
            )
        ):
            return False
        job = _current_job(db, media_id, state.revision)
        if job is not None and job.status in ("pending", "failed", "running"):
            return False
    request_media_content_reindex(db, media_id=media_id, reason=reason)
    return True


def reconcile_media_section_bounds(db: Session, *, media_id: UUID) -> bool:
    """Request a reindex unless the source's current partition is already published or
    requested by its live job; whether it did.

    Runs in the caller's transaction that created, corrected or physically removed
    accepted piece bounds, under its source barrier. An unchanged partition costs no
    reindex; a changed one moves the index to ``pending`` in this same transaction.
    """
    state = _lock(db, media_id)
    sections = _read_sections(db, media_id)
    current = None if sections is None else sections.bounds_key
    if state is not None:
        job = _current_job(db, media_id, state.revision)
        target = (
            job.payload["section_bounds_key"]
            if job is not None and job.status in _LIVE
            else state.section_bounds_key
        )
        if target == current:
            return False
    request_media_content_reindex(db, media_id=media_id, reason="section_bounds")
    return True


def prepare_media_parts(
    db: Session, *, viewer_id: UUID, source_media_id: UUID, request: PartPrepare
) -> SearchRepairAdmission:
    """Ensure the source's current structural preparation; never launches discovery.

    Retry rule: ``request.id`` is the durable job id. After visibility and creator
    authority, a known id answers its own job when it is this creator's preparation of
    this source at the same expected generation, else 409; this precedes any reuse or
    admission. Then a completed preparation or a live job targeting the current section
    witness key is reused; otherwise the id becomes the job of a new revision. A retry of
    failed or superseded work uses a new id.
    """
    client = _ClientRequest(request.id, viewer_id, request.expected_source_generation)

    def admit() -> SearchRepairAdmission:
        media = db.get(Media, source_media_id)
        if media is None or not can_read_media(db, viewer_id, source_media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.created_by_user_id != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
        known = queue.get_job(db, request.id)  # a client job's request never changes
        if known is not None:
            if known.kind != JOB_KIND or (
                known.payload["media_id"],
                known.payload["reason"],
                known.payload["request"],
            ) != (str(source_media_id), "section_preparation", client.identity):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "The job id belongs to another request."
                )
            return SearchRepairAdmission(
                media_id=source_media_id, revision=known.payload["revision"], job_id=known.id
            )
        require_part_source_creator(db, viewer_id=viewer_id, source_media_id=source_media_id)
        state = _lock(db, source_media_id)
        sections = _read_sections(db, source_media_id)
        assert sections is not None  # an eligible ready source is published with sections
        if sections.generation != request.expected_source_generation:
            raise ConflictError(
                ApiErrorCode.E_READER_CONTENT_CHANGED, "The source publication changed."
            )
        if state is not None:
            job = _current_job(db, source_media_id, state.revision)
            if job is not None and (
                state.section_witness_key == sections.witness_key
                or (
                    job.status in _LIVE
                    and job.payload["section_witness_key"] == sections.witness_key
                )
            ):
                return SearchRepairAdmission(
                    media_id=source_media_id, revision=state.revision, job_id=job.id
                )
        revision = _request(db, source_media_id, "section_preparation", client)
        return SearchRepairAdmission(media_id=source_media_id, revision=revision, job_id=request.id)

    return retry_serializable(db, "prepare_media_parts", admit)


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


# The job: fence and snapshot, prove missing section witnesses and commit them, embed
# through a spool outside any transaction, fence and publish.


@dataclass(frozen=True)
class _EpubPackage:
    """The stored package and retained fragments a witness derivation reads."""

    storage_path: str
    size_bytes: int
    source_sha256: str
    fragments: list[RetainedEpubFragment]
    note_regions: list[NoteRegion]


@dataclass(frozen=True)
class _Work:
    source_kind: str
    blocks: list[IndexableBlock]
    sections: _Sections | None
    package: _EpubPackage | None
    lexical_ready: bool


def _capture_epub_package(db: Session, media_id: UUID) -> _EpubPackage:
    storage_path, size_bytes, source_sha256 = db.execute(
        text("SELECT storage_path, size_bytes, source_sha256 FROM media_file WHERE media_id = :id"),
        {"id": media_id},
    ).one()
    fragments = [
        RetainedEpubFragment(
            row.id, row.idx, row.package_href, row.html_sanitized, row.canonical_text
        )
        for row in db.execute(
            text(
                "SELECT f.id, f.idx, s.package_href, f.html_sanitized, f.canonical_text"
                " FROM fragments f JOIN epub_fragment_sources s"
                " ON s.fragment_id = f.id AND s.media_id = f.media_id"
                " WHERE f.media_id = :id ORDER BY f.idx"
            ),
            {"id": media_id},
        )
    ]
    return _EpubPackage(
        storage_path, size_bytes, source_sha256, fragments, read_note_regions(db, media_id)
    )


def _derive_epub_navigation(
    directory: Path, media_id: UUID, package: _EpubPackage
) -> EpubNavigationPlan:
    """rebuild the projection outside a transaction from the verified retained package."""
    path = directory / "source.epub"
    stream_storage_object_to_file(
        get_storage_client(),
        storage_path=package.storage_path,
        destination=path,
        expected_size_bytes=package.size_bytes,
        expected_source_sha256=package.source_sha256,
    )
    return derive_epub_navigation(
        epub_path=path,
        media_id=media_id,
        fragments=package.fragments,
        note_regions=package.note_regions,
    )


def _record_prepared_sections(db: Session, media_id: UUID, sections: _Sections) -> None:
    """publish the exact current catalogue's witness before embedding work."""
    db.execute(
        text(
            "UPDATE content_index_states SET section_witness_key = :key, updated_at = now()"
            " WHERE owner_kind = 'media' AND owner_id = :id RETURNING id"
        ),
        {"key": sections.witness_key, "id": media_id},
    ).one()


def run_media_reindex_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    media_id, revision = UUID(payload["media_id"]), int(payload["revision"])
    reason = payload["reason"]
    frozen = (payload["section_witness_key"], payload["section_bounds_key"])
    result: dict[str, object] = {
        "status": "superseded",
        "media_id": str(media_id),
        "revision": revision,
    }

    def record(db: Session, facts: Callable[..., IndexFacts]) -> None:
        _event(db, media_id, facts(revision=revision))

    def fence(db: Session) -> Row[Any] | None:
        """The locked state while the claim holds and ``revision`` is current; a newer one
        is recorded."""
        state = _lock(db, media_id)
        job = None if state is None else queue.lock_running_job_claim(db, context=context)
        if state is None or job is None:
            return None
        if state.revision != revision:
            record(db, IndexSuperseded)
            return None
        return state

    def keys(sections: _Sections | None) -> tuple[str | None, str | None]:
        return (None, None) if sections is None else (sections.witness_key, sections.bounds_key)

    def check_sections(db: Session) -> None:
        """A revision fixes generation, geometry and partition once captured: any drift is
        a writer that skipped ``reconcile_media_section_bounds``."""
        if keys(_read_sections(db, media_id)) != frozen:
            raise AssertionError("section structure changed without a new index revision")

    owner = IndexOwner("media", media_id)

    def prepare(db: Session) -> _Work | ContentIndexResult | None:
        state = fence(db)
        if state is None:
            return None
        kind, status, plain_text = db.execute(
            text("SELECT kind, processing_status, plain_text FROM media WHERE id = :id"),
            {"id": media_id},
        ).one()
        if status != "ready_for_reading":
            # A refresh owns the source now; its success requests the next revision.
            record(db, IndexSuperseded)
            return None
        sections = _read_sections(db, media_id)
        if keys(sections) != frozen:
            # Only a changed detector or chunker contract moves a target under one
            # revision: a fresh revision freezes the current target.
            record(db, IndexSuperseded)
            _request(db, media_id, reason, None)
            return None
        if state.section_bounds_key == frozen[1]:
            completed = completed_content_index(db, owner, state)
            if completed is not None:
                return completed
        record(db, IndexExecutionStarted)
        _set_state(db, owner, "indexing", reason)
        package = None
        if sections is not None and state.section_witness_key != sections.witness_key:
            if kind == "epub":
                package = _capture_epub_package(db, media_id)
            else:
                _record_prepared_sections(db, media_id, sections)
        lexical_ready = state.lexical_revision == revision and state.section_bounds_key == frozen[1]
        blocks = (
            []
            if lexical_ready
            else _media_blocks(
                db, media_id, kind, plain_text or "", [] if sections is None else sections.points
            )
        )
        record_input_change(db, owners=(f"media:{media_id}",))
        source_kind = "transcript" if kind in _TRANSCRIPT_KINDS else kind
        return _Work(source_kind, blocks, sections, package, lexical_ready)

    work = index_phase("prepare_media_content_reindex", prepare)
    if work is None:
        return result
    if isinstance(work, ContentIndexResult):
        return result | {"status": work.status, "chunk_count": work.chunk_count}
    with parser_attempt_directory(context.job_id) as directory:
        if work.package is not None:
            assert work.sections is not None
            package = work.package
            navigation = _derive_epub_navigation(directory, media_id, package)

            def attach(db: Session) -> bool:
                # Family writers serialize before the index/job fence; key-share
                # remains available to queue history's media foreign key.
                if not library_entries.lock_media_rows_in_order(
                    db, [media_id], lock_mode="no_key_update"
                ):
                    return False
                if fence(db) is None:
                    return False
                check_sections(db)
                replace_epub_navigation_projection(db, media_id=media_id, plan=navigation)
                current = _read_sections(db, media_id)
                assert current is not None
                _record_prepared_sections(db, media_id, current)
                changed = keys(current) != frozen
                if changed:
                    # This revision captured the old catalogue and old blocks. Normal
                    # admission freezes a new partition; no old blocks are embedded.
                    record(db, IndexSuperseded)
                    _request(db, media_id, reason, None)
                record_input_change(db, owners=(f"media:{media_id}",))
                db.execute(text("SELECT pg_notify('media_events', :id)"), {"id": str(media_id)})
                return not changed

            if not index_phase("attach_media_section_witnesses", attach):
                return result
        text_spool = directory / "text.jsonl"
        chunks_spool = directory / "published-chunks.jsonl"
        embedding_spool = directory / "embeddings.jsonl"
        try:
            if not work.lexical_ready:
                spool_chunks(work.blocks, text_spool)

                def publish_text(db: Session) -> ContentIndexResult | None:
                    state = fence(db)
                    if state is None:
                        return None
                    check_sections(db)
                    if state.lexical_revision == revision and state.section_bounds_key == frozen[1]:
                        count = db.scalar(
                            text(
                                "SELECT count(*) FROM content_chunks"
                                " WHERE owner_kind='media' AND owner_id=:id"
                            ),
                            {"id": media_id},
                        )
                        return ContentIndexResult(owner, "indexing", count)
                    published = publish_text_index(
                        db,
                        owner=owner,
                        source_kind=work.source_kind,
                        blocks=work.blocks,
                        chunks=read_spool(text_spool),
                        reason=reason,
                    )
                    db.execute(
                        text(
                            "UPDATE content_index_states SET section_bounds_key = :key"
                            " WHERE owner_kind = 'media' AND owner_id = :id RETURNING id"
                        ),
                        {"key": frozen[1], "id": media_id},
                    ).one()
                    if published.status != "indexing":
                        record(db, IndexSucceeded)
                    record_input_change(db, owners=(f"media:{media_id}",))
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
                state = fence(db)
                if state is None:
                    return False
                check_sections(db)
                if state.lexical_revision != revision or state.section_bounds_key != frozen[1]:
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
            state = fence(db)
            if state is None:
                return None
            check_sections(db)
            if state.lexical_revision != revision or state.section_bounds_key != frozen[1]:
                return None
            published = publish_embeddings(
                db,
                owner=owner,
                embeddings=read_embeddings(embedding_spool),
                reason=reason,
            )
            record(db, IndexSucceeded)
            return published

        published = index_phase("publish_media_embeddings", publish)
    if published is None:
        return result
    return result | {"status": published.status, "chunk_count": published.chunk_count}


def index_phase[T](label: str, operation: Callable[[Session], T]) -> T:
    """One serializable transaction on a fresh session, retried on conflict."""
    with get_session_factory()() as db:
        return retry_serializable(db, label, lambda: operation(db))


# Recovery of a dead reindex execution.


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
    Never touches the source or the materialization: a ``ready`` index keeps serving
    search until the rerun marks it ``indexing``.
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
        return SearchRepairAdmission(media_id=media_id, revision=state.revision, job_id=job.id)

    return retry_serializable(db, "repair_dead_media_reindex", admit)
