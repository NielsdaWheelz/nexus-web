"""Turning text-bearing media and notes into the searchable materialization.

One linear pipeline: source snapshot → indexable blocks → chunks anchored to a
single locator → embeddings in bounded batches → one atomic republish of
blocks, evidence spans, chunks, embeddings and the index state. Plus the media
reindex lifecycle that fences each republish behind a monotonic revision.
"""

from __future__ import annotations

import base64
import json
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
_SPOOL_RECORD_MAX_BYTES = CONTENT_INDEX_CHUNK_MAX_BYTES * 16 + 1024 * 1024
MEDIA_CONTENT_REINDEX_JOB_KIND = "media_content_reindex_job"
MEDIA_CONTENT_REINDEX_REASONS = frozenset(
    {"source_success", "reconciliation", "oracle_corpus_seed"}
)
DocumentSourceKind = Literal["web_article", "epub", "pdf"]
_SOURCE_KINDS = ("web_article", "epub", "pdf", "transcript", "note")
_RESOLVER_KINDS = {
    "web_article": "web",
    "epub": "epub",
    "pdf": "pdf",
    "transcript": "transcript",
    "note": "note",
}


@dataclass(frozen=True)
class IndexOwner:
    kind: Literal["media", "note_block"]
    id: UUID


@dataclass(frozen=True)
class IndexableBlock:
    owner: IndexOwner
    source_kind: str
    block_idx: int
    block_kind: str
    canonical_text: str
    source_start_offset: int
    source_end_offset: int
    locator: dict[str, object]
    heading_path: tuple[str, ...]


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


@dataclass(frozen=True)
class ContentIndexPlan:
    """The note/transcript path: a complete materialization held in memory."""

    owner: IndexOwner
    source_kind: str
    blocks: tuple[IndexableBlock, ...]
    chunks: tuple[PlannedContentChunk, ...]
    embedding_provider: str
    embedding_model: str
    embedding_dimensions: int


@dataclass(frozen=True)
class SpooledContentIndexPlan:
    """The document path: the same materialization streamed through local scratch."""

    owner: IndexOwner
    source_kind: DocumentSourceKind
    blocks: tuple[IndexableBlock, ...]
    spool_path: Path
    chunk_count: int
    embedding_provider: str
    embedding_model: str
    embedding_dimensions: int


class ContentIndexResourceLimitExceeded(Exception):
    """Expected rejection when a document cannot fit the indexing envelope."""

    error_code = ApiErrorCode.E_SOURCE_TOO_LARGE

    def __init__(self) -> None:
        super().__init__("Document content exceeds the bounded indexing envelope.")


TextEmbeddingBatch = Callable[[list[str]], tuple[str, Sequence[Sequence[float]]]]


def _is_document_source_kind(value: object) -> TypeGuard[DocumentSourceKind]:
    return isinstance(value, str) and value in {"web_article", "epub", "pdf"}


# =============================================================================
# Source snapshot → indexable blocks
# =============================================================================


def _text_quote(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - 64) : start_offset],
        "suffix": text_value[end_offset : min(len(text_value), end_offset + 64)],
    }


def _fragment_blocks(
    *,
    media_id: UUID,
    source_kind: str,
    fragments: Sequence[Mapping[Any, Any]],
    blocks_by_fragment: dict[UUID, list[Mapping[Any, Any]]],
) -> list[IndexableBlock]:
    """Blocks for a fragment-backed document (web article or epub)."""
    blocks: list[IndexableBlock] = []
    source_offset = 0
    for fragment in sorted(fragments, key=lambda item: int(item["idx"])):
        fragment_id = UUID(str(fragment["id"]))
        fragment_idx = int(fragment["idx"])
        fragment_text = str(fragment["canonical_text"] or "")
        source_base = source_offset
        if source_kind == "web_article":
            html = str(fragment["html_sanitized"] or "")
            if add_heading_anchors(html, fragment_idx=fragment_idx) != html:
                # Source success owns deterministic heading normalization before
                # it requests an index revision.
                raise AssertionError("web source fragment is missing Nexus heading anchors")
            for spec in build_web_article_index_blocks(
                html_sanitized=html, canonical_text=fragment_text, fragment_idx=fragment_idx
            ):
                locator: dict[str, object] = {
                    "type": "web_text_offsets",
                    "kind": "web_text",
                    "fragment_id": str(fragment_id),
                    "fragment_idx": fragment_idx,
                    "start_offset": spec.start_offset,
                    "end_offset": spec.end_offset,
                    "text_quote": _text_quote(fragment_text, spec.start_offset, spec.end_offset),
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
                    IndexableBlock(
                        owner=IndexOwner("media", media_id),
                        source_kind=source_kind,
                        block_idx=len(blocks),
                        block_kind=spec.block_kind,
                        canonical_text=fragment_text[spec.start_offset : spec.end_offset],
                        source_start_offset=source_base + spec.start_offset,
                        source_end_offset=source_base + spec.end_offset,
                        locator=locator,
                        heading_path=spec.heading_path,
                    )
                )
            source_offset += len(fragment_text) + 2
            continue

        rows = blocks_by_fragment.get(fragment_id) or [
            {"start_offset": 0, "end_offset": len(fragment_text)}
        ]
        for row in rows:
            start = int(row["start_offset"])
            end = int(row["end_offset"])
            blocks.append(
                IndexableBlock(
                    owner=IndexOwner("media", media_id),
                    source_kind=source_kind,
                    block_idx=len(blocks),
                    block_kind="paragraph",
                    canonical_text=fragment_text[start:end],
                    source_start_offset=source_base + start,
                    source_end_offset=source_base + end,
                    locator={
                        "kind": "epub_text" if source_kind == "epub" else "web_text",
                        "fragment_id": str(fragment_id),
                        "fragment_idx": fragment_idx,
                        "start_offset": start,
                        "end_offset": end,
                        "text_quote": _text_quote(fragment_text, start, end),
                    },
                    heading_path=(),
                )
            )
        source_offset += len(fragment_text) + 2
    return blocks


def build_transcript_indexable_blocks(
    *, media_id: UUID, transcript_segments: Sequence[TranscriptSegmentInput]
) -> list[IndexableBlock]:
    """Blocks for a transcript: one per timed segment, in playback order."""
    blocks: list[IndexableBlock] = []
    source_offset = 0
    for segment in transcript_segments:
        text_value = segment.canonical_text.strip()
        if not text_value or segment.t_end_ms <= segment.t_start_ms:
            continue
        if blocks:
            source_offset += 2
        blocks.append(
            IndexableBlock(
                owner=IndexOwner("media", media_id),
                source_kind="transcript",
                block_idx=len(blocks),
                block_kind="transcript_segment",
                canonical_text=text_value,
                source_start_offset=source_offset,
                source_end_offset=source_offset + len(text_value),
                locator={
                    "kind": "transcript_time_text",
                    "t_start_ms": segment.t_start_ms,
                    "t_end_ms": segment.t_end_ms,
                    "text_quote": {"exact": text_value, "prefix": "", "suffix": ""},
                },
                heading_path=(),
            )
        )
        source_offset += len(text_value)
    return blocks


def _positive_dimension(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    if number <= 0:
        raise ValueError("PDF page span dimensions must be positive")
    return number


def _pdf_blocks(
    *, media_id: UUID, plain_text: str, page_spans: Sequence[Mapping[Any, Any]]
) -> list[IndexableBlock]:
    """Blocks for a PDF: one per page span of the extracted plain text."""
    blocks: list[IndexableBlock] = []
    for page in page_spans:
        page_number = int(page["page_number"])
        start = int(page["start_offset"])
        end = int(page["end_offset"])
        if page_number < 1 or start < 0 or end < start:
            raise ValueError("PDF page span offsets are invalid")
        page_text = plain_text[start:end]
        page_label = str(page["page_label"]) if page["page_label"] else None
        locator: dict[str, object] = {
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
        width = _positive_dimension(page["page_width"])
        height = _positive_dimension(page["page_height"])
        if width is not None and height is not None:
            locator["geometry"] = {
                "coordinate_space": "pdf_points",
                "page_width": width,
                "page_height": height,
                "page_rotation_degrees": int(page["page_rotation_degrees"] or 0),
                "page_box": "crop",
                "quads": [],
            }
        blocks.append(
            IndexableBlock(
                owner=IndexOwner("media", media_id),
                source_kind="pdf",
                block_idx=len(blocks),
                block_kind="pdf_text_block",
                canonical_text=page_text,
                source_start_offset=start,
                source_end_offset=end,
                locator=locator,
                heading_path=(f"p. {page_label or page_number}",),
            )
        )
    return blocks


def _snapshot_media_blocks(
    db: Session, *, media_id: UUID, source_kind: str, plain_text: str
) -> list[IndexableBlock]:
    """Read one immutable source snapshot for the media's document kind."""
    if source_kind == "pdf":
        pages = (
            db.execute(
                text(
                    """
                    SELECT page_number, start_offset, end_offset, page_label,
                           page_width, page_height, page_rotation_degrees
                    FROM pdf_page_text_spans
                    WHERE media_id = :media_id
                    ORDER BY page_number ASC
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .all()
        )
        spans: Sequence[Mapping[Any, Any]] = pages
        if not pages and plain_text:
            spans = [
                {
                    "page_number": 1,
                    "start_offset": 0,
                    "end_offset": len(plain_text),
                    "page_label": None,
                    "page_width": None,
                    "page_height": None,
                    "page_rotation_degrees": None,
                }
            ]
        return _pdf_blocks(media_id=media_id, plain_text=plain_text, page_spans=spans)

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
    blocks_by_fragment: dict[UUID, list[Mapping[Any, Any]]] = {}
    fragment_ids = [UUID(str(fragment["id"])) for fragment in fragments]
    if fragment_ids:
        rows = (
            db.execute(
                text(
                    """
                    SELECT fragment_id, block_idx, start_offset, end_offset
                    FROM fragment_blocks
                    WHERE fragment_id = ANY(:fragment_ids)
                    ORDER BY fragment_id ASC, block_idx ASC
                    """
                ),
                {"fragment_ids": fragment_ids},
            )
            .mappings()
            .all()
        )
        for row in rows:
            blocks_by_fragment.setdefault(row["fragment_id"], []).append(row)
    return _fragment_blocks(
        media_id=media_id,
        source_kind=source_kind,
        fragments=fragments,
        blocks_by_fragment=blocks_by_fragment,
    )


def _validate_blocks(
    *, owner: IndexOwner, source_kind: str, blocks: Sequence[IndexableBlock]
) -> None:
    """The one check the locator resolver depends on: each block's quote is its
    own text, and the block offsets tile the source without gap or overlap."""
    if source_kind not in _SOURCE_KINDS:
        raise ValueError(f"Unsupported source_kind: {source_kind}")
    previous_end: int | None = None
    for expected_idx, block in enumerate(blocks):
        if block.owner != owner or block.source_kind != source_kind:
            raise ValueError("IndexableBlock does not belong to this materialization")
        if block.block_idx != expected_idx:
            raise ValueError("IndexableBlock rows must be contiguous and ordered")
        if block.source_start_offset < 0 or (
            block.source_end_offset - block.source_start_offset != len(block.canonical_text)
        ):
            raise ValueError("IndexableBlock source offsets do not match canonical_text")
        if previous_end is not None and block.source_start_offset < previous_end:
            raise ValueError("IndexableBlock offsets must be sorted and non-overlapping")
        previous_end = block.source_end_offset
        quote = block.locator.get("text_quote")
        if not isinstance(quote, dict) or quote.get("exact") != block.canonical_text:
            raise ValueError("IndexableBlock text_quote exact does not match its text")


# =============================================================================
# Chunking: never across a locator anchor, so every chunk has one citable spot
# =============================================================================


def _block_pieces(text_value: str) -> Iterator[tuple[int, int, int]]:
    """Sliding token windows over one block: ``(start, end, token_count)``."""
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
    if previous_block is None or previous_block.source_end_offset == block.source_start_offset:
        return ""
    return "\n\n"


def _same_locator_anchor(left: IndexableBlock, right: IndexableBlock) -> bool:
    """Two blocks may share a chunk only inside one citable anchor."""
    kind = left.locator.get("kind")
    if kind != right.locator.get("kind"):
        return False
    if kind in ("web_text", "epub_text"):
        return left.locator.get("fragment_id") == right.locator.get("fragment_id")
    if kind == "pdf_text":
        return left.locator.get("page_number") == right.locator.get("page_number")
    if kind == "transcript_time_text":
        return left.locator.get("t_start_ms") == right.locator.get(
            "t_start_ms"
        ) and left.locator.get("t_end_ms") == right.locator.get("t_end_ms")
    if kind == "note_text":
        # Anchoring on note_block_id forbids cross-block coalescing: every note
        # chunk stays inside one block and stays citable to it.
        return left.locator.get("note_block_id") == right.locator.get("note_block_id")
    raise ValueError(f"Unsupported locator kind: {kind}")


def _iter_chunk_parts(
    blocks: Sequence[IndexableBlock],
) -> Iterator[list[tuple[IndexableBlock, int, int, int]]]:
    """Yield one chunk descriptor at a time, never retaining a second corpus."""
    parts: list[tuple[IndexableBlock, int, int, int]] = []
    tokens = 0
    for block in blocks:
        for start_offset, end_offset, token_count in _block_pieces(block.canonical_text):
            if token_count == 0:
                continue
            if parts:
                previous_block, _, previous_end, _ = parts[-1]
                if (
                    tokens + token_count > CHUNK_MAX_TOKENS
                    or not _same_locator_anchor(previous_block, block)
                    or previous_end != len(previous_block.canonical_text)
                    or start_offset != 0
                    or _separator_before(previous_block, block) != ""
                ):
                    yield parts
                    parts = []
                    tokens = 0
            parts.append((block, start_offset, end_offset, token_count))
            tokens += token_count
    if parts:
        yield parts


def _chunk_text(parts: Sequence[tuple[IndexableBlock, int, int, int]]) -> str:
    pieces: list[str] = []
    previous_block: IndexableBlock | None = None
    for block, start_offset, end_offset, _ in parts:
        pieces.append(_separator_before(previous_block, block))
        pieces.append(block.canonical_text[start_offset:end_offset])
        previous_block = block
    return "".join(pieces)


def _chunk_locator(
    parts: Sequence[tuple[IndexableBlock, int, int, int]], chunk_text: str
) -> dict[str, object]:
    """Widen the first block's locator to cover the whole chunk."""
    first_block, first_start, _, _ = parts[0]
    last_block, _, last_end, _ = parts[-1]
    locator = dict(first_block.locator)
    locator["text_quote"] = {"exact": chunk_text, "prefix": "", "suffix": ""}
    kind = locator.get("kind")

    if kind in ("web_text", "epub_text"):
        if all(
            block.locator.get("fragment_id") == first_block.locator.get("fragment_id")
            for block, _, _, _ in parts
        ):
            locator["start_offset"] = _offset(first_block, "start_offset") + first_start
            locator["end_offset"] = _offset(last_block, "start_offset") + last_end
    elif kind == "pdf_text":
        if all(
            block.locator.get("page_number") == first_block.locator.get("page_number")
            for block, _, _, _ in parts
        ):
            page_start = _offset(first_block, "page_text_start_offset") + first_start
            locator["page_text_start_offset"] = page_start
            locator["page_text_end_offset"] = (
                _offset(last_block, "page_text_start_offset") + last_end
            )
            locator["plain_text_start_offset"] = (
                _offset(first_block, "plain_text_start_offset") + first_start
            )
            locator["plain_text_end_offset"] = (
                _offset(last_block, "plain_text_start_offset") + last_end
            )
            geometry = locator.get("geometry")
            if isinstance(geometry, dict) and geometry.get("quads") == []:
                projected = _projected_quads(
                    geometry, page_start, _offset(first_block, "page_text_end_offset")
                )
                if projected is not None:
                    locator["geometry"] = projected
    elif kind == "transcript_time_text":
        locator["t_start_ms"] = first_block.locator.get("t_start_ms")
        locator["t_end_ms"] = last_block.locator.get("t_end_ms")
    elif kind == "note_text":
        # Single-block by construction: first_block is last_block.
        block_start = _offset(first_block, "start_offset")
        locator["start_offset"] = block_start + first_start
        locator["end_offset"] = block_start + last_end
    else:
        raise ValueError(f"Unsupported locator kind: {kind}")
    return locator


def _offset(block: IndexableBlock, key: str) -> int:
    return int(str(block.locator.get(key) or 0))


def _projected_quads(
    geometry: dict[str, object], page_start: int, full_page_end: int
) -> dict[str, object] | None:
    """Approximate the chunk's band on the page from its text offsets."""
    width = geometry.get("page_width")
    height = geometry.get("page_height")
    if (
        full_page_end <= 0
        or not isinstance(width, int | float)
        or not isinstance(height, int | float)
    ):
        return None
    page_width = float(width)
    page_height = float(height)
    top = max(0.0, min(page_height, page_height * page_start / full_page_end))
    bottom = min(page_height, top + max(8.0, min(18.0, page_height / 60.0)))
    if bottom <= top:
        return None
    inset = min(48.0, page_width * 0.08)
    return {
        **geometry,
        "projection": "proportional_text_offsets",
        "quads": [
            {
                "x1": inset,
                "y1": top,
                "x2": page_width - inset,
                "y2": top,
                "x3": page_width - inset,
                "y3": bottom,
                "x4": inset,
                "y4": bottom,
            }
        ],
    }


# =============================================================================
# Embedding, and the local spool the document path streams through
# =============================================================================


def _iter_planned_chunks(
    *,
    blocks: Sequence[IndexableBlock],
    embedding_model: str,
    embedding_dimensions: int,
    maximum_chunk_bytes: int | None,
    embed_texts: TextEmbeddingBatch,
) -> Iterator[PlannedContentChunk]:
    """Yield every planned chunk, embedding them in bounded batches."""
    batch: list[list[tuple[IndexableBlock, int, int, int]]] = []
    for parts in _iter_chunk_parts(blocks):
        batch.append(parts)
        if len(batch) == CONTENT_INDEX_EMBEDDING_BATCH_SIZE:
            yield from _plan_batch(
                batch, embedding_model, embedding_dimensions, maximum_chunk_bytes, embed_texts
            )
            batch = []
    if batch:
        yield from _plan_batch(
            batch, embedding_model, embedding_dimensions, maximum_chunk_bytes, embed_texts
        )


def _plan_batch(
    batch: Sequence[list[tuple[IndexableBlock, int, int, int]]],
    embedding_model: str,
    embedding_dimensions: int,
    maximum_chunk_bytes: int | None,
    embed_texts: TextEmbeddingBatch,
) -> list[PlannedContentChunk]:
    """Embed one bounded batch and keep vectors in pgvector's float32 shape."""
    texts = [_chunk_text(parts) for parts in batch]
    if maximum_chunk_bytes is not None and any(
        utf8_byte_length(chunk_text) > maximum_chunk_bytes for chunk_text in texts
    ):
        raise ContentIndexResourceLimitExceeded()
    returned_model, embeddings = embed_texts(texts)
    if returned_model != embedding_model:
        raise ValueError("Embedding model changed during content indexing")
    if len(embeddings) != len(batch):
        raise ValueError("Embedding count does not match chunk count")
    planned: list[PlannedContentChunk] = []
    for parts, chunk_text, embedding in zip(batch, texts, embeddings, strict=True):
        if len(embedding) != embedding_dimensions:
            raise ValueError("Embedding dimensions do not match configured dimensions")
        planned.append(
            PlannedContentChunk(
                parts=tuple(parts),
                text=chunk_text,
                locator=_chunk_locator(parts, chunk_text),
                embedding_f32=array("f", [float(value) for value in embedding]).tobytes(),
            )
        )
    return planned


def _write_spool_record(spool: BinaryIO, chunk: PlannedContentChunk, *, written_bytes: int) -> int:
    """Append one JSONL record, holding the document to its size envelope."""
    record = {
        "embedding_f32": base64.b64encode(chunk.embedding_f32).decode("ascii"),
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
    encoded = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
    if (
        len(encoded) > _SPOOL_RECORD_MAX_BYTES
        or written_bytes + len(encoded) > CONTENT_INDEX_SPOOL_MAX_BYTES
    ):
        raise ContentIndexResourceLimitExceeded()
    spool.write(encoded)
    return written_bytes + len(encoded)


def _plan_chunks(plan: ContentIndexPlan | SpooledContentIndexPlan) -> Iterator[PlannedContentChunk]:
    """The one chunk iterator over either plan shape."""
    if isinstance(plan, ContentIndexPlan):
        yield from plan.chunks
        return
    with plan.spool_path.open("rb") as spool:
        for line in spool:
            record: dict[str, Any] = json.loads(line)
            yield PlannedContentChunk(
                parts=tuple(
                    (
                        plan.blocks[part["block_idx"]],
                        part["start_offset"],
                        part["end_offset"],
                        part["token_count"],
                    )
                    for part in record["parts"]
                ),
                text=record["text"],
                locator=record["locator"],
                embedding_f32=base64.b64decode(record["embedding_f32"]),
            )


def plan_content_index(
    *, owner: IndexOwner, source_kind: str, blocks: list[IndexableBlock]
) -> ContentIndexPlan:
    """Build and embed one complete materialization with no database access."""
    _validate_blocks(owner=owner, source_kind=source_kind, blocks=blocks)
    model = current_transcript_embedding_model()
    dimensions = transcript_embedding_dimensions()
    return ContentIndexPlan(
        owner=owner,
        source_kind=source_kind,
        blocks=tuple(blocks),
        chunks=tuple(
            _iter_planned_chunks(
                blocks=blocks,
                embedding_model=model,
                embedding_dimensions=dimensions,
                maximum_chunk_bytes=None,
                embed_texts=build_text_embeddings,
            )
        ),
        embedding_provider=current_transcript_embedding_provider(),
        embedding_model=model,
        embedding_dimensions=dimensions,
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
    block_list = list(blocks)
    _validate_blocks(owner=owner, source_kind=source_kind, blocks=block_list)
    model = current_transcript_embedding_model()
    dimensions = transcript_embedding_dimensions()
    written_bytes = 0
    chunk_count = 0
    try:
        with spool_path.open("xb") as spool:
            for chunk in _iter_planned_chunks(
                blocks=block_list,
                embedding_model=model,
                embedding_dimensions=dimensions,
                maximum_chunk_bytes=CONTENT_INDEX_CHUNK_MAX_BYTES,
                embed_texts=embed_texts,
            ):
                written_bytes = _write_spool_record(spool, chunk, written_bytes=written_bytes)
                chunk_count += 1
    except Exception:
        spool_path.unlink(missing_ok=True)
        raise
    return SpooledContentIndexPlan(
        owner=owner,
        source_kind=source_kind,
        blocks=tuple(block_list),
        spool_path=spool_path,
        chunk_count=chunk_count,
        embedding_provider=current_transcript_embedding_provider(),
        embedding_model=model,
        embedding_dimensions=dimensions,
    )


# =============================================================================
# Publication: one transaction replaces the whole materialization
# =============================================================================


def publish_content_index(
    db: Session, *, plan: ContentIndexPlan | SpooledContentIndexPlan, reason: str
) -> ContentIndexResult:
    """Replace one complete materialization inside the caller's transaction."""
    now = datetime.now(UTC)
    replace_content_index_materialization(db, owner=plan.owner)
    owner_params = {"owner_kind": plan.owner.kind, "owner_id": plan.owner.id}

    block_ids: list[UUID] = []
    for block in plan.blocks:
        block_ids.append(
            db.execute(
                text(
                    """
                    INSERT INTO content_blocks (owner_kind, owner_id, block_idx, block_kind,
                        canonical_text, heading_path, locator, created_at)
                    VALUES (:owner_kind, :owner_id, :block_idx, :block_kind, :canonical_text,
                        CAST(:heading_path AS jsonb), CAST(:locator AS jsonb), :now)
                    RETURNING id
                    """
                ),
                {
                    **owner_params,
                    "block_idx": block.block_idx,
                    "block_kind": block.block_kind,
                    "canonical_text": block.canonical_text,
                    "heading_path": json.dumps(list(block.heading_path)),
                    "locator": json.dumps(block.locator),
                    "now": now,
                },
            ).scalar_one()
        )

    chunks = iter(_plan_chunks(plan))
    first_chunk = next(chunks, None)
    if first_chunk is None:
        _set_index_state(db, owner=plan.owner, status="no_text", reason="no_text", now=now)
        return ContentIndexResult(owner=plan.owner, status="no_text", chunk_count=0)

    published = 0
    for chunk_idx, chunk in enumerate(chain((first_chunk,), chunks)):
        published += 1
        first_block, first_start, _, _ = chunk.parts[0]
        last_block, _, last_end, _ = chunk.parts[-1]
        span_id = db.execute(
            text(
                """
                INSERT INTO evidence_spans (owner_kind, owner_id, start_block_id, end_block_id,
                    start_block_offset, end_block_offset, span_text, selector, citation_label,
                    resolver_kind, created_at)
                VALUES (:owner_kind, :owner_id, :start_block_id, :end_block_id,
                    :start_block_offset, :end_offset, :span_text, CAST(:selector AS jsonb),
                    :citation_label, :resolver_kind, :now)
                RETURNING id
                """
            ),
            {
                **owner_params,
                "start_block_id": block_ids[first_block.block_idx],
                "end_block_id": block_ids[last_block.block_idx],
                "start_block_offset": first_start,
                "end_offset": last_end,
                "span_text": chunk.text,
                "selector": json.dumps(chunk.locator),
                "citation_label": (
                    str(first_block.heading_path[-1]) if first_block.heading_path else "Source"
                ),
                "resolver_kind": _RESOLVER_KINDS[plan.source_kind],
                "now": now,
            },
        ).scalar_one()
        chunk_id = db.execute(
            text(
                """
                INSERT INTO content_chunks (owner_kind, owner_id, primary_evidence_span_id,
                    chunk_idx, source_kind, chunk_text, heading_path, summary_locator, created_at)
                VALUES (:owner_kind, :owner_id, :evidence_span_id, :chunk_idx, :source_kind,
                    :chunk_text, CAST(:heading_path AS jsonb),
                    CAST(:summary_locator AS jsonb), :now)
                RETURNING id
                """
            ),
            {
                **owner_params,
                "evidence_span_id": span_id,
                "chunk_idx": chunk_idx,
                "source_kind": plan.source_kind,
                "chunk_text": chunk.text,
                "heading_path": json.dumps(list(first_block.heading_path)),
                "summary_locator": json.dumps(chunk.locator),
                "now": now,
            },
        ).scalar_one()
        vector = array("f")
        vector.frombytes(chunk.embedding_f32)
        db.execute(
            text(
                f"""
                INSERT INTO content_embeddings (chunk_id, embedding_provider, embedding_model,
                    embedding_dimensions, embedding_vector, created_at)
                VALUES (:chunk_id, :embedding_provider, :embedding_model, :embedding_dimensions,
                    CAST(:embedding_vector AS vector({plan.embedding_dimensions})), :now)
                """
            ),
            {
                "chunk_id": chunk_id,
                "embedding_provider": plan.embedding_provider,
                "embedding_model": plan.embedding_model,
                "embedding_dimensions": plan.embedding_dimensions,
                "embedding_vector": to_pgvector_literal(list(vector)),
                "now": now,
            },
        )

    _set_index_state(
        db,
        owner=plan.owner,
        status="ready",
        reason=reason,
        now=now,
        embedding_provider=plan.embedding_provider,
        embedding_model=plan.embedding_model,
    )
    # Every text-bearing media source funnels through this ready branch, so the
    # per-media unit (re)build is enqueued here once, in the caller's
    # transaction. Notes carry no media unit.
    if plan.owner.kind == "media":
        media_intelligence_lifecycle.ensure_media_unit_in_tx(db, media_id=plan.owner.id)
    return ContentIndexResult(owner=plan.owner, status="ready", chunk_count=published)


def rebuild_content_index(
    db: Session, *, owner: IndexOwner, source_kind: str, blocks: list[IndexableBlock], reason: str
) -> ContentIndexResult:
    """The synchronous note doorway; media plan and publish in separate jobs."""
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


def replace_content_index_materialization(db: Session, *, owner: IndexOwner) -> None:
    """Delete the replaceable index rows, retaining the owner's state identity."""
    params = {"owner_kind": owner.kind, "owner_id": owner.id}
    # The per-media unit's claims reference these evidence_spans with a
    # non-cascading FK; clear them through their sole owner before the spans go.
    if owner.kind == "media":
        media_intelligence_lifecycle.clear_media_claims_for_reindex(db, media_id=owner.id)
    db.execute(
        text(
            """
            UPDATE message_retrievals mr
            SET evidence_span_id = NULL
            FROM evidence_spans es
            WHERE mr.evidence_span_id = es.id
              AND es.owner_kind = :owner_kind AND es.owner_id = :owner_id
            """
        ),
        params,
    )
    # Graph cleanup, set-batched over every destroyed span/chunk: bare edges die
    # with the row, cited edges keep rendering from their snapshots and the jump
    # fails closed. Two DELETEs, not N+1 — this is a hot reindex path.
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
    for table in ("content_chunks", "evidence_spans", "content_blocks"):
        db.execute(
            text(f"DELETE FROM {table} WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
            params,
        )


def _set_index_state(
    db: Session,
    *,
    owner: IndexOwner,
    status: str,
    reason: str | None,
    now: datetime,
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
) -> None:
    """Upsert the owner's index state; only ``ready`` carries an active model."""
    db.execute(
        text(
            """
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason,
                active_embedding_provider, active_embedding_model, updated_at, created_at)
            VALUES (:owner_kind, :owner_id, :status, :status_reason, :embedding_provider,
                :embedding_model, :now, :now)
            ON CONFLICT ON CONSTRAINT uq_content_index_states_owner DO UPDATE
            SET status = EXCLUDED.status,
                status_reason = EXCLUDED.status_reason,
                active_embedding_provider = EXCLUDED.active_embedding_provider,
                active_embedding_model = EXCLUDED.active_embedding_model,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "owner_kind": owner.kind,
            "owner_id": owner.id,
            "status": status,
            "status_reason": reason,
            "embedding_provider": embedding_provider if status == "ready" else None,
            "embedding_model": embedding_model if status == "ready" else None,
            "now": now,
        },
    )


def mark_content_index_pending(db: Session, *, owner: IndexOwner, reason: str) -> None:
    """Gate an owner out of search without deleting its rows; the reindex job
    rebuilds and flips it back to ready."""
    _set_index_state(db, owner=owner, status="pending", reason=reason, now=datetime.now(UTC))


def deactivate_content_index(db: Session, *, owner: IndexOwner, reason: str) -> None:
    """Drop the materialization but keep the state row, so ``revision`` stays
    monotonic across source refreshes and no obsolete worker can publish again."""
    replace_content_index_materialization(db, owner=owner)
    _set_index_state(db, owner=owner, status="pending", reason=reason, now=datetime.now(UTC))


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


# =============================================================================
# The media reindex lifecycle, fenced on a monotonic revision
# =============================================================================


def _record_index_event(db: Session, *, media_id: UUID, facts: IndexFacts) -> None:
    append_processing_event(
        db, media_id=media_id, facts=facts, stage=present("Index"), failure_code=absent()
    )


def _lock_media(db: Session, media_id: UUID) -> None:
    """Hold the media row for a transaction that goes on to lock its queue rows.

    ``FOR NO KEY UPDATE`` admits the ``KEY SHARE`` the worker's history insert
    takes on this row inside its own queue transition, so a transition and a
    media-locked caller never wait on each other.
    """
    db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR NO KEY UPDATE"),
        {"media_id": media_id},
    ).scalar_one()


def _lock_index_revision(db: Session, media_id: UUID) -> int | None:
    row = db.execute(
        text(
            """
            SELECT revision FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).scalar_one_or_none()
    return None if row is None else int(row)


def _reindex_payload(
    *, media_id: UUID, revision: int, reason: str, request_id: str | None
) -> dict[str, object]:
    return {
        "media_id": str(media_id),
        "revision": revision,
        "reason": reason,
        "request_id": (
            {"kind": "Absent"} if request_id is None else {"kind": "Present", "value": request_id}
        ),
    }


def request_media_content_reindex(
    db: Session, *, media_id: UUID, reason: str, request_id: str | None
) -> MediaContentReindexIntent:
    """Raise the index revision and leave exactly one waiting job for it."""
    from nexus.jobs.queue import (
        enqueue_job,
        lock_jobs_for_payload,
        reset_unclaimed_job_for_new_intent,
        supersede_unclaimed_job,
    )
    from nexus.jobs.registry import get_default_registry

    _lock_media(db, media_id)
    current = _lock_index_revision(db, media_id)
    if current is None:
        db.execute(
            text(
                """
                INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason,
                    active_embedding_provider, active_embedding_model, revision,
                    updated_at, created_at)
                VALUES ('media', :media_id, 'pending', :reason, NULL, NULL, 0, now(), now())
                """
            ),
            {"media_id": media_id, "reason": reason},
        )
        current = 0
    revision = current + 1
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET revision = :revision, status = 'pending', status_reason = :reason,
                active_embedding_provider = NULL, active_embedding_model = NULL,
                updated_at = now()
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id, "revision": revision, "reason": reason},
    )

    definition = get_default_registry()[MEDIA_CONTENT_REINDEX_JOB_KIND]
    payload = _reindex_payload(
        media_id=media_id, revision=revision, reason=reason, request_id=request_id
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
            supersede_unclaimed_job(db, job_id=obsolete.id, kind=MEDIA_CONTENT_REINDEX_JOB_KIND)
    else:
        selected = enqueue_job(
            db,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            payload=payload,
            max_attempts=definition.max_attempts,
        )
    _record_index_event(
        db, media_id=media_id, facts=IndexAccepted(revision=revision, job_id=selected.id)
    )
    return MediaContentReindexIntent(revision, selected.id, False, not waiting)


def ensure_media_content_reindex_job(
    db: Session, *, media_id: UUID, reason: str, request_id: str | None
) -> MediaContentReindexIntent:
    """Ensure the current revision owns a queue row, without raising it."""
    from nexus.jobs.queue import enqueue_job, lock_jobs_for_payload
    from nexus.jobs.registry import get_default_registry

    _lock_media(db, media_id)
    revision = _lock_index_revision(db, media_id)
    if revision is None:
        raise AssertionError("cannot ensure a job without a media content-index state")

    jobs = [
        job
        for job in lock_jobs_for_payload(
            db,
            kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
            expected_payload_match={"media_id": str(media_id)},
        )
        if int(job.payload["revision"]) == revision
    ]
    waiting = next(
        (job for job in jobs if job.status in {"pending", "failed"} and job.claimed_by is None),
        None,
    )
    if waiting is not None:
        return MediaContentReindexIntent(revision, waiting.id, False, False)
    running = next((job for job in jobs if job.status == "running"), None)
    if running is not None:
        return MediaContentReindexIntent(revision, running.id, False, False)
    dead = next((job for job in jobs if job.status == "dead"), None)
    if dead is not None:
        return MediaContentReindexIntent(revision, dead.id, True, False)

    definition = get_default_registry()[MEDIA_CONTENT_REINDEX_JOB_KIND]
    inserted = enqueue_job(
        db,
        kind=MEDIA_CONTENT_REINDEX_JOB_KIND,
        payload=_reindex_payload(
            media_id=media_id, revision=revision, reason=reason, request_id=request_id
        ),
        max_attempts=definition.max_attempts,
    )
    _record_index_event(
        db, media_id=media_id, facts=IndexAccepted(revision=revision, job_id=inserted.id)
    )
    return MediaContentReindexIntent(revision, inserted.id, False, True)


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
    from nexus.jobs.queue import lock_and_renew_running_job_claim

    media = (
        db.execute(
            text(
                """
                SELECT id, kind, processing_status, plain_text FROM media
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
        raise AssertionError("media content-reindex owner kind is ineligible")
    current = _lock_index_revision(db, media_id)
    if current is None:
        return None
    job = lock_and_renew_running_job_claim(db, context=context, lease_seconds=lease_seconds)
    if job is None:
        return None
    if current != revision:
        _record_index_event(
            db,
            media_id=media_id,
            facts=IndexSuperseded(
                revision=revision, job_id=job.id, execution_id=context.execution_id
            ),
        )
        return None
    if media["processing_status"] != "ready_for_reading":
        raise AssertionError("media content-reindex owner is not readable")
    _record_index_event(
        db,
        media_id=media_id,
        facts=IndexExecutionStarted(
            revision=revision, job_id=job.id, execution_id=context.execution_id
        ),
    )
    blocks = _snapshot_media_blocks(
        db,
        media_id=media_id,
        source_kind=source_kind,
        plain_text=str(media["plain_text"] or ""),
    )
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET status = 'indexing', status_reason = :reason, active_embedding_provider = NULL,
                active_embedding_model = NULL, updated_at = now()
            WHERE owner_kind = 'media' AND owner_id = :media_id AND revision = :revision
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
    """Re-check the fence, then atomically publish one current revision."""
    from nexus.jobs.queue import lock_and_renew_running_job_claim

    media = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR NO KEY UPDATE"),
        {"media_id": work.media_id},
    ).scalar_one_or_none()
    if media is None:
        return None
    current = _lock_index_revision(db, work.media_id)
    if current is None:
        return None
    job = lock_and_renew_running_job_claim(db, context=context, lease_seconds=lease_seconds)
    if job is None:
        return None
    if current != work.revision:
        _record_index_event(
            db,
            media_id=work.media_id,
            facts=IndexSuperseded(
                revision=work.revision, job_id=job.id, execution_id=context.execution_id
            ),
        )
        return None

    result = publish_content_index(db, plan=plan, reason=work.reason)
    _record_index_event(
        db,
        media_id=work.media_id,
        facts=IndexSucceeded(
            revision=work.revision, job_id=job.id, execution_id=context.execution_id
        ),
    )
    chunk_count = len(plan.chunks) if isinstance(plan, ContentIndexPlan) else plan.chunk_count
    if work.source_kind == "pdf" and chunk_count == 0:
        db.execute(
            text(
                """
                UPDATE content_index_states
                SET status = 'ocr_required', status_reason = 'ocr_required',
                    active_embedding_provider = NULL, active_embedding_model = NULL,
                    updated_at = now()
                WHERE owner_kind = 'media' AND owner_id = :media_id AND revision = :revision
                """
            ),
            {"media_id": work.media_id, "revision": work.revision},
        )
        return ContentIndexResult(result.owner, "ocr_required", 0)
    return result


# =============================================================================
# Repairing a dead reindex execution
# =============================================================================


@dataclass(frozen=True, slots=True)
class SearchRecoveryFacts:
    """The current index revision and, when its reindex job is dead, that job."""

    revision: int
    dead_job_id: UUID | None
    is_creator: bool
    is_operator: bool


def search_recovery(facts: SearchRecoveryFacts) -> SearchRecoveryAnswer:
    """The one recovery answer for a media's search-index obligation."""
    if facts.dead_job_id is None:
        return None
    if not (facts.is_creator or facts.is_operator):
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
    """Requeue the exact dead reindex job of the current index revision.

    Never touches source rows or the published materialization: repair repeats
    indexing, so a ``ready`` document keeps serving search until the rerun
    itself marks it indexing. Idempotent per ``client_mutation_id``.
    """
    scope = f"media_search_repair:{media_id}"
    request_bytes = canonical_json_bytes(
        {"expected_revision": expected_revision, "expected_job_id": str(expected_job_id)}
    )

    def admit() -> SearchRepairAdmission:
        match actor:
            case ViewerRecovery(viewer_id=viewer_id):
                if not can_read_media(db, viewer_id, media_id):
                    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
                creator_id = db.execute(
                    text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                ).scalar_one_or_none()
                if creator_id is None:
                    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
                if creator_id != viewer_id:
                    raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
                is_creator, is_operator = True, False
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
                is_creator, is_operator = False, True

        _lock_media(db, media_id)
        revision = _lock_index_revision(db, media_id)
        if revision is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no search index to repair."
            )
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
                is_operator=is_operator,
            )
        )
        if not isinstance(offer, RepairSearchOffer) or (
            offer.expected_revision,
            offer.expected_job_id,
        ) != (expected_revision, expected_job_id):
            current: dict[str, object] = {"revision": revision}
            if dead is not None:
                current["job_id"] = str(dead.id)
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected search index execution is no longer current.",
                details={"current": current},
            )
        requeue_dead_job(db, job_id=offer.expected_job_id)
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
            )
        db.commit()
        return admission

    return admit_serializable(db, "repair_dead_media_reindex", admit)
