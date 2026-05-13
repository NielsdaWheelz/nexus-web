"""Shared evidence indexing for text-bearing media."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeGuard
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.semantic_chunks import (
    build_text_embeddings,
    current_transcript_embedding_model,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)

CHUNKER_VERSION = "block_token_v2"
CHUNK_MAX_TOKENS = 420
CHUNK_OVERLAP_TOKENS = 60


@dataclass(frozen=True)
class SourceSnapshotSpec:
    artifact_kind: str
    artifact_ref: str
    content_type: str
    byte_length: int
    source_fingerprint: str
    content_sha256: str
    source_version: str
    extractor_version: str
    parent_snapshot_id: UUID | None
    language: str | None
    metadata: dict[str, object]


@dataclass(frozen=True)
class IndexableBlock:
    media_id: UUID
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
    run_id: UUID
    status: str
    chunk_count: int


def rebuild_media_content_index(
    db: Session,
    *,
    media_id: UUID,
    source_kind: str,
    source_snapshot: SourceSnapshotSpec,
    blocks: list[IndexableBlock],
    reason: str,
) -> ContentIndexResult:
    run_started_at = datetime.now(UTC)
    _validate_source_snapshot(source_snapshot)
    _validate_blocks(media_id=media_id, source_kind=source_kind, blocks=blocks)

    embedding_model = current_transcript_embedding_model()
    embedding_dimensions = transcript_embedding_dimensions()
    embedding_provider = "test" if embedding_model.startswith("test_") else "openai"
    embedding_version = embedding_model
    embedding_config_hash = hashlib.sha256(
        f"{embedding_provider}:{embedding_model}:{embedding_dimensions}:{CHUNKER_VERSION}".encode()
    ).hexdigest()

    text_blocks = [block for block in blocks if block.canonical_text.strip()]
    chunks: list[list[tuple[IndexableBlock, int, int, int]]] = []
    current_parts: list[tuple[IndexableBlock, int, int, int]] = []
    current_tokens = 0
    for block in text_blocks:
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
                    chunks.append(current_parts)
                    current_parts = []
                    current_tokens = 0
            current_parts.append((block, start_offset, end_offset, token_count))
            current_tokens += token_count
    if current_parts:
        chunks.append(current_parts)

    chunk_texts = [_chunk_text(chunk) for chunk in chunks]
    chunk_locators: list[dict[str, object]] = []
    for chunk_parts, chunk_text in zip(chunks, chunk_texts, strict=True):
        chunk_locator = _chunk_locator(chunk_parts, chunk_text)
        _validate_selector(
            source_kind,
            chunk_locator,
            chunk_text,
            context="content chunk summary locator",
        )
        chunk_locators.append(chunk_locator)

    embeddings: list[list[float]] = []
    if chunk_texts:
        returned_embedding_model, embeddings = build_text_embeddings(chunk_texts)
        if returned_embedding_model != embedding_model:
            raise ValueError("Embedding model changed during content indexing")
        if len(embeddings) != len(chunks):
            raise ValueError("Embedding count does not match chunk count")
        for embedding in embeddings:
            if len(embedding) != embedding_dimensions:
                raise ValueError("Embedding dimensions do not match configured dimensions")

    now = datetime.now(UTC)
    db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).scalar_one()
    previous_row = (
        db.execute(
            text(
                """
                SELECT
                    active_run.id AS active_run_id,
                    active_run.started_at AS active_started_at
                FROM media_content_index_states mcis
                LEFT JOIN content_index_runs active_run
                  ON active_run.id = mcis.active_run_id
                 AND active_run.state = 'ready'
                 AND active_run.deactivated_at IS NULL
                WHERE mcis.media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    previous_run_id = previous_row["active_run_id"] if previous_row is not None else None
    previous_started_at = previous_row["active_started_at"] if previous_row is not None else None
    active_run_is_newer = (
        previous_run_id is not None
        and previous_started_at is not None
        and previous_started_at > run_started_at
    )

    run_id = db.execute(
        text(
            """
            INSERT INTO content_index_runs (
                media_id,
                state,
                source_version,
                extractor_version,
                chunker_version,
                embedding_provider,
                embedding_model,
                embedding_version,
                embedding_config_hash,
                started_at,
                created_at
            )
            VALUES (
                :media_id,
                'indexing',
                :source_version,
                :extractor_version,
                :chunker_version,
                :embedding_provider,
                :embedding_model,
                :embedding_version,
                :embedding_config_hash,
                :started_at,
                :now
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "source_version": source_snapshot.source_version,
            "extractor_version": source_snapshot.extractor_version,
            "chunker_version": CHUNKER_VERSION,
            "embedding_provider": embedding_provider,
            "embedding_model": embedding_model,
            "embedding_version": embedding_version,
            "embedding_config_hash": embedding_config_hash,
            "started_at": run_started_at,
            "now": now,
        },
    ).scalar_one()

    if not active_run_is_newer:
        _set_index_state(
            db,
            media_id=media_id,
            latest_run_id=run_id,
            active_run_id=previous_run_id,
            status="indexing",
            status_reason=reason,
            embedding_provider=None,
            embedding_model=None,
            embedding_version=None,
            embedding_config_hash=None,
            now=now,
        )

    snapshot_id = db.execute(
        text(
            """
            INSERT INTO source_snapshots (
                media_id,
                index_run_id,
                source_kind,
                artifact_kind,
                artifact_ref,
                content_type,
                byte_length,
                source_fingerprint,
                source_version,
                extractor_version,
                content_sha256,
                parent_snapshot_id,
                language,
                metadata,
                created_at
            )
            VALUES (
                :media_id,
                :index_run_id,
                :source_kind,
                :artifact_kind,
                :artifact_ref,
                :content_type,
                :byte_length,
                :source_fingerprint,
                :source_version,
                :extractor_version,
                :content_sha256,
                :parent_snapshot_id,
                :language,
                CAST(:metadata AS jsonb),
                :now
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "index_run_id": run_id,
            "source_kind": source_kind,
            "artifact_kind": source_snapshot.artifact_kind,
            "artifact_ref": source_snapshot.artifact_ref,
            "content_type": source_snapshot.content_type,
            "byte_length": source_snapshot.byte_length,
            "source_fingerprint": source_snapshot.source_fingerprint,
            "source_version": source_snapshot.source_version,
            "extractor_version": source_snapshot.extractor_version,
            "content_sha256": source_snapshot.content_sha256,
            "parent_snapshot_id": source_snapshot.parent_snapshot_id,
            "language": source_snapshot.language,
            "metadata": json.dumps(source_snapshot.metadata),
            "now": now,
        },
    ).scalar_one()

    block_ids_by_idx: dict[int, UUID] = {}
    for expected_idx, block in enumerate(blocks):
        block_id = db.execute(
            text(
                """
                INSERT INTO content_blocks (
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    block_idx,
                    block_kind,
                    canonical_text,
                    text_sha256,
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
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :block_idx,
                    :block_kind,
                    :canonical_text,
                    :text_sha256,
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
                "media_id": media_id,
                "index_run_id": run_id,
                "source_snapshot_id": snapshot_id,
                "block_idx": block.block_idx,
                "block_kind": block.block_kind,
                "canonical_text": block.canonical_text,
                "text_sha256": _sha256(block.canonical_text),
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

    if not text_blocks:
        if previous_run_id is not None and not active_run_is_newer:
            db.execute(
                text(
                    """
                    UPDATE content_index_runs
                    SET deactivated_at = :now, superseded_by_run_id = :run_id
                    WHERE id = :previous_run_id
                      AND deactivated_at IS NULL
                    """
                ),
                {"previous_run_id": previous_run_id, "run_id": run_id, "now": now},
            )
        db.execute(
            text(
                """
                UPDATE content_index_runs
                SET state = 'no_text', finished_at = :now
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id, "now": now},
        )
        if active_run_is_newer:
            db.execute(
                text(
                    """
                    UPDATE content_index_runs
                    SET deactivated_at = :now, superseded_by_run_id = :previous_run_id
                    WHERE id = :run_id
                    """
                ),
                {"run_id": run_id, "previous_run_id": previous_run_id, "now": now},
            )
        else:
            _set_index_state(
                db,
                media_id=media_id,
                latest_run_id=run_id,
                active_run_id=None,
                status="no_text",
                status_reason="no_text",
                embedding_provider=None,
                embedding_model=None,
                embedding_version=None,
                embedding_config_hash=None,
                now=now,
            )
        return ContentIndexResult(run_id=run_id, status="no_text", chunk_count=0)

    db.execute(
        text("UPDATE content_index_runs SET state = 'embedding' WHERE id = :run_id"),
        {"run_id": run_id},
    )

    for chunk_idx, (chunk_parts, chunk_text, summary_locator, embedding) in enumerate(
        zip(chunks, chunk_texts, chunk_locators, embeddings, strict=True)
    ):
        first_block, first_start, _, _ = chunk_parts[0]
        last_block, _, last_end, _ = chunk_parts[-1]
        first_block_id = block_ids_by_idx[first_block.block_idx]
        last_block_id = block_ids_by_idx[last_block.block_idx]
        citation_label = str(first_block.heading_path[-1]) if first_block.heading_path else "Source"
        evidence_span_id = db.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    span_sha256,
                    selector,
                    citation_label,
                    resolver_kind,
                    created_at
                )
                VALUES (
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :start_block_id,
                    :end_block_id,
                    :start_block_offset,
                    :end_offset,
                    :span_text,
                    :span_sha256,
                    CAST(:selector AS jsonb),
                    :citation_label,
                    :resolver_kind,
                    :now
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "index_run_id": run_id,
                "source_snapshot_id": snapshot_id,
                "start_block_id": first_block_id,
                "end_block_id": last_block_id,
                "start_block_offset": first_start,
                "end_offset": last_end,
                "span_text": chunk_text,
                "span_sha256": _sha256(chunk_text),
                "selector": json.dumps(summary_locator),
                "citation_label": citation_label,
                "resolver_kind": _resolver_kind(source_kind),
                "now": now,
            },
        ).scalar_one()

        chunk_id = db.execute(
            text(
                """
                INSERT INTO content_chunks (
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    primary_evidence_span_id,
                    chunk_idx,
                    source_kind,
                    chunk_text,
                    chunk_sha256,
                    chunker_version,
                    token_count,
                    heading_path,
                    summary_locator,
                    created_at
                )
                VALUES (
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :evidence_span_id,
                    :chunk_idx,
                    :source_kind,
                    :chunk_text,
                    :chunk_sha256,
                    :chunker_version,
                    :token_count,
                    CAST(:heading_path AS jsonb),
                    CAST(:summary_locator AS jsonb),
                    :now
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "index_run_id": run_id,
                "source_snapshot_id": snapshot_id,
                "evidence_span_id": evidence_span_id,
                "chunk_idx": chunk_idx,
                "source_kind": source_kind,
                "chunk_text": chunk_text,
                "chunk_sha256": _sha256(chunk_text),
                "chunker_version": CHUNKER_VERSION,
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
                    embedding_version,
                    embedding_config_hash,
                    embedding_dimensions,
                    embedding_vector,
                    embedding_sha256,
                    created_at
                )
                VALUES (
                    :chunk_id,
                    :embedding_provider,
                    :embedding_model,
                    :embedding_version,
                    :embedding_config_hash,
                    :embedding_dimensions,
                    CAST(:embedding_vector AS vector({embedding_dimensions})),
                    :embedding_sha256,
                    :now
                )
                """
            ),
            {
                "chunk_id": chunk_id,
                "embedding_provider": embedding_provider,
                "embedding_model": embedding_model,
                "embedding_version": embedding_version,
                "embedding_config_hash": embedding_config_hash,
                "embedding_dimensions": embedding_dimensions,
                "embedding_vector": to_pgvector_literal(embedding),
                "embedding_sha256": _sha256(to_pgvector_literal(embedding)),
                "now": now,
            },
        )

    db.execute(
        text(
            """
            UPDATE content_index_runs
            SET state = 'ready',
                finished_at = :now,
                activated_at = CASE WHEN :active_run_is_newer THEN activated_at ELSE :now END,
                deactivated_at = CASE WHEN :active_run_is_newer THEN :now ELSE deactivated_at END,
                superseded_by_run_id = CASE
                    WHEN :active_run_is_newer THEN :previous_run_id
                    ELSE superseded_by_run_id
                END
            WHERE id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "previous_run_id": previous_run_id,
            "active_run_is_newer": active_run_is_newer,
            "now": now,
        },
    )
    if previous_run_id is not None and not active_run_is_newer:
        db.execute(
            text(
                """
                UPDATE content_index_runs
                SET deactivated_at = :now, superseded_by_run_id = :run_id
                WHERE id = :previous_run_id
                  AND deactivated_at IS NULL
                """
            ),
            {"previous_run_id": previous_run_id, "run_id": run_id, "now": now},
        )
    if not active_run_is_newer:
        _set_index_state(
            db,
            media_id=media_id,
            latest_run_id=run_id,
            active_run_id=run_id,
            status="ready",
            status_reason=reason,
            embedding_provider=embedding_provider,
            embedding_model=embedding_model,
            embedding_version=embedding_version,
            embedding_config_hash=embedding_config_hash,
            now=now,
        )
    return ContentIndexResult(run_id=run_id, status="ready", chunk_count=len(chunks))


def rebuild_fragment_content_index(
    db: Session,
    *,
    media_id: UUID,
    source_kind: str,
    artifact_ref: str,
    fragments: list[Any],
    reason: str,
    language: str | None = None,
) -> ContentIndexResult:
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

    blocks: list[IndexableBlock] = []
    joined_text_parts: list[str] = []
    source_offset = 0
    for fragment in sorted(fragments, key=lambda item: int(item.idx)):
        fragment_text = str(fragment.canonical_text or "")
        joined_text_parts.append(fragment_text)
        source_base = source_offset
        block_rows = db.execute(
            text(
                """
                SELECT block_idx, start_offset, end_offset
                FROM fragment_blocks
                WHERE fragment_id = :fragment_id
                ORDER BY block_idx ASC
                """
            ),
            {"fragment_id": fragment.id},
        ).fetchall()
        if not block_rows:
            block_rows = [(0, 0, len(fragment_text))]
        for row in block_rows:
            start_offset = int(row[1])
            end_offset = int(row[2])
            block_text = fragment_text[start_offset:end_offset]
            nav = nav_by_fragment_idx.get(int(fragment.idx), {})
            locator_kind = "epub_text" if source_kind == "epub" else "web_text"
            locator: dict[str, object] = {
                "kind": locator_kind,
                "version": 1,
                "fragment_id": str(fragment.id),
                "fragment_idx": int(fragment.idx),
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": _text_quote(fragment_text, start_offset, end_offset),
            }
            if nav:
                locator.update(nav)
            heading_path = (str(nav.get("label")),) if nav.get("label") else ()
            blocks.append(
                IndexableBlock(
                    media_id=media_id,
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

    joined_text = "\n\n".join(joined_text_parts)
    return rebuild_media_content_index(
        db,
        media_id=media_id,
        source_kind=source_kind,
        source_snapshot=SourceSnapshotSpec(
            artifact_kind="html" if source_kind == "web_article" else "xhtml",
            artifact_ref=artifact_ref,
            content_type="text/html" if source_kind == "web_article" else "application/xhtml+xml",
            byte_length=len(joined_text.encode("utf-8")),
            content_sha256=_sha256(joined_text),
            source_version="fragments_v1",
            extractor_version="fragment_blocks_v1",
            source_fingerprint=f"sha256:{_sha256(joined_text)}",
            parent_snapshot_id=None,
            language=language,
            metadata={},
        ),
        blocks=blocks,
        reason=reason,
    )


def rebuild_transcript_content_index(
    db: Session,
    *,
    media_id: UUID,
    transcript_version_id: UUID,
    transcript_segments: list[dict[str, Any]],
    reason: str,
) -> ContentIndexResult:
    blocks: list[IndexableBlock] = []
    joined_text_parts: list[str] = []
    source_offset = 0
    for segment in transcript_segments:
        text_value = str(segment.get("text") or "").strip()
        t_start_ms = segment.get("t_start_ms")
        t_end_ms = segment.get("t_end_ms")
        if not text_value or t_start_ms is None or t_end_ms is None:
            continue
        if int(t_end_ms) <= int(t_start_ms):
            continue
        if joined_text_parts:
            source_offset += 2
        joined_text_parts.append(text_value)
        locator = {
            "kind": "transcript_time_text",
            "version": 1,
            "transcript_version_id": str(transcript_version_id),
            "t_start_ms": int(t_start_ms),
            "t_end_ms": int(t_end_ms),
            "text_quote": {
                "exact": text_value,
                "prefix": "",
                "suffix": "",
            },
        }
        blocks.append(
            IndexableBlock(
                media_id=media_id,
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
                metadata={"speaker_label": segment.get("speaker_label")},
            )
        )
        source_offset += len(text_value)

    joined_text = "\n\n".join(joined_text_parts)
    return rebuild_media_content_index(
        db,
        media_id=media_id,
        source_kind="transcript",
        source_snapshot=SourceSnapshotSpec(
            artifact_kind="transcript_json",
            artifact_ref=f"podcast_transcript_versions:{transcript_version_id}",
            content_type="application/json",
            byte_length=len(json.dumps(transcript_segments).encode("utf-8")),
            content_sha256=_sha256(joined_text),
            source_version="podcast_transcript_segments_v1",
            extractor_version="podcast_transcript_v1",
            source_fingerprint=f"sha256:{_sha256(joined_text)}",
            parent_snapshot_id=None,
            language=None,
            metadata={"transcript_version_id": str(transcript_version_id)},
        ),
        blocks=blocks,
        reason=reason,
    )


def repair_ready_media_content_index_now(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
) -> ContentIndexResult | None:
    row = db.execute(
        text(
            """
            SELECT m.kind,
                   m.language,
                   m.plain_text,
                   m.page_count,
                   m.file_sha256,
                   mf.storage_path
            FROM media m
            LEFT JOIN media_file mf ON mf.media_id = m.id
            WHERE m.id = :media_id
              AND m.processing_status IN ('ready_for_reading', 'embedding', 'ready')
              AND m.kind IN ('web_article', 'epub', 'pdf', 'podcast_episode')
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        return None

    source_kind = str(row[0])
    if source_kind in {"web_article", "epub"}:
        fragments = db.execute(
            text(
                """
                SELECT id, idx, canonical_text
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY idx ASC
                """
            ),
            {"media_id": media_id},
        ).fetchall()
        artifact_ref = f"legacy_fragments:{media_id}"
        if source_kind == "epub" and row[5]:
            artifact_ref = str(row[5])
        return rebuild_fragment_content_index(
            db,
            media_id=media_id,
            source_kind=source_kind,
            artifact_ref=artifact_ref,
            fragments=list(fragments),
            reason=reason,
            language=row[1],
        )

    if source_kind == "podcast_episode":
        return _repair_ready_transcript_content_index(db, media_id=media_id, reason=reason)

    return _repair_ready_pdf_content_index(
        db,
        media_id=media_id,
        plain_text=str(row[2] or ""),
        page_count=int(row[3] or 0),
        file_sha256=str(row[4]) if row[4] else None,
        storage_path=str(row[5]) if row[5] else None,
        reason=reason,
    )


def _repair_ready_transcript_content_index(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
) -> ContentIndexResult | None:
    version_id = db.execute(
        text(
            """
            SELECT mts.active_transcript_version_id
            FROM media_transcript_states mts
            JOIN podcast_transcript_versions ptv
              ON ptv.id = mts.active_transcript_version_id
             AND ptv.media_id = mts.media_id
            WHERE mts.media_id = :media_id
              AND mts.active_transcript_version_id IS NOT NULL
              AND mts.transcript_state IN ('ready', 'partial')
              AND mts.transcript_coverage IN ('partial', 'full')
            ORDER BY ptv.version_no DESC, ptv.created_at DESC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar()
    if version_id is None:
        return None

    rows = db.execute(
        text(
            """
            SELECT canonical_text, t_start_ms, t_end_ms, speaker_label
            FROM podcast_transcript_segments
            WHERE media_id = :media_id
              AND transcript_version_id = :version_id
            ORDER BY segment_idx ASC
            """
        ),
        {"media_id": media_id, "version_id": version_id},
    ).fetchall()
    segments = [
        {
            "text": str(row[0] or ""),
            "t_start_ms": row[1],
            "t_end_ms": row[2],
            "speaker_label": row[3],
        }
        for row in rows
    ]
    return rebuild_transcript_content_index(
        db,
        media_id=media_id,
        transcript_version_id=version_id,
        transcript_segments=segments,
        reason=reason,
    )


def _repair_ready_pdf_content_index(
    db: Session,
    *,
    media_id: UUID,
    plain_text: str,
    page_count: int,
    file_sha256: str | None,
    storage_path: str | None,
    reason: str,
) -> ContentIndexResult:
    source_fingerprint = f"sha256:{file_sha256}" if file_sha256 else f"media:{media_id}"
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

    blocks: list[IndexableBlock] = []
    for (
        page_number,
        start_offset,
        end_offset,
        page_label,
        page_width,
        page_height,
        page_rotation_degrees,
    ) in page_rows:
        start = max(0, int(start_offset))
        end = max(start, int(end_offset))
        page_text = plain_text[start:end]
        locator = {
            "kind": "pdf_text",
            "version": 1,
            "source_fingerprint": source_fingerprint,
            "page_number": int(page_number),
            "physical_page_number": int(page_number),
            "page_label": str(page_label) if page_label else None,
            "plain_text_start_offset": start,
            "plain_text_end_offset": end,
            "page_text_start_offset": 0,
            "page_text_end_offset": len(page_text),
            "text_quote": _text_quote(plain_text, start, end),
        }
        if page_width and page_height:
            locator["geometry"] = {
                "version": 1,
                "coordinate_space": "pdf_points",
                "page_width": float(page_width),
                "page_height": float(page_height),
                "page_rotation_degrees": int(page_rotation_degrees or 0),
                "page_box": "crop",
                "quads": [],
            }
        selector = {
            "kind": "pdf_text_quote",
            "version": 1,
            "source_fingerprint": source_fingerprint,
            "page_number": int(page_number),
            "physical_page_number": int(page_number),
            "page_label": str(page_label) if page_label else None,
            "plain_text_start_offset": start,
            "plain_text_end_offset": end,
            "page_text_start_offset": 0,
            "page_text_end_offset": len(page_text),
            "text_quote": _text_quote(plain_text, start, end),
        }
        blocks.append(
            IndexableBlock(
                media_id=media_id,
                source_kind="pdf",
                block_idx=len(blocks),
                block_kind="pdf_text_block",
                canonical_text=page_text,
                extraction_confidence=None,
                source_start_offset=start,
                source_end_offset=end,
                locator=locator,
                selector=selector,
                heading_path=(f"p. {page_label or int(page_number)}",),
                metadata={
                    "source_fingerprint": source_fingerprint,
                    "page_number": int(page_number),
                    "page_label": str(page_label) if page_label else None,
                    "legacy_repair": True,
                },
            )
        )

    text_bytes = plain_text.encode("utf-8")
    return rebuild_media_content_index(
        db,
        media_id=media_id,
        source_kind="pdf",
        source_snapshot=SourceSnapshotSpec(
            artifact_kind="pdf_text",
            artifact_ref=f"legacy_media_plain_text:{media_id}",
            content_type="text/plain",
            byte_length=len(text_bytes),
            content_sha256=_sha256(plain_text),
            source_version="pdf_text_legacy_mutable_repair_v1",
            extractor_version="pdf_text_legacy_mutable_repair_v1",
            source_fingerprint=source_fingerprint,
            parent_snapshot_id=None,
            language=None,
            metadata={
                "page_count": page_count,
                "source_fingerprint": source_fingerprint,
                "has_text": bool(plain_text.strip()),
                "legacy_repair": True,
                "legacy_mutable_snapshot_repair": True,
                "mutable_source_tables": ["media.plain_text", "pdf_page_text_spans"],
                "original_pdf_storage_path": storage_path,
            },
        ),
        blocks=blocks,
        reason=reason,
    )


def mark_content_index_failed(
    db: Session,
    *,
    media_id: UUID,
    failure_code: str,
    failure_message: str,
) -> None:
    now = datetime.now(UTC)
    active_run_id = db.execute(
        text(
            """
            SELECT mcis.active_run_id
            FROM media_content_index_states mcis
            JOIN content_index_runs active_run
              ON active_run.id = mcis.active_run_id
             AND active_run.state = 'ready'
             AND active_run.deactivated_at IS NULL
            WHERE mcis.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).scalar()
    latest_failed_run_id = db.execute(
        text(
            """
            SELECT id
            FROM content_index_runs
            WHERE media_id = :media_id
              AND (finished_at IS NULL OR state = 'failed')
            ORDER BY
                CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END,
                created_at DESC,
                id DESC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar()
    db.execute(
        text(
            """
            UPDATE content_index_runs
            SET state = 'failed',
                finished_at = :now,
                failure_code = :failure_code,
                failure_message = :failure_message
            WHERE media_id = :media_id
              AND finished_at IS NULL
            """
        ),
        {
            "media_id": media_id,
            "failure_code": failure_code,
            "failure_message": failure_message,
            "now": now,
        },
    )
    _set_index_state(
        db,
        media_id=media_id,
        latest_run_id=latest_failed_run_id,
        active_run_id=active_run_id,
        status="ready" if active_run_id is not None else "failed",
        status_reason=failure_message,
        embedding_provider=None,
        embedding_model=None,
        embedding_version=None,
        embedding_config_hash=None,
        clear_active_embedding=active_run_id is None,
        now=now,
    )


def deactivate_media_content_index(db: Session, *, media_id: UUID, reason: str) -> None:
    now = datetime.now(UTC)
    active_run_id = db.execute(
        text("SELECT active_run_id FROM media_content_index_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar()
    if active_run_id is not None:
        db.execute(
            text(
                """
                UPDATE content_index_runs
                SET deactivated_at = :now
                WHERE id = :active_run_id
                  AND deactivated_at IS NULL
                """
            ),
            {"active_run_id": active_run_id, "now": now},
        )
    _set_index_state(
        db,
        media_id=media_id,
        latest_run_id=None,
        active_run_id=None,
        status="pending",
        status_reason=reason,
        embedding_provider=None,
        embedding_model=None,
        embedding_version=None,
        embedding_config_hash=None,
        clear_active_embedding=True,
        now=now,
    )


def delete_media_content_index(db: Session, *, media_id: UUID) -> None:
    db.execute(
        text(
            """
            UPDATE assistant_message_claim_evidence ace
            SET evidence_span_id = NULL
            FROM evidence_spans es
            WHERE ace.evidence_span_id = es.id
              AND es.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            UPDATE message_retrievals mr
            SET evidence_span_id = NULL
            FROM evidence_spans es
            WHERE mr.evidence_span_id = es.id
              AND es.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_content_index_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM message_context_items
            WHERE object_type = 'content_chunk'
              AND object_id IN (
                    SELECT id
                    FROM content_chunks
                    WHERE media_id = :media_id
              )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM object_links
            WHERE (a_type = 'content_chunk' AND a_id IN (
                    SELECT id
                    FROM content_chunks
                    WHERE media_id = :media_id
                  ))
               OR (b_type = 'content_chunk' AND b_id IN (
                    SELECT id
                    FROM content_chunks
                    WHERE media_id = :media_id
                  ))
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM content_embeddings ce
            USING content_chunks cc
            WHERE ce.chunk_id = cc.id
              AND cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM content_chunk_parts ccp
            USING content_chunks cc
            WHERE ccp.chunk_id = cc.id
              AND cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM content_chunks WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM evidence_spans WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM content_blocks WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM source_snapshots WHERE media_id = :media_id"), {"media_id": media_id}
    )
    db.execute(
        text("DELETE FROM content_index_runs WHERE media_id = :media_id"), {"media_id": media_id}
    )


def _set_index_state(
    db: Session,
    *,
    media_id: UUID,
    latest_run_id: UUID | None,
    active_run_id: UUID | None,
    status: str,
    status_reason: str | None,
    embedding_provider: str | None,
    embedding_model: str | None,
    embedding_version: str | None,
    embedding_config_hash: str | None,
    now: datetime,
    clear_active_embedding: bool = False,
) -> None:
    if active_run_id is None or clear_active_embedding:
        embedding_provider = None
        embedding_model = None
        embedding_version = None
        embedding_config_hash = None
    preserve_active_embedding = (
        active_run_id is not None
        and not clear_active_embedding
        and embedding_provider is None
        and embedding_model is None
        and embedding_version is None
        and embedding_config_hash is None
    )
    exists = db.execute(
        text("SELECT 1 FROM media_content_index_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar()
    if exists:
        db.execute(
            text(
                """
                UPDATE media_content_index_states
                SET active_run_id = :active_run_id,
                    latest_run_id = COALESCE(:latest_run_id, latest_run_id),
                    status = :status,
                    status_reason = :status_reason,
                    active_embedding_provider = CASE
                        WHEN :preserve_active_embedding THEN active_embedding_provider
                        ELSE :embedding_provider
                    END,
                    active_embedding_model = CASE
                        WHEN :preserve_active_embedding THEN active_embedding_model
                        ELSE :embedding_model
                    END,
                    active_embedding_version = CASE
                        WHEN :preserve_active_embedding THEN active_embedding_version
                        ELSE :embedding_version
                    END,
                    active_embedding_config_hash = CASE
                        WHEN :preserve_active_embedding THEN active_embedding_config_hash
                        ELSE :embedding_config_hash
                    END,
                    updated_at = :now
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "active_run_id": active_run_id,
                "latest_run_id": latest_run_id,
                "status": status,
                "status_reason": status_reason,
                "embedding_provider": embedding_provider,
                "embedding_model": embedding_model,
                "embedding_version": embedding_version,
                "embedding_config_hash": embedding_config_hash,
                "preserve_active_embedding": preserve_active_embedding,
                "now": now,
            },
        )
        return

    db.execute(
        text(
            """
            INSERT INTO media_content_index_states (
                media_id,
                active_run_id,
                latest_run_id,
                status,
                status_reason,
                active_embedding_provider,
                active_embedding_model,
                active_embedding_version,
                active_embedding_config_hash,
                updated_at,
                created_at
            )
            VALUES (
                :media_id,
                :active_run_id,
                :latest_run_id,
                :status,
                :status_reason,
                :embedding_provider,
                :embedding_model,
                :embedding_version,
                :embedding_config_hash,
                :now,
                :now
            )
            """
        ),
        {
            "media_id": media_id,
            "active_run_id": active_run_id,
            "latest_run_id": latest_run_id,
            "status": status,
            "status_reason": status_reason,
            "embedding_provider": embedding_provider,
            "embedding_model": embedding_model,
            "embedding_version": embedding_version,
            "embedding_config_hash": embedding_config_hash,
            "now": now,
        },
    )


def _validate_source_snapshot(source_snapshot: SourceSnapshotSpec) -> None:
    if not source_snapshot.artifact_kind.strip():
        raise ValueError("SourceSnapshotSpec artifact_kind is required")
    if not source_snapshot.artifact_ref.strip():
        raise ValueError("SourceSnapshotSpec artifact_ref is required")
    if not source_snapshot.content_type.strip():
        raise ValueError("SourceSnapshotSpec content_type is required")
    if source_snapshot.byte_length < 0:
        raise ValueError("SourceSnapshotSpec byte_length is invalid")
    if not source_snapshot.source_fingerprint.strip():
        raise ValueError("SourceSnapshotSpec source_fingerprint is required")
    if not re.fullmatch(r"[0-9a-f]{64}", source_snapshot.content_sha256):
        raise ValueError("SourceSnapshotSpec content_sha256 is invalid")
    if not source_snapshot.source_version.strip():
        raise ValueError("SourceSnapshotSpec source_version is required")
    if not source_snapshot.extractor_version.strip():
        raise ValueError("SourceSnapshotSpec extractor_version is required")
    if not isinstance(source_snapshot.metadata, dict):
        raise ValueError("SourceSnapshotSpec metadata must be an object")


def _validate_blocks(
    *,
    media_id: UUID,
    source_kind: str,
    blocks: list[IndexableBlock],
) -> None:
    if source_kind not in {"web_article", "epub", "pdf", "transcript"}:
        raise ValueError(f"Unsupported source_kind: {source_kind}")

    previous_source_end: int | None = None
    for expected_idx, block in enumerate(blocks):
        if block.media_id != media_id:
            raise ValueError("IndexableBlock media_id does not match target media")
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
    version = selector.get("version")
    if not _is_int(version) or int(version) < 1:
        raise ValueError(f"{context} version is invalid")

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
    raise ValueError(f"Unsupported source_kind: {source_kind}")


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
    source_fingerprint = selector.get("source_fingerprint")
    if not isinstance(source_fingerprint, str) or not source_fingerprint.strip():
        raise ValueError(f"{context} source_fingerprint is required")
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
    version = value.get("version")
    if not _is_int(version) or version < 1:
        raise ValueError(f"{context} geometry version is invalid")
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
    raw_version_id = selector.get("transcript_version_id")
    if not isinstance(raw_version_id, str):
        raise ValueError(f"{context} transcript_version_id is required")
    try:
        UUID(raw_version_id)
    except ValueError:
        raise ValueError(f"{context} transcript_version_id is invalid") from None
    t_start_ms = selector.get("t_start_ms")
    t_end_ms = selector.get("t_end_ms")
    if not _is_int(t_start_ms) or not _is_int(t_end_ms):
        raise ValueError(f"{context} transcript times must be integers")
    if t_start_ms < 0 or t_end_ms <= t_start_ms:
        raise ValueError(f"{context} transcript times are invalid")


def _is_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _is_positive_number(value: object) -> TypeGuard[int | float]:
    return _is_number(value) and float(value) > 0


def _block_pieces(text_value: str) -> list[tuple[int, int, int]]:
    words = list(re.finditer(r"\S+", text_value))
    if not words:
        return [(0, len(text_value), 0)]
    if len(words) <= CHUNK_MAX_TOKENS:
        return [(0, len(text_value), len(words))]

    pieces = []
    step = CHUNK_MAX_TOKENS - CHUNK_OVERLAP_TOKENS
    word_idx = 0
    while word_idx < len(words):
        end_word_idx = min(word_idx + CHUNK_MAX_TOKENS, len(words))
        pieces.append(
            (words[word_idx].start(), words[end_word_idx - 1].end(), end_word_idx - word_idx)
        )
        if end_word_idx == len(words):
            break
        word_idx += step
    return pieces


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
        return (
            left.locator.get("transcript_version_id") == right.locator.get("transcript_version_id")
            and left.locator.get("t_start_ms") == right.locator.get("t_start_ms")
            and left.locator.get("t_end_ms") == right.locator.get("t_end_ms")
        )
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
    elif locator.get("kind") == "transcript_time_text":
        locator["t_start_ms"] = first_block.locator.get("t_start_ms")
        locator["t_end_ms"] = last_block.locator.get("t_end_ms")
    else:
        raise ValueError(f"Unsupported locator kind: {locator.get('kind')}")

    return locator


def _text_quote(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - 64) : start_offset],
        "suffix": text_value[end_offset : min(len(text_value), end_offset + 64)],
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _resolver_kind(source_kind: str) -> str:
    if source_kind == "web_article":
        return "web"
    if source_kind == "epub":
        return "epub"
    if source_kind == "pdf":
        return "pdf"
    if source_kind == "transcript":
        return "transcript"
    raise ValueError(f"Unsupported source_kind: {source_kind}")
