"""Shared evidence indexing for text-bearing media."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
from array import array
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import chain, islice
from pathlib import Path
from typing import Any, BinaryIO, Literal, TypeGuard
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.retries import admit_serializable
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import JobExecutionContext, current_dead_job_for_payload, requeue_dead_job
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
from nexus.services.capabilities import (
    OperatorRecovery,
    RecoveryActor,
    SearchRecoveryAnswer,
    ViewerRecovery,
)
from nexus.services.import_history import append_processing_event
from nexus.services.parser_temp import utf8_byte_length
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.semantic_chunks import (
    build_text_embeddings,
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)
from nexus.services.transcript_segments import TranscriptSegmentInput
from nexus.services.web_article_structure import (
    add_heading_anchors,
    build_web_article_index_blocks,
)

CHUNK_MAX_TOKENS = 420
CHUNK_OVERLAP_TOKENS = 60
CONTENT_INDEX_EMBEDDING_BATCH_SIZE = 64
CONTENT_INDEX_CHUNK_MAX_BYTES = 256 * 1024
CONTENT_INDEX_SPOOL_MAX_BYTES = 384 * 1024 * 1024
_CONTENT_INDEX_SPOOL_RECORD_MAX_BYTES = CONTENT_INDEX_CHUNK_MAX_BYTES * 16 + 1024 * 1024
_CONTENT_INDEX_SPOOL_VERSION = 1
MEDIA_CONTENT_REINDEX_JOB_KIND = "media_content_reindex_job"
MEDIA_CONTENT_REINDEX_REASONS = frozenset(
    {
        "source_success",
        "reconciliation",
        "operator_repair",
        "oracle_corpus_seed",
    }
)
DocumentSourceKind = Literal["web_article", "epub", "pdf"]


@dataclass(frozen=True)
class IndexOwner:
    """Polymorphic owner of a content index. Forward-compatible with ResourceRef."""

    kind: Literal["media", "note_block"]
    id: UUID


@dataclass(frozen=True)
class IndexableBlock:
    owner: IndexOwner
    source_kind: str
    block_idx: int
    block_kind: str
    canonical_text: str
    extraction_confidence: float | None
    source_start_offset: int
    source_end_offset: int
    locator: dict[str, object]
    selector: dict[str, object]
    heading_path: tuple[str, ...]
    metadata: dict[str, object]


@dataclass(frozen=True)
class ContentIndexResult:
    owner: IndexOwner
    status: str
    chunk_count: int


@dataclass(frozen=True)
class MediaContentReindexIntent:
    revision: int
    background_job_id: UUID
    suspended: bool
    enqueued: bool


@dataclass(frozen=True)
class MediaContentReindexWork:
    media_id: UUID
    revision: int
    source_kind: DocumentSourceKind
    reason: str
    blocks: tuple[IndexableBlock, ...]


@dataclass(frozen=True)
class PlannedContentChunk:
    parts: tuple[tuple[IndexableBlock, int, int, int], ...]
    text: str
    locator: dict[str, object]
    embedding_f32: bytes


class ContentIndexResourceLimitExceeded(Exception):
    """Expected rejection when a document cannot fit the indexing envelope."""

    error_code = ApiErrorCode.E_SOURCE_TOO_LARGE

    def __init__(self) -> None:
        super().__init__("Document content exceeds the bounded indexing envelope.")


# justify-defect: the spool is private same-system scratch written and read by
# one worker attempt; any shape, identity, or digest drift is internal corruption.
class ContentIndexSpoolCorruption(AssertionError):
    """A same-system document plan did not match its closed spool contract."""


@dataclass(frozen=True)
class ContentIndexPlan:
    owner: IndexOwner
    source_kind: str
    blocks: tuple[IndexableBlock, ...]
    chunks: tuple[PlannedContentChunk, ...]
    embedding_provider: str
    embedding_model: str
    embedding_dimensions: int


@dataclass(frozen=True)
class SpooledContentIndexPlan:
    owner: IndexOwner
    source_kind: DocumentSourceKind
    blocks: tuple[IndexableBlock, ...]
    spool_path: Path
    chunk_count: int
    embedding_provider: str
    embedding_model: str
    embedding_dimensions: int


TextEmbeddingBatch = Callable[
    [list[str]],
    tuple[str, Sequence[Sequence[float]]],
]


def plan_content_index(
    *,
    owner: IndexOwner,
    source_kind: str,
    blocks: list[IndexableBlock],
) -> ContentIndexPlan:
    """Build and embed one complete materialization with no database access."""
    _validate_blocks(owner=owner, source_kind=source_kind, blocks=blocks)

    embedding_model = current_transcript_embedding_model()
    embedding_dimensions = transcript_embedding_dimensions()
    embedding_provider = current_transcript_embedding_provider()

    planned_chunks: list[PlannedContentChunk] = []
    chunk_batch: list[list[tuple[IndexableBlock, int, int, int]]] = []
    for chunk_parts in _iter_content_chunk_parts(blocks):
        chunk_batch.append(chunk_parts)
        if len(chunk_batch) == CONTENT_INDEX_EMBEDDING_BATCH_SIZE:
            planned_chunks.extend(
                _plan_content_chunk_batch(
                    source_kind=source_kind,
                    chunk_parts_batch=chunk_batch,
                    embedding_model=embedding_model,
                    embedding_dimensions=embedding_dimensions,
                    maximum_chunk_bytes=None,
                    embed_texts=build_text_embeddings,
                )
            )
            chunk_batch = []
    if chunk_batch:
        planned_chunks.extend(
            _plan_content_chunk_batch(
                source_kind=source_kind,
                chunk_parts_batch=chunk_batch,
                embedding_model=embedding_model,
                embedding_dimensions=embedding_dimensions,
                maximum_chunk_bytes=None,
                embed_texts=build_text_embeddings,
            )
        )

    return ContentIndexPlan(
        owner=owner,
        source_kind=source_kind,
        blocks=tuple(blocks),
        chunks=tuple(planned_chunks),
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def build_spooled_content_index_plan(
    *,
    owner: IndexOwner,
    source_kind: DocumentSourceKind,
    blocks: Sequence[IndexableBlock],
    spool_path: Path,
    embed_texts: TextEmbeddingBatch,
) -> SpooledContentIndexPlan:
    """Build a bounded document plan outside the publication transaction."""
    if owner.kind != "media" or source_kind not in {"web_article", "epub", "pdf"}:
        raise ValueError("spooled content-index planning is document-media only")
    block_list = list(blocks)
    _validate_blocks(owner=owner, source_kind=source_kind, blocks=block_list)
    embedding_model = current_transcript_embedding_model()
    embedding_dimensions = transcript_embedding_dimensions()
    embedding_provider = current_transcript_embedding_provider()
    header = {
        "block_count": len(block_list),
        "embedding_dimensions": embedding_dimensions,
        "embedding_model": embedding_model,
        "embedding_provider": embedding_provider,
        "kind": "Header",
        "owner_id": str(owner.id),
        "owner_kind": owner.kind,
        "source_kind": source_kind,
        "version": _CONTENT_INDEX_SPOOL_VERSION,
    }
    digest = hashlib.sha256()
    written_bytes = 0
    chunk_count = 0
    try:
        with spool_path.open("xb") as spool:
            written_bytes = _write_spool_record(
                spool,
                header,
                written_bytes=written_bytes,
                digest=digest,
            )
            chunk_batch: list[list[tuple[IndexableBlock, int, int, int]]] = []
            for chunk_parts in _iter_content_chunk_parts(block_list):
                chunk_batch.append(chunk_parts)
                if len(chunk_batch) == CONTENT_INDEX_EMBEDDING_BATCH_SIZE:
                    planned = _plan_content_chunk_batch(
                        source_kind=source_kind,
                        chunk_parts_batch=chunk_batch,
                        embedding_model=embedding_model,
                        embedding_dimensions=embedding_dimensions,
                        maximum_chunk_bytes=CONTENT_INDEX_CHUNK_MAX_BYTES,
                        embed_texts=embed_texts,
                    )
                    for chunk in planned:
                        written_bytes = _write_spool_record(
                            spool,
                            _spool_chunk_record(chunk_count, chunk),
                            written_bytes=written_bytes,
                            digest=digest,
                        )
                        chunk_count += 1
                    del planned
                    chunk_batch = []
            if chunk_batch:
                for chunk in _plan_content_chunk_batch(
                    source_kind=source_kind,
                    chunk_parts_batch=chunk_batch,
                    embedding_model=embedding_model,
                    embedding_dimensions=embedding_dimensions,
                    maximum_chunk_bytes=CONTENT_INDEX_CHUNK_MAX_BYTES,
                    embed_texts=embed_texts,
                ):
                    written_bytes = _write_spool_record(
                        spool,
                        _spool_chunk_record(chunk_count, chunk),
                        written_bytes=written_bytes,
                        digest=digest,
                    )
                    chunk_count += 1
            _write_spool_record(
                spool,
                {
                    "chunk_count": chunk_count,
                    "kind": "Complete",
                    "sha256": digest.hexdigest(),
                },
                written_bytes=written_bytes,
                digest=None,
            )
    except Exception:
        spool_path.unlink(missing_ok=True)
        raise
    return SpooledContentIndexPlan(
        owner=owner,
        source_kind=source_kind,
        blocks=tuple(block_list),
        spool_path=spool_path,
        chunk_count=chunk_count,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def publish_content_index(
    db: Session,
    *,
    plan: ContentIndexPlan | SpooledContentIndexPlan,
    reason: str,
) -> ContentIndexResult:
    """Replace one complete materialization inside the caller's transaction."""
    now = datetime.now(UTC)
    replace_content_index_materialization(db, owner=plan.owner)
    _set_index_state(
        db,
        owner=plan.owner,
        status="indexing",
        status_reason=reason,
        embedding_provider=None,
        embedding_model=None,
        now=now,
    )

    block_ids_by_idx: dict[int, UUID] = {}
    for expected_idx, block in enumerate(plan.blocks):
        block_id = db.execute(
            text(
                """
                INSERT INTO content_blocks (
                    owner_kind,
                    owner_id,
                    block_idx,
                    block_kind,
                    canonical_text,
                    extraction_confidence,
                    source_start_offset,
                    source_end_offset,
                    parent_block_id,
                    heading_path,
                    locator,
                    selector,
                    metadata,
                    created_at
                )
                VALUES (
                    :owner_kind,
                    :owner_id,
                    :block_idx,
                    :block_kind,
                    :canonical_text,
                    :extraction_confidence,
                    :source_start_offset,
                    :source_end_offset,
                    NULL,
                    CAST(:heading_path AS jsonb),
                    CAST(:locator AS jsonb),
                    CAST(:selector AS jsonb),
                    CAST(:metadata AS jsonb),
                    :now
                )
                RETURNING id
                """
            ),
            {
                "owner_kind": plan.owner.kind,
                "owner_id": plan.owner.id,
                "block_idx": block.block_idx,
                "block_kind": block.block_kind,
                "canonical_text": block.canonical_text,
                "extraction_confidence": block.extraction_confidence,
                "source_start_offset": block.source_start_offset,
                "source_end_offset": block.source_end_offset,
                "heading_path": json.dumps(list(block.heading_path)),
                "locator": json.dumps(block.locator),
                "selector": json.dumps(block.selector),
                "metadata": json.dumps(block.metadata),
                "now": now,
            },
        ).scalar_one()
        block_ids_by_idx[expected_idx] = block_id

    planned_chunks = iter(_content_index_plan_chunks(plan))
    try:
        first_chunk = next(planned_chunks)
    except StopIteration:
        first_chunk = None

    if first_chunk is None:
        _set_index_state(
            db,
            owner=plan.owner,
            status="no_text",
            status_reason="no_text",
            embedding_provider=None,
            embedding_model=None,
            now=now,
        )
        return ContentIndexResult(owner=plan.owner, status="no_text", chunk_count=0)

    published_chunk_count = 0
    for chunk_idx, chunk in enumerate(chain((first_chunk,), planned_chunks)):
        if chunk is None:
            # justify-defect: the empty-plan branch returned above.
            raise AssertionError("content-index chunk iterator yielded an absent first chunk")
        published_chunk_count += 1
        chunk_parts = chunk.parts
        chunk_text = chunk.text
        summary_locator = chunk.locator
        first_block, first_start, _, _ = chunk_parts[0]
        last_block, _, last_end, _ = chunk_parts[-1]
        first_block_id = block_ids_by_idx[first_block.block_idx]
        last_block_id = block_ids_by_idx[last_block.block_idx]
        citation_label = str(first_block.heading_path[-1]) if first_block.heading_path else "Source"
        evidence_span_id = db.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    owner_kind,
                    owner_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    selector,
                    citation_label,
                    resolver_kind,
                    created_at
                )
                VALUES (
                    :owner_kind,
                    :owner_id,
                    :start_block_id,
                    :end_block_id,
                    :start_block_offset,
                    :end_offset,
                    :span_text,
                    CAST(:selector AS jsonb),
                    :citation_label,
                    :resolver_kind,
                    :now
                )
                RETURNING id
                """
            ),
            {
                "owner_kind": plan.owner.kind,
                "owner_id": plan.owner.id,
                "start_block_id": first_block_id,
                "end_block_id": last_block_id,
                "start_block_offset": first_start,
                "end_offset": last_end,
                "span_text": chunk_text,
                "selector": json.dumps(summary_locator),
                "citation_label": citation_label,
                "resolver_kind": _resolver_kind(plan.source_kind),
                "now": now,
            },
        ).scalar_one()

        chunk_id = db.execute(
            text(
                """
                INSERT INTO content_chunks (
                    owner_kind,
                    owner_id,
                    primary_evidence_span_id,
                    chunk_idx,
                    source_kind,
                    chunk_text,
                    token_count,
                    heading_path,
                    summary_locator,
                    created_at
                )
                VALUES (
                    :owner_kind,
                    :owner_id,
                    :evidence_span_id,
                    :chunk_idx,
                    :source_kind,
                    :chunk_text,
                    :token_count,
                    CAST(:heading_path AS jsonb),
                    CAST(:summary_locator AS jsonb),
                    :now
                )
                RETURNING id
                """
            ),
            {
                "owner_kind": plan.owner.kind,
                "owner_id": plan.owner.id,
                "evidence_span_id": evidence_span_id,
                "chunk_idx": chunk_idx,
                "source_kind": plan.source_kind,
                "chunk_text": chunk_text,
                "token_count": sum(int(part[3]) for part in chunk_parts),
                "heading_path": json.dumps(list(first_block.heading_path)),
                "summary_locator": json.dumps(summary_locator),
                "now": now,
            },
        ).scalar_one()

        chunk_offset = 0
        previous_block: IndexableBlock | None = None
        for part_idx, (block, start_offset, end_offset, _) in enumerate(chunk_parts):
            block_id = block_ids_by_idx[block.block_idx]
            separator_before = _separator_before(previous_block, block)
            chunk_start_offset = chunk_offset + len(separator_before)
            chunk_end_offset = chunk_start_offset + end_offset - start_offset
            db.execute(
                text(
                    """
                    INSERT INTO content_chunk_parts (
                        chunk_id,
                        part_idx,
                        block_id,
                        block_start_offset,
                        block_end_offset,
                        chunk_start_offset,
                        chunk_end_offset,
                        separator_before,
                        created_at
                    )
                    VALUES (
                        :chunk_id,
                        :part_idx,
                        :block_id,
                        :block_start_offset,
                        :block_end_offset,
                        :chunk_start_offset,
                        :chunk_end_offset,
                        :separator_before,
                        :now
                    )
                    """
                ),
                {
                    "chunk_id": chunk_id,
                    "part_idx": part_idx,
                    "block_id": block_id,
                    "block_start_offset": start_offset,
                    "block_end_offset": end_offset,
                    "chunk_start_offset": chunk_start_offset,
                    "chunk_end_offset": chunk_end_offset,
                    "separator_before": separator_before,
                    "now": now,
                },
            )
            chunk_offset = chunk_end_offset
            previous_block = block
        if chunk_offset != len(chunk_text):
            raise ValueError("Chunk part offsets do not reconstruct chunk text")

        db.execute(
            text(
                f"""
                INSERT INTO content_embeddings (
                    chunk_id,
                    embedding_provider,
                    embedding_model,
                    embedding_dimensions,
                    embedding_vector,
                    created_at
                )
                VALUES (
                    :chunk_id,
                    :embedding_provider,
                    :embedding_model,
                    :embedding_dimensions,
                    CAST(:embedding_vector AS vector({plan.embedding_dimensions})),
                    :now
                )
                """
            ),
            {
                "chunk_id": chunk_id,
                "embedding_provider": plan.embedding_provider,
                "embedding_model": plan.embedding_model,
                "embedding_dimensions": plan.embedding_dimensions,
                "embedding_vector": _packed_embedding_literal(
                    chunk.embedding_f32,
                    dimensions=plan.embedding_dimensions,
                ),
                "now": now,
            },
        )

    expected_chunk_count = (
        len(plan.chunks) if isinstance(plan, ContentIndexPlan) else plan.chunk_count
    )
    if published_chunk_count != expected_chunk_count:
        # justify-defect: the closed plan count must match its streamed records.
        raise AssertionError("content-index plan chunk count changed during publication")

    _set_index_state(
        db,
        owner=plan.owner,
        status="ready",
        status_reason=reason,
        embedding_provider=plan.embedding_provider,
        embedding_model=plan.embedding_model,
        now=now,
    )
    # Single owner of the per-media unit trigger: every text-bearing media source
    # kind funnels through this ready branch, so the unit (re)build is enqueued
    # here once rather than at each ingest call site. Participates in the caller's
    # transaction so the enqueue commits atomically with the content-index write.
    # Page indexes carry no media unit, so this is gated to media owners only.
    if plan.owner.kind == "media":
        media_intelligence_lifecycle.ensure_media_unit_in_tx(db, media_id=plan.owner.id)
    return ContentIndexResult(
        owner=plan.owner,
        status="ready",
        chunk_count=published_chunk_count,
    )


def rebuild_content_index(
    db: Session,
    *,
    owner: IndexOwner,
    source_kind: str,
    blocks: list[IndexableBlock],
    reason: str,
) -> ContentIndexResult:
    """Synchronous note doorway; durable media jobs plan and publish separately."""
    if owner.kind == "media":
        db.execute(
            text("SELECT id FROM media WHERE id = :owner_id FOR NO KEY UPDATE"),
            {"owner_id": owner.id},
        ).scalar_one()
    return publish_content_index(
        db,
        plan=plan_content_index(owner=owner, source_kind=source_kind, blocks=blocks),
        reason=reason,
    )


def build_fragment_indexable_blocks(
    *,
    media_id: UUID,
    source_kind: str,
    fragments: Sequence[Any],
    media_title: str | None,
    nav_by_fragment_idx: dict[int, dict[str, object]],
    fragment_blocks_by_id: dict[UUID, list[Any]],
) -> list[IndexableBlock]:
    """Build fragment blocks from an immutable source snapshot."""
    if not _is_document_source_kind(source_kind):
        # justify-defect: fragment document indexing has a closed source-kind contract.
        raise AssertionError("fragment content-index source kind is ineligible")
    blocks: list[IndexableBlock] = []
    source_offset = 0
    for fragment in sorted(
        fragments,
        key=lambda item: int(str(_field(item, "idx", -1))),
    ):
        fragment_id = UUID(str(_field(fragment, "id", "")))
        fragment_idx = int(str(_field(fragment, "idx", -1)))
        fragment_text = str(_field(fragment, "canonical_text", "") or "")
        source_base = source_offset
        if source_kind == "web_article":
            html_sanitized = str(_field(fragment, "html_sanitized", "") or "")
            if (
                add_heading_anchors(
                    html_sanitized,
                    fragment_idx=fragment_idx,
                )
                != html_sanitized
            ):
                # justify-defect: source success owns deterministic heading
                # normalization before it requests an index revision.
                raise AssertionError("web source fragment is missing Nexus heading anchors")
            for spec in build_web_article_index_blocks(
                html_sanitized=html_sanitized,
                canonical_text=fragment_text,
                fragment_idx=fragment_idx,
                media_title=media_title,
            ):
                block_text = fragment_text[spec.start_offset : spec.end_offset]
                locator: dict[str, object] = {
                    "type": "web_text_offsets",
                    "kind": "web_text",
                    "fragment_id": str(fragment_id),
                    "fragment_idx": fragment_idx,
                    "start_offset": spec.start_offset,
                    "end_offset": spec.end_offset,
                    "text_quote": _text_quote(
                        fragment_text,
                        spec.start_offset,
                        spec.end_offset,
                    ),
                }
                metadata: dict[str, object] = {}
                if spec.section_id is not None:
                    locator["section_id"] = spec.section_id
                    metadata["section_id"] = spec.section_id
                if spec.anchor_id is not None:
                    locator["anchor_id"] = spec.anchor_id
                    metadata["anchor_id"] = spec.anchor_id
                if spec.heading_level is not None:
                    locator["heading_level"] = spec.heading_level
                    metadata["heading_level"] = spec.heading_level
                if spec.depth is not None:
                    metadata["depth"] = spec.depth
                if spec.ordinal is not None:
                    metadata["ordinal"] = spec.ordinal
                blocks.append(
                    IndexableBlock(
                        owner=IndexOwner("media", media_id),
                        source_kind=source_kind,
                        block_idx=len(blocks),
                        block_kind=spec.block_kind,
                        canonical_text=block_text,
                        extraction_confidence=None,
                        source_start_offset=source_base + spec.start_offset,
                        source_end_offset=source_base + spec.end_offset,
                        locator=locator,
                        selector=locator,
                        heading_path=spec.heading_path,
                        metadata=metadata,
                    )
                )
            source_offset += len(fragment_text) + 2
            continue

        block_rows = fragment_blocks_by_id.get(fragment_id, [])
        if not block_rows:
            block_rows = [(0, 0, len(fragment_text))]
        for row in block_rows:
            start_offset = int(row[-2])
            end_offset = int(row[-1])
            block_text = fragment_text[start_offset:end_offset]
            nav = nav_by_fragment_idx.get(fragment_idx, {})
            locator_kind = "epub_text" if source_kind == "epub" else "web_text"
            locator: dict[str, object] = {
                "kind": locator_kind,
                "fragment_id": str(fragment_id),
                "fragment_idx": fragment_idx,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": _text_quote(fragment_text, start_offset, end_offset),
            }
            if nav:
                locator.update(nav)
            heading_path = (str(nav.get("label")),) if nav.get("label") else ()
            blocks.append(
                IndexableBlock(
                    owner=IndexOwner("media", media_id),
                    source_kind=source_kind,
                    block_idx=len(blocks),
                    block_kind="paragraph",
                    canonical_text=block_text,
                    extraction_confidence=None,
                    source_start_offset=source_base + start_offset,
                    source_end_offset=source_base + end_offset,
                    locator=locator,
                    selector=locator,
                    heading_path=heading_path,
                    metadata={},
                )
            )
        source_offset += len(fragment_text) + 2

    return blocks


def build_transcript_indexable_blocks(
    *,
    media_id: UUID,
    transcript_segments: Sequence[TranscriptSegmentInput],
) -> list[IndexableBlock]:
    """Build an immutable transcript plan input without provider or DB work."""
    blocks: list[IndexableBlock] = []
    source_offset = 0
    for segment in transcript_segments:
        text_value = segment.canonical_text.strip()
        t_start_ms = segment.t_start_ms
        t_end_ms = segment.t_end_ms
        if not text_value:
            continue
        if t_end_ms <= t_start_ms:
            continue
        if blocks:
            source_offset += 2
        locator = {
            "kind": "transcript_time_text",
            "t_start_ms": t_start_ms,
            "t_end_ms": t_end_ms,
            "text_quote": {
                "exact": text_value,
                "prefix": "",
                "suffix": "",
            },
        }
        blocks.append(
            IndexableBlock(
                owner=IndexOwner("media", media_id),
                source_kind="transcript",
                block_idx=len(blocks),
                block_kind="transcript_segment",
                canonical_text=text_value,
                extraction_confidence=None,
                source_start_offset=source_offset,
                source_end_offset=source_offset + len(text_value),
                locator=locator,
                selector=locator,
                heading_path=(),
                metadata={"speaker_label": segment.speaker_label},
            )
        )
        source_offset += len(text_value)

    return blocks


def build_pdf_indexable_blocks(
    *,
    media_id: UUID,
    plain_text: str,
    page_spans: Sequence[Any],
    extraction_method: str | None = None,
    ocr_confidence: float | None = None,
) -> list[IndexableBlock]:
    """Build the single current PDF evidence JSON shape."""

    blocks: list[IndexableBlock] = []
    for page_span in page_spans:
        page_number = _pdf_span_required_int(page_span, "page_number")
        start = _pdf_span_required_int(page_span, "start_offset")
        end = _pdf_span_required_int(page_span, "end_offset")
        if page_number < 1:
            raise ValueError("PDF page span page_number must be positive")
        if start < 0 or end < start:
            raise ValueError("PDF page span offsets are invalid")
        page_text = plain_text[start:end]
        page_label_value = _field(page_span, "page_label", None)
        page_label = str(page_label_value) if page_label_value else None
        locator = {
            "kind": "pdf_text",
            "page_number": page_number,
            "physical_page_number": page_number,
            "page_label": page_label,
            "plain_text_start_offset": start,
            "plain_text_end_offset": end,
            "page_text_start_offset": 0,
            "page_text_end_offset": len(page_text),
            "text_quote": _text_quote(plain_text, start, end),
        }
        page_width = _pdf_span_positive_number_or_none(page_span, "page_width")
        page_height = _pdf_span_positive_number_or_none(page_span, "page_height")
        if page_width is not None and page_height is not None:
            locator["geometry"] = {
                "coordinate_space": "pdf_points",
                "page_width": page_width,
                "page_height": page_height,
                "page_rotation_degrees": _pdf_span_optional_non_negative_int(
                    page_span,
                    "page_rotation_degrees",
                    default=0,
                ),
                "page_box": "crop",
                "quads": [],
            }
        selector = {
            "kind": "pdf_text_quote",
            "page_number": page_number,
            "physical_page_number": page_number,
            "page_label": page_label,
            "plain_text_start_offset": start,
            "plain_text_end_offset": end,
            "page_text_start_offset": 0,
            "page_text_end_offset": len(page_text),
            "text_quote": _text_quote(plain_text, start, end),
        }
        metadata: dict[str, object] = {
            "page_number": page_number,
            "page_label": page_label,
        }
        if extraction_method is not None:
            metadata["extraction_method"] = extraction_method
        blocks.append(
            IndexableBlock(
                owner=IndexOwner("media", media_id),
                source_kind="pdf",
                block_idx=len(blocks),
                block_kind="pdf_text_block",
                canonical_text=page_text,
                extraction_confidence=ocr_confidence,
                source_start_offset=start,
                source_end_offset=end,
                locator=locator,
                selector=selector,
                heading_path=(f"p. {page_label or page_number}",),
                metadata=metadata,
            )
        )
    return blocks


def prepare_media_content_reindex(
    db: Session,
    *,
    media_id: UUID,
    revision: int,
    reason: str,
    context: JobExecutionContext,
    lease_seconds: int,
) -> MediaContentReindexWork | None:
    """Fence, snapshot, and mark one current document revision indexing."""
    _validate_media_reindex_reason(reason)
    media = (
        db.execute(
            text(
                """
                SELECT id, kind, processing_status, title, language, plain_text
                FROM media
                WHERE id = :media_id
                FOR NO KEY UPDATE
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        return None
    source_kind = media["kind"]
    if not _is_document_source_kind(source_kind):
        # justify-defect: the durable payload accepts only document media.
        raise AssertionError("media content-reindex owner kind is ineligible")

    state = _lock_media_index_state(db, media_id)
    if state is None:
        return None

    from nexus.jobs.queue import lock_and_renew_running_job_claim

    job = lock_and_renew_running_job_claim(
        db,
        context=context,
        lease_seconds=lease_seconds,
    )
    if job is None:
        return None
    if (
        job.kind != MEDIA_CONTENT_REINDEX_JOB_KIND
        or str(job.payload.get("media_id")) != str(media_id)
        or _job_revision(job.payload) != revision
    ):
        # justify-defect: the worker context must name this exact closed payload.
        raise AssertionError("media content-reindex job identity is malformed")
    if _validated_media_revision(state["revision"]) != revision:
        _record_index_event(
            db,
            media_id=media_id,
            facts=IndexSuperseded(
                revision=revision, job_id=job.id, execution_id=context.execution_id
            ),
        )
        return None
    if media["processing_status"] != "ready_for_reading":
        # justify-defect: only source success may request a document index revision.
        raise AssertionError("media content-reindex owner is not readable")
    _record_index_event(
        db,
        media_id=media_id,
        facts=IndexExecutionStarted(
            revision=revision, job_id=job.id, execution_id=context.execution_id
        ),
    )

    blocks = _snapshot_media_indexable_blocks(
        db,
        media_id=media_id,
        source_kind=source_kind,
        media_title=str(media["title"] or ""),
        plain_text=str(media["plain_text"] or ""),
    )
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET
                status = 'indexing',
                status_reason = :reason,
                active_embedding_provider = NULL,
                active_embedding_model = NULL,
                updated_at = now()
            WHERE owner_kind = 'media'
              AND owner_id = :media_id
              AND revision = :revision
            """
        ),
        {"media_id": media_id, "revision": revision, "reason": reason},
    )
    return MediaContentReindexWork(
        media_id=media_id,
        revision=revision,
        source_kind=source_kind,
        reason=reason,
        blocks=tuple(blocks),
    )


def publish_media_content_reindex(
    db: Session,
    *,
    work: MediaContentReindexWork,
    plan: ContentIndexPlan | SpooledContentIndexPlan,
    context: JobExecutionContext,
    lease_seconds: int,
) -> ContentIndexResult | None:
    """Fence and atomically publish one complete current document revision."""
    media = (
        db.execute(
            text("SELECT id, kind FROM media WHERE id = :media_id FOR NO KEY UPDATE"),
            {"media_id": work.media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        return None
    if str(media["kind"]) != work.source_kind:
        # justify-defect: a media row cannot change document kind.
        raise AssertionError("media kind changed during content reindex")
    state = _lock_media_index_state(db, work.media_id)
    if state is None:
        return None

    from nexus.jobs.queue import lock_and_renew_running_job_claim

    job = lock_and_renew_running_job_claim(
        db,
        context=context,
        lease_seconds=lease_seconds,
    )
    if job is None:
        return None
    if (
        job.kind != MEDIA_CONTENT_REINDEX_JOB_KIND
        or str(job.payload.get("media_id")) != str(work.media_id)
        or _job_revision(job.payload) != work.revision
    ):
        # justify-defect: publication is authorized only by this exact payload.
        raise AssertionError("media content-reindex publication identity is malformed")
    if _validated_media_revision(state["revision"]) != work.revision:
        _record_index_event(
            db,
            media_id=work.media_id,
            facts=IndexSuperseded(
                revision=work.revision, job_id=job.id, execution_id=context.execution_id
            ),
        )
        return None
    if plan.owner != IndexOwner("media", work.media_id) or plan.source_kind != work.source_kind:
        # justify-defect: the immutable plan must belong to the prepared snapshot.
        raise AssertionError("media content-index plan identity is malformed")

    result = publish_content_index(db, plan=plan, reason=work.reason)
    _record_index_event(
        db,
        media_id=work.media_id,
        facts=IndexSucceeded(
            revision=work.revision, job_id=job.id, execution_id=context.execution_id
        ),
    )
    plan_chunk_count = len(plan.chunks) if isinstance(plan, ContentIndexPlan) else plan.chunk_count
    if work.source_kind == "pdf" and plan_chunk_count == 0:
        db.execute(
            text(
                """
                UPDATE content_index_states
                SET
                    status = 'ocr_required',
                    status_reason = 'ocr_required',
                    active_embedding_provider = NULL,
                    active_embedding_model = NULL,
                    updated_at = now()
                WHERE owner_kind = 'media'
                  AND owner_id = :media_id
                  AND revision = :revision
                """
            ),
            {"media_id": work.media_id, "revision": work.revision},
        )
        return ContentIndexResult(result.owner, "ocr_required", 0)
    return result


def _snapshot_media_indexable_blocks(
    db: Session,
    *,
    media_id: UUID,
    source_kind: str,
    media_title: str,
    plain_text: str,
) -> list[IndexableBlock]:
    if source_kind == "pdf":
        page_rows = db.execute(
            text(
                """
                SELECT
                    page_number,
                    start_offset,
                    end_offset,
                    page_label,
                    page_width,
                    page_height,
                    page_rotation_degrees
                FROM pdf_page_text_spans
                WHERE media_id = :media_id
                ORDER BY page_number ASC
                """
            ),
            {"media_id": media_id},
        ).fetchall()
        if not page_rows and plain_text:
            page_rows = [(1, 0, len(plain_text), None, None, None, None)]
        return build_pdf_indexable_blocks(
            media_id=media_id,
            plain_text=plain_text,
            page_spans=page_rows,
        )

    fragments = (
        db.execute(
            text(
                """
                SELECT id, idx, canonical_text, html_sanitized
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY idx ASC, id ASC
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    nav_by_fragment_idx: dict[int, dict[str, object]] = {}
    if source_kind == "epub":
        for row in db.execute(
            text(
                """
                SELECT DISTINCT ON (fragment_idx)
                    fragment_idx,
                    location_id,
                    href_path,
                    href_fragment,
                    label
                FROM epub_nav_locations
                WHERE media_id = :media_id
                ORDER BY fragment_idx ASC, ordinal ASC
                """
            ),
            {"media_id": media_id},
        ).fetchall():
            nav_by_fragment_idx[int(row[0])] = {
                "section_id": row[1],
                "href_path": row[2],
                "anchor_id": row[3],
                "label": row[4],
            }

    fragment_blocks_by_id: dict[UUID, list[Any]] = {}
    fragment_ids = [UUID(str(fragment["id"])) for fragment in fragments]
    if fragment_ids:
        for row in db.execute(
            text(
                """
                SELECT fragment_id, block_idx, start_offset, end_offset
                FROM fragment_blocks
                WHERE fragment_id = ANY(:fragment_ids)
                ORDER BY fragment_id ASC, block_idx ASC
                """
            ),
            {"fragment_ids": fragment_ids},
        ).fetchall():
            fragment_blocks_by_id.setdefault(row[0], []).append(row)
    return build_fragment_indexable_blocks(
        media_id=media_id,
        source_kind=source_kind,
        fragments=fragments,
        media_title=media_title if source_kind == "web_article" else None,
        nav_by_fragment_idx=nav_by_fragment_idx,
        fragment_blocks_by_id=fragment_blocks_by_id,
    )


def request_media_content_reindex(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
    request_id: str | None,
) -> MediaContentReindexIntent:
    """Create a new media index intent inside the caller's transaction."""
    _validate_media_reindex_reason(reason)
    _lock_media_for_reindex(db, media_id)
    state = _lock_media_index_state(db, media_id)
    if state is None:
        db.execute(
            text(
                """
                INSERT INTO content_index_states (
                    owner_kind,
                    owner_id,
                    status,
                    status_reason,
                    active_embedding_provider,
                    active_embedding_model,
                    revision,
                    updated_at,
                    created_at
                )
                VALUES (
                    'media',
                    :media_id,
                    'pending',
                    :reason,
                    NULL,
                    NULL,
                    0,
                    now(),
                    now()
                )
                """
            ),
            {"media_id": media_id, "reason": reason},
        )
        state = _lock_media_index_state(db, media_id)
        if state is None:
            # justify-defect: the locked media row protects first state creation.
            raise AssertionError("media content-index state insert was not visible")

    revision = _validated_media_revision(state["revision"]) + 1
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET
                revision = :revision,
                status = 'pending',
                status_reason = :reason,
                active_embedding_provider = NULL,
                active_embedding_model = NULL,
                updated_at = now()
            WHERE owner_kind = 'media'
              AND owner_id = :media_id
            """
        ),
        {"media_id": media_id, "revision": revision, "reason": reason},
    )

    from nexus.jobs.queue import (
        enqueue_job,
        lock_jobs_for_payload,
        reset_unclaimed_job_for_new_intent,
        supersede_unclaimed_job,
    )
    from nexus.jobs.registry import get_default_registry

    definition = get_default_registry()[MEDIA_CONTENT_REINDEX_JOB_KIND]
    payload = _media_reindex_payload(
        media_id=media_id,
        revision=revision,
        reason=reason,
        request_id=request_id,
    )
    jobs = lock_jobs_for_payload(
        db,
        kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
        expected_payload_match={"media_id": str(media_id)},
    )
    waiting = [
        job for job in jobs if job.status in {"pending", "failed"} and job.claimed_by is None
    ]
    if waiting:
        selected = reset_unclaimed_job_for_new_intent(
            db,
            job_id=waiting[0].id,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            payload=payload,
            max_attempts=definition.max_attempts,
        )
        for obsolete in waiting[1:]:
            supersede_unclaimed_job(
                db,
                job_id=obsolete.id,
                kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            )
    else:
        selected = enqueue_job(
            db,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            payload=payload,
            max_attempts=definition.max_attempts,
        )

    _assert_media_reindex_waiting_postcondition(
        db,
        media_id=media_id,
        revision=revision,
    )
    _record_index_event(
        db, media_id=media_id, facts=IndexAccepted(revision=revision, job_id=selected.id)
    )
    return MediaContentReindexIntent(
        revision=revision,
        background_job_id=selected.id,
        suspended=False,
        enqueued=not waiting,
    )


def ensure_media_content_reindex_job(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
    request_id: str | None,
) -> MediaContentReindexIntent:
    """Ensure the current pending/indexing revision has an owned queue row."""
    _validate_media_reindex_reason(reason)
    _lock_media_for_reindex(db, media_id)
    state = _lock_media_index_state(db, media_id)
    if state is None:
        # justify-defect: reconciliation selects an existing media index state.
        raise AssertionError("cannot ensure a job without a media content-index state")
    revision = _validated_media_revision(state["revision"])

    from nexus.jobs.queue import enqueue_job, lock_jobs_for_payload
    from nexus.jobs.registry import get_default_registry

    jobs = lock_jobs_for_payload(
        db,
        kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
        expected_payload_match={"media_id": str(media_id)},
    )
    current = [job for job in jobs if _job_revision(job.payload) == revision]
    waiting = [
        job for job in current if job.status in {"pending", "failed"} and job.claimed_by is None
    ]
    if len(waiting) > 1:
        # justify-defect: the media/state lock serializes every canonical enqueue.
        raise AssertionError("multiple waiting jobs exist for one media index revision")
    running = [job for job in current if job.status == "running"]
    dead = [job for job in current if job.status == "dead"]
    if len(running) > 1 or len(dead) > 1:
        # justify-defect: one revision has one execution identity.
        raise AssertionError("multiple owned jobs exist for one media index revision")
    if waiting:
        return MediaContentReindexIntent(revision, waiting[0].id, False, False)
    if running:
        return MediaContentReindexIntent(revision, running[0].id, False, False)
    if dead:
        return MediaContentReindexIntent(revision, dead[0].id, True, False)

    definition = get_default_registry()[MEDIA_CONTENT_REINDEX_JOB_KIND]
    inserted = enqueue_job(
        db,
        kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
        payload=_media_reindex_payload(
            media_id=media_id,
            revision=revision,
            reason=reason,
            request_id=request_id,
        ),
        max_attempts=definition.max_attempts,
    )
    _assert_media_reindex_waiting_postcondition(
        db,
        media_id=media_id,
        revision=revision,
    )
    _record_index_event(
        db, media_id=media_id, facts=IndexAccepted(revision=revision, job_id=inserted.id)
    )
    return MediaContentReindexIntent(revision, inserted.id, False, True)


def _record_index_event(db: Session, *, media_id: UUID, facts: IndexFacts) -> None:
    append_processing_event(
        db, media_id=media_id, facts=facts, stage=present("Index"), failure_code=absent()
    )


@dataclass(frozen=True, slots=True)
class SearchRecoveryFacts:
    """The current index revision and, when its exact reindex job is dead, that job."""

    revision: int
    dead_job_id: UUID | None
    is_creator: bool
    is_admin: bool


def search_recovery(facts: SearchRecoveryFacts) -> SearchRecoveryAnswer:
    """The one recovery answer for a media's search-index obligation (contract D6)."""
    if facts.dead_job_id is None:
        return None
    if not (facts.is_creator or facts.is_admin):
        return "NotOwner"
    return RepairSearchOffer(expected_revision=facts.revision, expected_job_id=facts.dead_job_id)


def repair_dead_media_reindex(
    db: Session,
    *,
    actor: RecoveryActor,
    media_id: UUID,
    expected_revision: int,
    expected_job_id: UUID,
) -> SearchRepairAdmission:
    """Requeue the exact dead reindex job of the current index revision. Never
    touches source rows: search repair repeats indexing, not extraction."""
    scope = f"media_search_repair:{media_id}"
    request_bytes = canonical_json_bytes(
        {"expected_revision": expected_revision, "expected_job_id": str(expected_job_id)}
    )

    def admit() -> SearchRepairAdmission:
        match actor:
            case ViewerRecovery(viewer_id=viewer_id, is_admin=is_admin):
                if not can_read_media(db, viewer_id, media_id):
                    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
                creator_id = db.execute(
                    text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                ).scalar_one_or_none()
                if creator_id is None:
                    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
                is_creator = creator_id == viewer_id
                if not (is_creator or is_admin):
                    raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
                replay = lookup_replay(
                    db,
                    viewer_id=viewer_id,
                    scope=scope,
                    client_mutation_id=actor.client_mutation_id,
                    request_bytes=request_bytes,
                )
                if replay is not None:
                    db.rollback()
                    return SearchRepairAdmission.model_validate(replay)
            case OperatorRecovery():
                is_creator, is_admin = False, True
        _lock_media_for_reindex(db, media_id)
        state = _lock_media_index_state(db, media_id)
        if state is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no search index to repair."
            )
        revision = _validated_media_revision(state["revision"])
        dead = current_dead_job_for_payload(
            db,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            expected_payload_match={"media_id": str(media_id), "revision": revision},
        )
        offer = search_recovery(
            SearchRecoveryFacts(
                revision=revision,
                dead_job_id=None if dead is None else dead.id,
                is_creator=is_creator,
                is_admin=is_admin,
            )
        )
        if offer == "NotOwner":
            # justify-defect: creator-or-admin authority was established before the lock.
            raise AssertionError("search repair policy refused an authorized actor")
        current: dict[str, object] = {"revision": revision}
        if dead is not None:
            current["job_id"] = str(dead.id)
        if offer is None or (offer.expected_revision, offer.expected_job_id) != (
            expected_revision,
            expected_job_id,
        ):
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected search index execution is no longer current.",
                details={"current": current},
            )
        if not requeue_dead_job(db, job_id=offer.expected_job_id):
            # justify-defect: current_dead_job_for_payload locked this exact dead row.
            raise AssertionError("locked dead reindex job could not be requeued")
        _record_index_event(
            db,
            media_id=media_id,
            facts=IndexRecoveryAccepted(revision=revision, job_id=offer.expected_job_id),
        )
        admission = SearchRepairAdmission(
            media_id=media_id, revision=revision, job_id=offer.expected_job_id
        )
        if isinstance(actor, ViewerRecovery):
            record_replay(
                db,
                viewer_id=actor.viewer_id,
                scope=scope,
                client_mutation_id=actor.client_mutation_id,
                request_bytes=request_bytes,
                response_json=admission.model_dump(mode="json"),
                changed_lanes={},
            )
        db.commit()
        return admission

    return admit_serializable(db, "repair_dead_media_reindex", admit)


def current_search_repair_offer(db: Session, *, media_id: UUID) -> RepairSearchOffer | None:
    """The search repair an operator could admit for this media right now, or
    ``None``. The read ends here: an internal route resolves the identity it
    will name, then the admission opens its own serializable transaction."""
    revision = db.execute(
        text(
            """
            SELECT revision
            FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).scalar_one_or_none()
    offer = None
    if revision is not None:
        revision = _validated_media_revision(revision)
        dead = current_dead_job_for_payload(
            db,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            expected_payload_match={"media_id": str(media_id), "revision": revision},
        )
        offer = search_recovery(
            SearchRecoveryFacts(
                revision=revision,
                dead_job_id=None if dead is None else dead.id,
                is_creator=False,
                is_admin=True,
            )
        )
    db.rollback()
    return offer if isinstance(offer, RepairSearchOffer) else None


def _lock_media_for_reindex(db: Session, media_id: UUID) -> None:
    """Hold the media row for a transaction that goes on to lock its queue rows.

    ``FOR NO KEY UPDATE`` admits the ``KEY SHARE`` the worker's history insert
    takes on this row inside its own queue transition, so a transition and a
    media-locked caller never wait on each other's locks.
    """
    if (
        db.execute(
            text("SELECT id FROM media WHERE id = :media_id FOR NO KEY UPDATE"),
            {"media_id": media_id},
        ).scalar_one_or_none()
        is None
    ):
        # justify-defect: source success and reconciliation carry a durable media id.
        raise AssertionError("media content-index owner does not exist")


def _lock_media_index_state(db: Session, media_id: UUID) -> Mapping[str, object] | None:
    row = (
        db.execute(
            text(
                """
                SELECT id, status, revision
                FROM content_index_states
                WHERE owner_kind = 'media'
                  AND owner_id = :media_id
                FOR UPDATE
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "status": row["status"],
        "revision": row["revision"],
    }


def _validated_media_revision(value: object) -> int:
    if not _is_int(value) or value < 0:
        # justify-defect: trusted media revision storage must be non-negative.
        raise AssertionError("media content-index revision is malformed")
    return value


def _validate_media_reindex_reason(reason: str) -> None:
    if reason not in MEDIA_CONTENT_REINDEX_REASONS:
        # justify-defect: all callers use the closed same-system reason contract.
        raise AssertionError(f"unsupported media content-reindex reason: {reason}")


def _media_reindex_payload(
    *,
    media_id: UUID,
    revision: int,
    reason: str,
    request_id: str | None,
) -> dict[str, object]:
    return {
        "media_id": str(media_id),
        "revision": revision,
        "reason": reason,
        "request_id": (
            {"kind": "Absent"} if request_id is None else {"kind": "Present", "value": request_id}
        ),
    }


def _job_revision(payload: Mapping[str, object]) -> int:
    return _validated_media_revision(payload.get("revision"))


def _assert_media_reindex_waiting_postcondition(
    db: Session,
    *,
    media_id: UUID,
    revision: int,
) -> None:
    from nexus.jobs.queue import lock_jobs_for_payload

    jobs = lock_jobs_for_payload(
        db,
        kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
        expected_payload_match={"media_id": str(media_id)},
    )
    waiting = [
        job for job in jobs if job.status in {"pending", "failed"} and job.claimed_by is None
    ]
    current = [job for job in waiting if _job_revision(job.payload) == revision]
    obsolete = [job for job in waiting if _job_revision(job.payload) < revision]
    if len(current) != 1 or obsolete:
        # justify-defect: the locked owner row and queue rows define coalescing.
        raise AssertionError("media content-reindex waiting-job postcondition failed")


def mark_content_index_pending(db: Session, *, owner: IndexOwner, reason: str) -> None:
    """Flag an owner's index stale (gated out of search) without deleting its rows;
    the reindex job rebuilds and flips it back to ready."""
    _set_index_state(
        db,
        owner=owner,
        status="pending",
        status_reason=reason,
        embedding_provider=None,
        embedding_model=None,
        now=datetime.now(UTC),
    )


def deactivate_content_index(db: Session, *, owner: IndexOwner, reason: str) -> None:
    now = datetime.now(UTC)
    # A replacement invalidates the current materialization, not the durable
    # identity of the owner's indexing intent.  Retaining the state row is what
    # makes `revision` monotonic across source refreshes; deleting it would let
    # an obsolete worker publish again after the revision restarted at zero.
    replace_content_index_materialization(db, owner=owner)
    _set_index_state(
        db,
        owner=owner,
        status="pending",
        status_reason=reason,
        embedding_provider=None,
        embedding_model=None,
        now=now,
    )


def delete_content_index(db: Session, *, owner: IndexOwner) -> None:
    """Delete the complete index owner, including its state row."""
    replace_content_index_materialization(db, owner=owner)
    db.execute(
        text(
            "DELETE FROM content_index_states "
            "WHERE owner_kind = :owner_kind AND owner_id = :owner_id"
        ),
        {"owner_kind": owner.kind, "owner_id": owner.id},
    )


def replace_content_index_materialization(db: Session, *, owner: IndexOwner) -> None:
    """Delete replaceable index rows while retaining the owner's state identity."""
    params = {"owner_kind": owner.kind, "owner_id": owner.id}
    # The per-media unit's claims reference this media's evidence_spans with a
    # non-cascading FK; clear them through their sole owner before the spans go.
    # Pages carry no media unit, so this is gated to media owners only.
    if owner.kind == "media":
        media_intelligence_lifecycle.clear_media_claims_for_reindex(db, media_id=owner.id)
    db.execute(
        text(
            """
            UPDATE message_retrievals mr
            SET evidence_span_id = NULL
            FROM evidence_spans es
            WHERE mr.evidence_span_id = es.id
              AND es.owner_kind = :owner_kind
              AND es.owner_id = :owner_id
            """
        ),
        params,
    )
    # Graph cleanup, set-batched over every destroyed span/chunk (§9.6, AC12):
    # bare edges touching one die with it; cited edges keep rendering from their
    # snapshots and the jump fails closed. Two DELETEs total, not N+1 per row —
    # this is a hot reindex path. Runs in the caller's transaction, before the
    # rows below disappear.
    span_ids = (
        db.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = :owner_kind AND owner_id = :owner_id"
            ),
            params,
        )
        .scalars()
        .all()
    )
    chunk_ids = (
        db.execute(
            text(
                "SELECT id FROM content_chunks "
                "WHERE owner_kind = :owner_kind AND owner_id = :owner_id"
            ),
            params,
        )
        .scalars()
        .all()
    )
    cleanup.delete_edges_for_deleted_resources(
        db,
        refs=[
            *(ResourceRef(scheme="evidence_span", id=span_id) for span_id in span_ids),
            *(ResourceRef(scheme="content_chunk", id=chunk_id) for chunk_id in chunk_ids),
        ],
    )
    db.execute(
        text(
            """
            DELETE FROM content_embeddings ce
            USING content_chunks cc
            WHERE ce.chunk_id = cc.id
              AND cc.owner_kind = :owner_kind AND cc.owner_id = :owner_id
            """
        ),
        params,
    )
    db.execute(
        text(
            """
            DELETE FROM content_chunk_parts ccp
            USING content_chunks cc
            WHERE ccp.chunk_id = cc.id
              AND cc.owner_kind = :owner_kind AND cc.owner_id = :owner_id
            """
        ),
        params,
    )
    db.execute(
        text("DELETE FROM content_chunks WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )
    db.execute(
        text("DELETE FROM evidence_spans WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )
    db.execute(
        text("DELETE FROM content_blocks WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )


def _set_index_state(
    db: Session,
    *,
    owner: IndexOwner,
    status: str,
    status_reason: str | None,
    embedding_provider: str | None,
    embedding_model: str | None,
    now: datetime,
) -> None:
    if status != "ready":
        embedding_provider = None
        embedding_model = None
    exists = db.execute(
        text(
            "SELECT 1 FROM content_index_states "
            "WHERE owner_kind = :owner_kind AND owner_id = :owner_id"
        ),
        {"owner_kind": owner.kind, "owner_id": owner.id},
    ).scalar()
    if exists:
        db.execute(
            text(
                """
                UPDATE content_index_states
                SET status = :status,
                    status_reason = :status_reason,
                    active_embedding_provider = :embedding_provider,
                    active_embedding_model = :embedding_model,
                    updated_at = :now
                WHERE owner_kind = :owner_kind AND owner_id = :owner_id
                """
            ),
            {
                "owner_kind": owner.kind,
                "owner_id": owner.id,
                "status": status,
                "status_reason": status_reason,
                "embedding_provider": embedding_provider,
                "embedding_model": embedding_model,
                "now": now,
            },
        )
        return

    db.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind,
                owner_id,
                status,
                status_reason,
                active_embedding_provider,
                active_embedding_model,
                updated_at,
                created_at
            )
            VALUES (
                :owner_kind,
                :owner_id,
                :status,
                :status_reason,
                :embedding_provider,
                :embedding_model,
                :now,
                :now
            )
            """
        ),
        {
            "owner_kind": owner.kind,
            "owner_id": owner.id,
            "status": status,
            "status_reason": status_reason,
            "embedding_provider": embedding_provider,
            "embedding_model": embedding_model,
            "now": now,
        },
    )


def _validate_blocks(
    *,
    owner: IndexOwner,
    source_kind: str,
    blocks: list[IndexableBlock],
) -> None:
    if source_kind not in {"web_article", "epub", "pdf", "transcript", "note"}:
        raise ValueError(f"Unsupported source_kind: {source_kind}")

    previous_source_end: int | None = None
    for expected_idx, block in enumerate(blocks):
        if block.owner != owner:
            raise ValueError("IndexableBlock owner does not match target owner")
        if block.source_kind != source_kind:
            raise ValueError("IndexableBlock source_kind does not match target source")
        if block.block_idx != expected_idx:
            raise ValueError("IndexableBlock rows must be contiguous and ordered")
        if not block.block_kind.strip():
            raise ValueError("IndexableBlock block_kind is required")
        if not _is_int(block.source_start_offset) or not _is_int(block.source_end_offset):
            raise ValueError("IndexableBlock source offsets must be integers")
        if block.source_start_offset < 0 or block.source_end_offset < block.source_start_offset:
            raise ValueError("IndexableBlock offsets are invalid")
        if block.source_end_offset - block.source_start_offset != len(block.canonical_text):
            raise ValueError("IndexableBlock source offsets do not match canonical_text")
        if previous_source_end is not None and block.source_start_offset < previous_source_end:
            raise ValueError("IndexableBlock source offsets must be sorted and non-overlapping")
        previous_source_end = block.source_end_offset
        if block.extraction_confidence is not None and not 0 <= block.extraction_confidence <= 1:
            raise ValueError("IndexableBlock extraction_confidence is invalid")
        if any(not isinstance(heading, str) for heading in block.heading_path):
            raise ValueError("IndexableBlock heading_path must contain strings")
        if not isinstance(block.metadata, dict):
            raise ValueError("IndexableBlock metadata must be an object")
        _validate_selector(
            source_kind, block.locator, block.canonical_text, context="block locator"
        )
        _validate_selector(
            source_kind, block.selector, block.canonical_text, context="block selector"
        )


def _validate_selector(
    source_kind: str,
    selector: dict[str, object],
    text_value: str,
    *,
    context: str,
) -> None:
    if not isinstance(selector, dict):
        raise ValueError(f"{context} must be an object")
    quote = selector.get("text_quote")
    if not isinstance(quote, dict):
        raise ValueError(f"{context} text_quote is required")
    exact = quote.get("exact")
    prefix = quote.get("prefix")
    suffix = quote.get("suffix")
    if not isinstance(exact, str) or not isinstance(prefix, str) or not isinstance(suffix, str):
        raise ValueError(f"{context} text_quote values must be strings")
    if exact != text_value:
        raise ValueError(f"{context} text_quote exact does not match text")

    kind = selector.get("kind")

    if source_kind == "web_article":
        if kind != "web_text":
            raise ValueError(f"{context} kind is invalid for web_article")
        _validate_fragment_selector(selector, text_value, context=context)
        return
    if source_kind == "epub":
        if kind != "epub_text":
            raise ValueError(f"{context} kind is invalid for epub")
        _validate_fragment_selector(selector, text_value, context=context)
        section_id = selector.get("section_id")
        if section_id is not None and not isinstance(section_id, str):
            raise ValueError(f"{context} section_id is invalid")
        return
    if source_kind == "pdf":
        if kind not in {"pdf_text", "pdf_text_quote"}:
            raise ValueError(f"{context} kind is invalid for pdf")
        _validate_pdf_selector(selector, text_value, context=context)
        return
    if source_kind == "transcript":
        if kind != "transcript_time_text":
            raise ValueError(f"{context} kind is invalid for transcript")
        _validate_transcript_selector(selector, context=context)
        return
    if source_kind == "note":
        if kind != "note_text":
            raise ValueError(f"{context} kind is invalid for note")
        _validate_note_selector(selector, text_value, context=context)
        return
    raise ValueError(f"Unsupported source_kind: {source_kind}")


def _validate_note_selector(
    selector: dict[str, object],
    text_value: str,
    *,
    context: str,
) -> None:
    note_block_id = selector.get("note_block_id")
    if not isinstance(note_block_id, str):
        raise ValueError(f"{context} note_block_id is required")
    try:
        UUID(note_block_id)
    except ValueError:
        raise ValueError(f"{context} note_block_id is invalid") from None
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if not _is_int(start_offset) or not _is_int(end_offset):
        raise ValueError(f"{context} offsets must be integers")
    if start_offset < 0 or end_offset < start_offset:
        raise ValueError(f"{context} offsets are invalid")
    if end_offset - start_offset != len(text_value):
        raise ValueError(
            f"{context} offsets do not match text length "
            f"(start={start_offset}, end={end_offset}, text_length={len(text_value)})"
        )


def _validate_fragment_selector(
    selector: dict[str, object],
    text_value: str,
    *,
    context: str,
) -> None:
    fragment_id = selector.get("fragment_id")
    if not isinstance(fragment_id, str):
        raise ValueError(f"{context} fragment_id is required")
    try:
        UUID(fragment_id)
    except ValueError:
        raise ValueError(f"{context} fragment_id is invalid") from None
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if not _is_int(start_offset) or not _is_int(end_offset):
        raise ValueError(f"{context} offsets must be integers")
    if start_offset < 0 or end_offset < start_offset:
        raise ValueError(f"{context} offsets are invalid")
    if end_offset - start_offset != len(text_value):
        raise ValueError(
            f"{context} offsets do not match text length "
            f"(start={start_offset}, end={end_offset}, text_length={len(text_value)})"
        )


def _validate_pdf_selector(
    selector: dict[str, object],
    text_value: str,
    *,
    context: str,
) -> None:
    page_number = selector.get("page_number")
    physical_page_number = selector.get("physical_page_number")
    if not _is_int(page_number) or page_number < 1:
        raise ValueError(f"{context} page_number is invalid")
    if physical_page_number is not None and (
        not _is_int(physical_page_number) or physical_page_number < 1
    ):
        raise ValueError(f"{context} physical_page_number is invalid")
    page_label = selector.get("page_label")
    if page_label is not None and not isinstance(page_label, str):
        raise ValueError(f"{context} page_label is invalid")

    page_start = selector.get("page_text_start_offset")
    page_end = selector.get("page_text_end_offset")
    if not _is_int(page_start) or not _is_int(page_end):
        raise ValueError(f"{context} page text offsets must be integers")
    if page_start < 0 or page_end < page_start or page_end - page_start != len(text_value):
        raise ValueError(f"{context} page text offsets are invalid")

    plain_start = selector.get("plain_text_start_offset")
    plain_end = selector.get("plain_text_end_offset")
    if plain_start is not None or plain_end is not None:
        if not _is_int(plain_start) or not _is_int(plain_end):
            raise ValueError(f"{context} plain text offsets must be integers")
        if plain_start < 0 or plain_end < plain_start or plain_end - plain_start != len(text_value):
            raise ValueError(f"{context} plain text offsets are invalid")

    geometry = selector.get("geometry")
    if geometry is not None:
        _validate_pdf_geometry(geometry, context=context)


def _validate_pdf_geometry(value: object, *, context: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{context} geometry must be an object")
    if value.get("coordinate_space") != "pdf_points":
        raise ValueError(f"{context} geometry coordinate_space is invalid")
    page_width = value.get("page_width")
    page_height = value.get("page_height")
    if not _is_positive_number(page_width) or not _is_positive_number(page_height):
        raise ValueError(f"{context} geometry page size is invalid")
    rotation = value.get("page_rotation_degrees")
    if not _is_int(rotation) or rotation < 0:
        raise ValueError(f"{context} geometry page_rotation_degrees is invalid")
    quads = value.get("quads")
    if not isinstance(quads, list):
        raise ValueError(f"{context} geometry quads must be an array")
    for raw_quad in quads:
        if not isinstance(raw_quad, dict):
            raise ValueError(f"{context} geometry quad must be an object")
        for key in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"):
            if not _is_number(raw_quad.get(key)):
                raise ValueError(f"{context} geometry quad coordinate is invalid")


def _validate_transcript_selector(selector: dict[str, object], *, context: str) -> None:
    t_start_ms = selector.get("t_start_ms")
    t_end_ms = selector.get("t_end_ms")
    if not _is_int(t_start_ms) or not _is_int(t_end_ms):
        raise ValueError(f"{context} transcript times must be integers")
    if t_start_ms < 0 or t_end_ms <= t_start_ms:
        raise ValueError(f"{context} transcript times are invalid")


def _is_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_document_source_kind(value: object) -> TypeGuard[DocumentSourceKind]:
    return isinstance(value, str) and value in {"web_article", "epub", "pdf"}


def _is_number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _is_positive_number(value: object) -> TypeGuard[int | float]:
    return _is_number(value) and float(value) > 0


def _iter_content_chunk_parts(
    blocks: Sequence[IndexableBlock],
) -> Iterator[list[tuple[IndexableBlock, int, int, int]]]:
    """Yield one chunk descriptor at a time without retaining a second corpus graph."""
    current_parts: list[tuple[IndexableBlock, int, int, int]] = []
    current_tokens = 0
    for block in blocks:
        for start_offset, end_offset, token_count in _block_pieces(block.canonical_text):
            if token_count == 0:
                continue
            if current_parts:
                previous_block, _, previous_end_offset, _ = current_parts[-1]
                if (
                    current_tokens + token_count > CHUNK_MAX_TOKENS
                    or not _same_locator_anchor(previous_block, block)
                    or previous_end_offset != len(previous_block.canonical_text)
                    or start_offset != 0
                    or _separator_before(previous_block, block) != ""
                ):
                    yield current_parts
                    current_parts = []
                    current_tokens = 0
            current_parts.append((block, start_offset, end_offset, token_count))
            current_tokens += token_count
    if current_parts:
        yield current_parts


def _plan_content_chunk_batch(
    *,
    source_kind: str,
    chunk_parts_batch: Sequence[list[tuple[IndexableBlock, int, int, int]]],
    embedding_model: str,
    embedding_dimensions: int,
    maximum_chunk_bytes: int | None,
    embed_texts: TextEmbeddingBatch,
) -> list[PlannedContentChunk]:
    """Embed one bounded batch and retain vectors in pgvector's float32 shape."""
    if not 1 <= len(chunk_parts_batch) <= CONTENT_INDEX_EMBEDDING_BATCH_SIZE:
        raise AssertionError("content-index embedding batch is outside its closed bound")
    chunk_texts = [_chunk_text(chunk_parts) for chunk_parts in chunk_parts_batch]
    if maximum_chunk_bytes is not None and any(
        utf8_byte_length(chunk_text) > maximum_chunk_bytes for chunk_text in chunk_texts
    ):
        raise ContentIndexResourceLimitExceeded()
    chunk_locators: list[dict[str, object]] = []
    for chunk_parts, chunk_text in zip(chunk_parts_batch, chunk_texts, strict=True):
        chunk_locator = _chunk_locator(chunk_parts, chunk_text)
        _validate_selector(
            source_kind,
            chunk_locator,
            chunk_text,
            context="content chunk summary locator",
        )
        chunk_locators.append(chunk_locator)

    returned_embedding_model, embeddings = embed_texts(chunk_texts)
    if returned_embedding_model != embedding_model:
        raise ValueError("Embedding model changed during content indexing")
    if len(embeddings) != len(chunk_parts_batch):
        raise ValueError("Embedding count does not match chunk count")

    planned: list[PlannedContentChunk] = []
    for chunk_parts, chunk_text, chunk_locator, embedding in zip(
        chunk_parts_batch,
        chunk_texts,
        chunk_locators,
        embeddings,
        strict=True,
    ):
        if len(embedding) != embedding_dimensions:
            raise ValueError("Embedding dimensions do not match configured dimensions")
        normalized_embedding: list[float] = []
        for value in embedding:
            numeric = float(value)
            if not math.isfinite(numeric):
                raise ValueError("Embedding values must be finite")
            normalized_embedding.append(numeric)
        planned.append(
            PlannedContentChunk(
                parts=tuple(chunk_parts),
                text=chunk_text,
                locator=chunk_locator,
                embedding_f32=array("f", normalized_embedding).tobytes(),
            )
        )
    return planned


def _packed_embedding_literal(value: bytes, *, dimensions: int) -> str:
    if len(value) != dimensions * array("f").itemsize:
        raise AssertionError("packed content-index embedding has an invalid byte length")
    vector = array("f")
    vector.frombytes(value)
    return to_pgvector_literal(list(vector))


def _spool_chunk_record(chunk_idx: int, chunk: PlannedContentChunk) -> dict[str, object]:
    return {
        "chunk_idx": chunk_idx,
        "embedding_f32": base64.b64encode(chunk.embedding_f32).decode("ascii"),
        "kind": "Chunk",
        "locator": chunk.locator,
        "parts": [
            {
                "block_idx": block.block_idx,
                "end_offset": end_offset,
                "start_offset": start_offset,
                "token_count": token_count,
            }
            for block, start_offset, end_offset, token_count in chunk.parts
        ],
        "text": chunk.text,
    }


def _canonical_spool_record(record: Mapping[str, object]) -> bytes:
    return (
        json.dumps(record, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


def _write_spool_record(
    spool: BinaryIO,
    record: Mapping[str, object],
    *,
    written_bytes: int,
    digest: Any,
) -> int:
    encoded = _canonical_spool_record(record)
    if (
        len(encoded) > _CONTENT_INDEX_SPOOL_RECORD_MAX_BYTES
        or written_bytes + len(encoded) > CONTENT_INDEX_SPOOL_MAX_BYTES
    ):
        raise ContentIndexResourceLimitExceeded()
    spool.write(encoded)
    if digest is not None:
        digest.update(encoded)
    return written_bytes + len(encoded)


def _spool_record_mapping(raw: bytes, *, context: str) -> dict[str, object]:
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContentIndexSpoolCorruption(f"{context} is not canonical JSON") from exc
    if not isinstance(decoded, dict):
        raise ContentIndexSpoolCorruption(f"{context} has an invalid shape")
    if _canonical_spool_record(decoded) != raw:
        raise ContentIndexSpoolCorruption(f"{context} is not canonically encoded")
    return decoded


def _exact_spool_record(
    raw: bytes,
    *,
    expected_keys: frozenset[str],
    context: str,
) -> dict[str, object]:
    decoded = _spool_record_mapping(raw, context=context)
    if set(decoded) != expected_keys:
        raise ContentIndexSpoolCorruption(f"{context} has an invalid shape")
    return decoded


def _read_spool_line(spool: BinaryIO, *, context: str) -> bytes:
    raw = spool.readline(_CONTENT_INDEX_SPOOL_RECORD_MAX_BYTES + 1)
    if not raw or len(raw) > _CONTENT_INDEX_SPOOL_RECORD_MAX_BYTES or not raw.endswith(b"\n"):
        raise ContentIndexSpoolCorruption(f"{context} is absent, truncated, or oversized")
    return raw


def _require_spool_int(value: object, *, context: str) -> int:
    if not _is_int(value):
        raise ContentIndexSpoolCorruption(f"{context} must be an integer")
    return value


def _decode_spooled_chunk(
    record: Mapping[str, object],
    *,
    plan: SpooledContentIndexPlan,
    expected_chunk_idx: int,
) -> PlannedContentChunk:
    chunk_idx = _require_spool_int(record["chunk_idx"], context="spool chunk index")
    if chunk_idx != expected_chunk_idx:
        raise ContentIndexSpoolCorruption("spool chunk order is not contiguous")
    chunk_text = record["text"]
    locator = record["locator"]
    raw_parts = record["parts"]
    raw_embedding = record["embedding_f32"]
    if (
        not isinstance(chunk_text, str)
        or utf8_byte_length(chunk_text) > CONTENT_INDEX_CHUNK_MAX_BYTES
    ):
        raise ContentIndexSpoolCorruption("spool chunk text is invalid")
    if not isinstance(locator, dict):
        raise ContentIndexSpoolCorruption("spool chunk locator is invalid")
    if not isinstance(raw_parts, list) or not raw_parts:
        raise ContentIndexSpoolCorruption("spool chunk parts are invalid")
    if not isinstance(raw_embedding, str):
        raise ContentIndexSpoolCorruption("spool chunk embedding is invalid")

    parts: list[tuple[IndexableBlock, int, int, int]] = []
    total_tokens = 0
    for part_idx, raw_part in enumerate(raw_parts):
        if not isinstance(raw_part, dict) or set(raw_part) != {
            "block_idx",
            "end_offset",
            "start_offset",
            "token_count",
        }:
            raise ContentIndexSpoolCorruption(f"spool chunk part {part_idx} has an invalid shape")
        block_idx = _require_spool_int(
            raw_part["block_idx"], context=f"spool chunk part {part_idx} block index"
        )
        start_offset = _require_spool_int(
            raw_part["start_offset"], context=f"spool chunk part {part_idx} start offset"
        )
        end_offset = _require_spool_int(
            raw_part["end_offset"], context=f"spool chunk part {part_idx} end offset"
        )
        token_count = _require_spool_int(
            raw_part["token_count"], context=f"spool chunk part {part_idx} token count"
        )
        if not 0 <= block_idx < len(plan.blocks):
            raise ContentIndexSpoolCorruption("spool chunk part names an absent block")
        block = plan.blocks[block_idx]
        if not 0 <= start_offset <= end_offset <= len(block.canonical_text) or token_count <= 0:
            raise ContentIndexSpoolCorruption("spool chunk part offsets or token count are invalid")
        total_tokens += token_count
        parts.append((block, start_offset, end_offset, token_count))
    if total_tokens > CHUNK_MAX_TOKENS or _chunk_text(parts) != chunk_text:
        raise ContentIndexSpoolCorruption("spool chunk parts do not reconstruct its text")
    expected_locator = _chunk_locator(parts, chunk_text)
    if _canonical_spool_record(expected_locator) != _canonical_spool_record(locator):
        raise ContentIndexSpoolCorruption("spool chunk locator does not match its parts")
    try:
        embedding_f32 = base64.b64decode(raw_embedding, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ContentIndexSpoolCorruption("spool chunk embedding is not canonical base64") from exc
    if len(embedding_f32) != plan.embedding_dimensions * array("f").itemsize:
        raise ContentIndexSpoolCorruption("spool chunk embedding dimensions do not match its plan")
    try:
        _validate_selector(plan.source_kind, locator, chunk_text, context="spool chunk locator")
    except ValueError as exc:
        raise ContentIndexSpoolCorruption(
            "spool chunk locator violates its source contract"
        ) from exc
    return PlannedContentChunk(
        parts=tuple(parts),
        text=chunk_text,
        locator=locator,
        embedding_f32=embedding_f32,
    )


def read_spooled_content_index_chunks(
    plan: SpooledContentIndexPlan,
) -> Iterator[PlannedContentChunk]:
    """Validate and stream one exact complete document plan from local scratch."""
    try:
        size_bytes = plan.spool_path.stat().st_size
    except OSError as exc:
        raise ContentIndexSpoolCorruption("content-index spool is absent") from exc
    if size_bytes > CONTENT_INDEX_SPOOL_MAX_BYTES:
        raise ContentIndexSpoolCorruption("content-index spool exceeds its committed envelope")
    digest = hashlib.sha256()
    expected_header = {
        "block_count": len(plan.blocks),
        "embedding_dimensions": plan.embedding_dimensions,
        "embedding_model": plan.embedding_model,
        "embedding_provider": plan.embedding_provider,
        "kind": "Header",
        "owner_id": str(plan.owner.id),
        "owner_kind": plan.owner.kind,
        "source_kind": plan.source_kind,
        "version": _CONTENT_INDEX_SPOOL_VERSION,
    }
    try:
        with plan.spool_path.open("rb") as spool:
            header_raw = _read_spool_line(spool, context="content-index spool header")
            header = _exact_spool_record(
                header_raw,
                expected_keys=frozenset(expected_header),
                context="content-index spool header",
            )
            if header != expected_header:
                raise ContentIndexSpoolCorruption(
                    "content-index spool header does not match its plan"
                )
            digest.update(header_raw)
            chunk_count = 0
            while True:
                raw = _read_spool_line(spool, context="content-index spool record")
                record = _spool_record_mapping(raw, context="content-index spool record")
                record_kind = record.get("kind")
                if record_kind == "Complete":
                    if set(record) != {"chunk_count", "kind", "sha256"}:
                        raise ContentIndexSpoolCorruption(
                            "content-index spool completion has an invalid shape"
                        )
                    complete_count = _require_spool_int(
                        record["chunk_count"], context="content-index spool complete count"
                    )
                    if (
                        complete_count != chunk_count
                        or complete_count != plan.chunk_count
                        or record["sha256"] != digest.hexdigest()
                        or spool.read(1) != b""
                    ):
                        raise ContentIndexSpoolCorruption(
                            "content-index spool completion does not match its records"
                        )
                    return
                if record_kind != "Chunk":
                    raise ContentIndexSpoolCorruption("content-index spool record kind is invalid")
                if set(record) != {
                    "chunk_idx",
                    "embedding_f32",
                    "kind",
                    "locator",
                    "parts",
                    "text",
                }:
                    raise ContentIndexSpoolCorruption(
                        "content-index spool chunk has an invalid shape"
                    )
                chunk = _decode_spooled_chunk(
                    record,
                    plan=plan,
                    expected_chunk_idx=chunk_count,
                )
                digest.update(raw)
                chunk_count += 1
                yield chunk
    except ContentIndexSpoolCorruption:
        raise
    except OSError as exc:
        raise ContentIndexSpoolCorruption("content-index spool could not be read") from exc


def _content_index_plan_chunks(
    plan: ContentIndexPlan | SpooledContentIndexPlan,
) -> Iterator[PlannedContentChunk]:
    if isinstance(plan, ContentIndexPlan):
        yield from plan.chunks
        return
    yield from read_spooled_content_index_chunks(plan)


def _block_pieces(text_value: str) -> Iterator[tuple[int, int, int]]:
    matches = iter(re.finditer(r"\S+", text_value))
    window = list(islice(matches, CHUNK_MAX_TOKENS + 1))
    if not window:
        yield (0, len(text_value), 0)
        return
    step = CHUNK_MAX_TOKENS - CHUNK_OVERLAP_TOKENS
    while window:
        has_more = len(window) > CHUNK_MAX_TOKENS
        current = window[:CHUNK_MAX_TOKENS] if has_more else window
        yield (current[0].start(), current[-1].end(), len(current))
        if not has_more:
            return
        window = window[step:]
        window.extend(islice(matches, CHUNK_MAX_TOKENS + 1 - len(window)))


def _separator_before(previous_block: IndexableBlock | None, block: IndexableBlock) -> str:
    if previous_block is None:
        return ""
    if previous_block.source_end_offset == block.source_start_offset:
        return ""
    return "\n\n"


def _same_locator_anchor(left: IndexableBlock, right: IndexableBlock) -> bool:
    left_kind = left.locator.get("kind")
    if left_kind != right.locator.get("kind"):
        return False
    if left_kind in ("web_text", "epub_text"):
        return left.locator.get("fragment_id") == right.locator.get("fragment_id")
    if left_kind == "pdf_text":
        return left.locator.get("page_number") == right.locator.get("page_number")
    if left_kind == "transcript_time_text":
        return left.locator.get("t_start_ms") == right.locator.get(
            "t_start_ms"
        ) and left.locator.get("t_end_ms") == right.locator.get("t_end_ms")
    if left_kind == "note_text":
        # Anchor on note_block_id forbids cross-block coalescing (D10): every
        # note chunk stays inside one block and is citeable to that block.
        return left.locator.get("note_block_id") == right.locator.get("note_block_id")
    raise ValueError(f"Unsupported locator kind: {left_kind}")


def _chunk_text(parts: list[tuple[IndexableBlock, int, int, int]]) -> str:
    chunks = []
    previous_block: IndexableBlock | None = None
    for block, start_offset, end_offset, _ in parts:
        chunks.append(_separator_before(previous_block, block))
        chunks.append(block.canonical_text[start_offset:end_offset])
        previous_block = block
    return "".join(chunks)


def _chunk_locator(
    parts: list[tuple[IndexableBlock, int, int, int]],
    chunk_text: str,
) -> dict[str, object]:
    first_block, first_start, _, _ = parts[0]
    last_block, _, last_end, _ = parts[-1]
    locator = dict(first_block.locator)
    locator["text_quote"] = {"exact": chunk_text, "prefix": "", "suffix": ""}

    if locator.get("kind") in ("web_text", "epub_text"):
        same_fragment = all(
            block.locator.get("fragment_id") == first_block.locator.get("fragment_id")
            for block, _, _, _ in parts
        )
        if same_fragment:
            locator["start_offset"] = (
                int(str(first_block.locator.get("start_offset") or 0)) + first_start
            )
            locator["end_offset"] = int(str(last_block.locator.get("start_offset") or 0)) + last_end
    elif locator.get("kind") == "pdf_text":
        same_page = all(
            block.locator.get("page_number") == first_block.locator.get("page_number")
            for block, _, _, _ in parts
        )
        if same_page:
            full_page_text_end = int(str(first_block.locator.get("page_text_end_offset") or 0))
            page_start = (
                int(str(first_block.locator.get("page_text_start_offset") or 0)) + first_start
            )
            page_end = int(str(last_block.locator.get("page_text_start_offset") or 0)) + last_end
            plain_start = (
                int(str(first_block.locator.get("plain_text_start_offset") or 0)) + first_start
            )
            plain_end = int(str(last_block.locator.get("plain_text_start_offset") or 0)) + last_end
            locator["page_text_start_offset"] = page_start
            locator["page_text_end_offset"] = page_end
            locator["plain_text_start_offset"] = plain_start
            locator["plain_text_end_offset"] = plain_end
            geometry = locator.get("geometry")
            if isinstance(geometry, dict) and geometry.get("quads") == []:
                page_width = geometry.get("page_width")
                page_height = geometry.get("page_height")
                if (
                    full_page_text_end > 0
                    and _is_positive_number(page_width)
                    and _is_positive_number(page_height)
                ):
                    page_width_f = float(page_width)
                    page_height_f = float(page_height)
                    top = max(
                        0.0, min(page_height_f, page_height_f * page_start / full_page_text_end)
                    )
                    highlight_height = max(8.0, min(18.0, page_height_f / 60.0))
                    bottom = top + highlight_height
                    bottom = min(page_height_f, bottom)
                    if bottom > top:
                        horizontal_inset = min(48.0, page_width_f * 0.08)
                        locator["geometry"] = {
                            **geometry,
                            "projection": "proportional_text_offsets",
                            "quads": [
                                {
                                    "x1": horizontal_inset,
                                    "y1": top,
                                    "x2": page_width_f - horizontal_inset,
                                    "y2": top,
                                    "x3": page_width_f - horizontal_inset,
                                    "y3": bottom,
                                    "x4": horizontal_inset,
                                    "y4": bottom,
                                }
                            ],
                        }
    elif locator.get("kind") == "transcript_time_text":
        locator["t_start_ms"] = first_block.locator.get("t_start_ms")
        locator["t_end_ms"] = last_block.locator.get("t_end_ms")
    elif locator.get("kind") == "note_text":
        # Single-block by construction (D10): first_block is last_block. Offsets
        # are within the note_block body; shift the block-relative range by the piece.
        block_start = int(str(first_block.locator.get("start_offset") or 0))
        locator["start_offset"] = block_start + first_start
        locator["end_offset"] = block_start + last_end
    else:
        raise ValueError(f"Unsupported locator kind: {locator.get('kind')}")

    return locator


def _text_quote(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - 64) : start_offset],
        "suffix": text_value[end_offset : min(len(text_value), end_offset + 64)],
    }


def _field(value: Any, name: str, default: object) -> object:
    if isinstance(value, Mapping):
        return value.get(name, default)
    if hasattr(value, name):
        return getattr(value, name)
    try:
        if name == "page_number":
            return value[0]
        if name == "start_offset":
            return value[1]
        if name == "end_offset":
            return value[2]
        if name == "page_label":
            return value[3]
        if name == "page_width":
            return value[4]
        if name == "page_height":
            return value[5]
        if name == "page_rotation_degrees":
            return value[6]
    except (IndexError, TypeError):
        return default
    return default


def _pdf_span_required_int(value: Any, name: str) -> int:
    raw = _field(value, name, None)
    if _is_int(raw):
        return raw
    raise ValueError(f"PDF page span {name} must be an integer")


def _pdf_span_optional_non_negative_int(value: Any, name: str, *, default: int) -> int:
    raw = _field(value, name, None)
    if raw is None:
        return default
    if not _is_int(raw):
        raise ValueError(f"PDF page span {name} must be an integer")
    if raw < 0:
        raise ValueError(f"PDF page span {name} must be non-negative")
    return raw


def _pdf_span_positive_number_or_none(value: Any, name: str) -> float | None:
    raw = _field(value, name, None)
    if raw is None:
        return None
    if _is_positive_number(raw):
        return float(raw)
    raise ValueError(f"PDF page span {name} must be a positive number")


def _resolver_kind(source_kind: str) -> str:
    if source_kind == "web_article":
        return "web"
    if source_kind == "epub":
        return "epub"
    if source_kind == "pdf":
        return "pdf"
    if source_kind == "transcript":
        return "transcript"
    if source_kind == "note":
        return "note"
    raise ValueError(f"Unsupported source_kind: {source_kind}")
